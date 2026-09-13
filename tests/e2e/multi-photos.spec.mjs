import { test, expect } from '@playwright/test';
import { createScriptBackend } from '../backend-harness.mjs';
import { MOCK_EXEC } from '../mock-backend.mjs';
import { b64url, chooseEntryPhoto, openCustomer, TINY_PNG, CAMERA_TEST_OPTIONS, queueLen } from './helpers.mjs';

test.use(CAMERA_TEST_OPTIONS);
const photoFiles = (count) => Array.from({ length: count }, (_, i) => ({
  name: 'bill-' + i + '.png', mimeType: 'image/png', buffer: TINY_PNG,
}));

async function realScriptLedger(page, options = {}) {
  const b = createScriptBackend();
  b.run('photoFolder()');
  const user = b.api({ action: 'addUser', data: { name: 'Test Customer' } }).data;
  const data = { user_id: user.user_id, amount: 50, type: 'given', comment: 'original bill', date: '2026-09-10' };
  const txn = b.api({ action: 'addTxn', data, cid: 'seed-money' }).data;
  for (let i = 0; i < (options.photos || 0); i++) b.api({
    action: 'uploadTxnPhoto', id: txn.id, attachmentId: 'seed-photo-' + i, b64: TINY_PNG.toString('base64'),
  });
  if (options.pin) b.api({ action: 'setTxnPin', admin: b.run('adminPin_()'), pin: options.pin });
  const control = { failPhotos: false, losePhotoReply: false, down: false, requests: [] };
  await page.route('https://script.google.com/**', async (route) => {
    const req = route.request();
    const params = req.method() === 'POST' ? JSON.parse(req.postData()) :
      Object.fromEntries(new URL(req.url()).searchParams);
    control.requests.push(params.action);
    if (control.down) { await route.abort('failed'); return; }
    if (control.failPhotos && params.action === 'uploadTxnPhoto') b.failNext('beforeCreate', 'Drive storage unavailable');
    const response = b.api(params);
    if (control.losePhotoReply && params.action === 'uploadTxnPhoto' && response.ok) {
      control.losePhotoReply = false; await route.abort('failed'); return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(response) });
  });
  await page.goto('/#s=' + b64url({ u: MOCK_EXEC, k: 'test-key' }));
  await expect(page.locator('#screen-home')).toBeVisible();
  await openCustomer(page, 'Test Customer');
  const transactions = () => b.api({ action: 'list' }).data.transactions;
  return { b, txn, user, control, transactions };
}
async function openOriginal(page) {
  await page.locator('.txn-row', { hasText: 'original bill' }).locator('.txn-text').click();
}
async function typePin(page, pin) {
  for (const digit of pin) await page.locator('#pin-grid [data-k="' + digit + '"]').click();
}

test('camera plus gallery reach five photos; sixth is refused and every image is viewable', async ({ page }) => {
  const { transactions } = await realScriptLedger(page);
  await openOriginal(page);
  await chooseEntryPhoto(page, 'camera');
  await chooseEntryPhoto(page, 'gallery', photoFiles(4));
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(5);
  await expect(page.locator('#txn-photo-add')).toBeDisabled();
  await page.locator('#txn-photo').setInputFiles(photoFiles(1));
  await expect(page.locator('#toast')).toContainText('up to 5 photos');
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(5);
  await page.locator('#txn-save').click();
  await expect.poll(() => transactions()[0].photos.length).toBe(5);
  await expect.poll(() => queueLen(page)).toBe(0);
  await expect(page.locator('#txn-list [data-photo-index]')).toHaveCount(5);
  await page.locator('#txn-list [data-photo-index="4"]').click();
  await expect(page.locator('#photo-counter')).toHaveText('5 / 5');
  await expect(page.locator('#photo-remove')).toBeHidden();
  await page.locator('#photo-prev').click();
  await expect(page.locator('#photo-counter')).toHaveText('4 / 5');
});

test('photo failure does not roll back money, block other entries, or freeze refresh', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.failPhotos = true;
  await openOriginal(page);
  await page.locator('#txn-amount').fill('75');
  await chooseEntryPhoto(page, 'gallery', photoFiles(2));
  await page.locator('#txn-save').click();
  await expect.poll(() => h.transactions()[0].amount).toBe(75);
  await expect(page.locator('#txn-list .photo-error')).toHaveCount(2);
  await page.locator('#btn-got').click();
  await page.locator('#txn-amount').fill('10');
  await page.locator('#txn-save').click();
  await expect.poll(() => h.transactions().length).toBe(2);
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeHidden();
  h.b.api({ action: 'addTxn', cid: 'second-device', data: {
    user_id: h.user.user_id, amount: 15, type: 'received', comment: 'other phone',
  } });
  await page.locator('#btn-refresh').click();
  await openCustomer(page, 'Test Customer');
  await expect(page.locator('.txn-row', { hasText: 'other phone' })).toBeVisible();
  h.control.failPhotos = false;
  await page.locator('#btn-back').click();
  await page.locator('#chip-pending').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(h.transactions().find(t => t.id === h.txn.id).photos).toHaveLength(2);
});

test('lost photo reply survives reload and retry without duplicating a Drive file', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.losePhotoReply = true;
  await openOriginal(page);
  await chooseEntryPhoto(page, 'gallery');
  await page.locator('#txn-save').click();
  await expect(page.locator('#txn-list .photo-error')).toHaveCount(1);
  await page.reload();
  await openCustomer(page, 'Test Customer');
  await expect(page.locator('#txn-list .photo-error')).toHaveCount(1);
  await page.locator('#txn-list [data-retry-photo]').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(h.b.state.uploads).toBe(1);
  expect(h.transactions()[0].photos).toHaveLength(1);
});

test('replacement and removing just one photo use the PIN-protected editor', async ({ page }) => {
  const h = await realScriptLedger(page, { photos: 3, pin: '1234' });
  const initial = h.transactions()[0].photos;
  await page.locator('#txn-list [data-photo-index="1"]').click();
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#photo-replace')).toBeHidden();
  await page.locator('#dlg-photo button[type=submit]').click();
  await openOriginal(page);
  await typePin(page, '1234');
  await page.locator('#txn-photo-list [data-photo-index="1"]').click();
  await page.locator('#photo-replace').click();
  const picker = page.waitForEvent('filechooser');
  await page.locator('#photo-choose').click();
  await (await picker).setFiles(photoFiles(1));
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(3);
  await page.locator('#txn-photo-list [data-photo-index="0"]').click();
  await page.locator('#photo-remove').click();
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(2);
  expect(h.transactions()[0].photos).toEqual(initial); // draft only
  await page.locator('#txn-save').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  const remaining = h.transactions()[0].photos;
  expect(remaining).toHaveLength(2);
  expect(remaining.some(p => p.id === initial[0].id || p.id === initial[1].id)).toBe(false);
  expect(remaining.some(p => p.id === initial[2].id)).toBe(true);
});

test('budget refusal preserves the open draft and does not send a financial save', async ({ page }) => {
  const h = await realScriptLedger(page);
  await openOriginal(page);
  await page.evaluate(() => { compressImage = async () => 'A'.repeat(600000); });
  await chooseEntryPhoto(page, 'gallery', photoFiles(3));
  await page.locator('#txn-amount').fill('99');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await expect(page.locator('#txn-error')).toContainText('offline storage budget');
  expect(h.transactions()[0].amount).toBe(50);
  expect(h.control.requests).not.toContain('updateTxn');
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(3);
});

test('storage write failure preserves previous photo jobs and new draft', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.failPhotos = true;
  await openOriginal(page);
  await chooseEntryPhoto(page, 'gallery');
  await page.locator('#txn-save').click();
  await expect(page.locator('#txn-list .photo-error')).toHaveCount(1);
  const previous = await page.evaluate(() => localStorage.getItem('bahi.queue'));
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('99');
  await chooseEntryPhoto(page, 'gallery');
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'bahi.queue') throw new DOMException('Storage full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await expect(page.locator('#txn-error')).toContainText('Phone storage is full');
  expect(await page.evaluate(() => localStorage.getItem('bahi.queue'))).toBe(previous);
  expect(h.transactions()).toHaveLength(1);
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(1);
});

test('delete and Undo recover all photos using Drive references rather than local caches', async ({ page }) => {
  const h = await realScriptLedger(page, { photos: 3, pin: '1234' });
  const originals = h.transactions()[0].photos;
  await openOriginal(page);
  await typePin(page, '1234');
  await page.locator('#txn-delete').click();
  await expect.poll(() => h.transactions().length).toBe(0);
  await page.locator('.toast-act').click();
  await expect.poll(() => h.transactions()[0]?.photos.length).toBe(3);
  expect(h.transactions()[0].photos.map(p => p.fileId)).toEqual(originals.map(p => p.fileId));
  expect(h.b.state.uploads).toBe(3);
});

test('ledger is mirrored without a divider and photo scrolling never opens editing', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await realScriptLedger(page, { photos: 5, pin: '1234' });
  const row = page.locator('#txn-list .txn-row').first();
  expect(await row.locator('.txn-cell').first().locator('.txn-text').count()).toBe(1);
  expect(await row.locator('.txn-cell').last().locator('.photo-strip').count()).toBe(1);
  expect(await row.locator('.txn-cell').first().evaluate(el => getComputedStyle(el).borderRightWidth)).toBe('0px');
  const strip = row.locator('.photo-strip');
  expect(await strip.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await strip.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await row.locator('[data-photo-index="4"]').click();
  await expect(page.locator('#photo-counter')).toHaveText('5 / 5');
});

test('another device deleting the entry cancels its pending photos after refresh', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.failPhotos = true;
  await openOriginal(page);
  await chooseEntryPhoto(page, 'gallery');
  await page.locator('#txn-save').click();
  await expect(page.locator('#txn-list .photo-error')).toHaveCount(1);
  h.b.api({ action: 'deleteTxn', id: h.txn.id });
  await page.locator('#btn-back').click();
  await page.locator('#btn-refresh').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(h.transactions()).toHaveLength(0);
});

test('a new offline entry and its photo jobs survive reload and remap to the server id', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.down = true;
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('99');
  await chooseEntryPhoto(page, 'gallery', photoFiles(3));
  await page.locator('#txn-save').click();
  await expect.poll(() => queueLen(page)).toBe(4);
  await page.reload();
  await expect(page.locator('#chip-pending')).toContainText('3 photos pending');
  h.control.down = false;
  await page.locator('#chip-pending').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(h.transactions().filter(t => t.amount === 99)).toHaveLength(1);
  expect(h.transactions().find(t => t.amount === 99).photos).toHaveLength(3);
});

test('pre-existing oversized single-photo queue data is kept and can still sync', async ({ page }) => {
  const h = await realScriptLedger(page);
  h.control.down = true;
  await page.evaluate((userId) => {
    localStorage.setItem('bahi.queue', JSON.stringify([{
      qid: 'legacy-queued', action: 'addTxn', tmpId: 'tmplegacy',
      payload: { cid: 'old-client-write', data: { user_id: userId, amount: 7, type: 'given',
        comment: 'pre-v9 offline photo', date: '2026-09-01', photo: 'A'.repeat(1700000) } },
      undo: { type: 'addTxn', tmpId: 'tmplegacy' },
    }]));
  }, h.user.user_id);
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bahi.queue'))[0].payload.data.photo.length)).toBe(1700000);
  h.control.down = false;
  await page.locator('#chip-pending').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(h.transactions().find(t => t.amount === 7).photo).toBeTruthy();
});

test('phone widths keep ledger strips inside the page and preserve the editor sheet', async ({ page }, testInfo) => {
  const h = await realScriptLedger(page, { photos: 5 });
  const received = h.b.api({ action: 'addTxn', cid: 'received-layout', data: {
    user_id: h.user.user_id, amount: 1250, type: 'received', comment: 'Payment received', date: '2026-09-11',
  } }).data;
  for (let i = 0; i < 5; i++) h.b.api({ action: 'uploadTxnPhoto', id: received.id,
    attachmentId: 'received-photo-' + i, b64: TINY_PNG.toString('base64') });
  await page.locator('#btn-back').click();
  await page.locator('#btn-refresh').click();
  await openCustomer(page, 'Test Customer');
  await expect(page.locator('#txn-list .txn-row')).toHaveCount(2);
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#txn-list .photo-strip')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('ledger-' + width + '.png'), animations: 'disabled' });
  }
  const got = page.locator('.txn-row', { hasText: 'Payment received' });
  await expect(got.locator('.txn-cell').first().locator('.photo-strip')).toBeVisible();
  await expect(got.locator('.txn-cell').last().locator('.txn-text')).toBeVisible();
  await got.locator('.txn-text').click();
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath('editor-390.png'), animations: 'disabled' });
});
