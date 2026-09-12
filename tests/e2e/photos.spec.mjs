import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, pinHash } from '../mock-backend.mjs';
import { openLedger, openCustomer, TINY_PNG, chooseEntryPhoto, queueLen, CAMERA_TEST_OPTIONS, openEntryCamera } from './helpers.mjs';

test.use(CAMERA_TEST_OPTIONS);

for (const source of ['gallery', 'camera']) {
test(`${source} photo attaches, uploads, thumbnails in the ledger, and opens in the viewer`, async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await chooseEntryPhoto(page, source);
  // the captured image itself is the confirmation now
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  await expect(page.locator('#txn-photo-prev')).toHaveAttribute('src', /^data:image\/jpeg/);
  await expect(page.locator('#txn-photo-label')).toHaveText('Badlein');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  // photo reached the mock Drive and the entry references it
  await expect.poll(() =>
    backend.state.transactions.find((t) => t.amount === 42)?.photo || ''
  ).toMatch(/^ph/);

  // ledger grows a thumbnail (built from the bytes we just uploaded), tap → viewer
  const thumb = page.locator('img.txn-thumb').first();
  await expect(thumb).toBeVisible({ timeout: 10_000 });
  await thumb.click();
  await expect(page.locator('#dlg-photo')).toBeVisible();
  await expect(page.locator('#photo-img')).toHaveAttribute('src', /^data:image/);
});
}

function withPhoto(pin) {
  const seed = seedLedger();
  seed.transactions[0].photo = 'ph1';
  return createBackend({
    ...seed, photos: { ph1: TINY_PNG.toString('base64') },
    ...(pin ? { pin: { salt: 'photo-test-salt', hash: pinHash('photo-test-salt', pin) } } : {}),
  });
}

test('cancelling the chooser, camera or gallery preserves the draft and its photo', async ({ page }) => {
  const backend = withPhoto();
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await page.locator('#txn-amount').fill('123');
  await page.locator('#txn-comment').fill('keep this note');
  await page.locator('#txn-date').fill('2026-08-09');

  await page.locator('#txn-photo-add').click();
  await expect(page.locator('#photo-source-title')).toHaveText('Change photo');
  await page.locator('#dlg-photo-source [data-close]').click();
  await openEntryCamera(page);
  await page.locator('#camera-cancel').click();
  await chooseEntryPhoto(page, 'gallery', []); // empty file selection
  await expect(page.locator('#txn-amount')).toHaveValue('123');
  await expect(page.locator('#txn-comment')).toHaveValue('keep this note');
  await expect(page.locator('#txn-date')).toHaveValue('2026-08-09');
  await expect(page.locator('#txn-photo-label')).toHaveText('Change');
  expect(backend.state.log).not.toContain('updateTxn');
  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions[0].amount).toBe(123);
  expect(backend.state.transactions[0].photo).toBe('ph1');
});

test('an unreadable image keeps the previous photo and a replacement can be selected again', async ({ page }) => {
  const backend = withPhoto();
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await chooseEntryPhoto(page, 'gallery', {
    name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image'),
  });
  await expect(page.locator('#toast')).toContainText('Could not read that image');
  await expect(page.locator('#txn-photo-label')).toHaveText('Change');
  await expect(page.locator('#txn-save')).toBeEnabled();
  await expect(page.locator('#txn-amount')).toHaveValue('500');
  await expect(page.locator('#txn-comment')).toHaveValue('atta');

  for (let attempt = 0; attempt < 2; attempt++) {
    await chooseEntryPhoto(page, 'gallery');
    await expect(page.locator('#txn-photo-prev')).toBeVisible();
    await expect(page.locator('#txn-save')).toBeEnabled();
  }
  // A choice changes the draft only. Abandoning it leaves the original intact.
  await page.locator('#dlg-txn [data-close]').click();
  expect(backend.state.transactions[0].photo).toBe('ph1');
  expect(backend.state.log).not.toContain('updateTxn');
});

async function delayPhotoDecode(page) {
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      await new Promise((resolve) => { window.resumePhotoDecode = resolve; });
      return decode(...args);
    };
  });
}

test('saving waits for photo processing, including keyboard form submission', async ({ page }) => {
  await delayPhotoDecode(page);
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await chooseEntryPhoto(page, 'camera');
  await expect(page.locator('#txn-save')).toBeDisabled();
  await expect(page.locator('#txn-photo-add')).toBeDisabled();
  await expect(page.locator('#txn-photo-label')).toContainText('Photo ban rahi hai');
  await page.locator('#form-txn').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#dlg-txn')).toBeVisible();
  expect(backend.state.log).not.toContain('addTxn');
  await page.evaluate(() => window.resumePhotoDecode());
  await expect(page.locator('#txn-save')).toBeEnabled();
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions.find((t) => t.amount === 42)?.photo || '').toMatch(/^ph/);
});

test('a photo finishing after its form is closed cannot attach to another customer', async ({ page }) => {
  await delayPhotoDecode(page);
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await chooseEntryPhoto(page, 'camera');
  await expect(page.locator('#txn-save')).toBeDisabled();
  await page.locator('#dlg-txn [data-close]').click();
  await page.locator('#btn-back').click();
  await openCustomer(page, 'Sunita Tailor');
  await page.locator('#btn-got').click();
  await page.locator('#txn-amount').fill('65');
  await page.evaluate(() => window.resumePhotoDecode());
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#txn-photo-prev')).toBeHidden();
  await expect(page.locator('#txn-photo-label')).toHaveText('Add photo');
  await expect(page.locator('#txn-save')).toBeEnabled();
  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions.find((t) => t.amount === 65)?.user_name).toBe('u2');
  expect(backend.state.transactions.find((t) => t.amount === 65).photo).toBe('');
  expect(backend.state.transactions.some((t) => t.amount === 42)).toBe(false);
});

test('camera replacement stays behind the edit PIN and uploads only when saved', async ({ page }) => {
  const backend = withPhoto('1234');
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#txn-photo-add')).toBeHidden();
  for (const digit of '1234') await page.locator(`#pin-grid [data-k="${digit}"]`).click();
  await chooseEntryPhoto(page, 'camera');
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  expect(backend.state.transactions[0].photo).toBe('ph1');
  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions[0].photo).not.toBe('ph1');
  expect(backend.state.transactions[0].amount).toBe(500);
  expect(backend.state.transactions[0].comment).toBe('atta');
  expect(backend.state.photos[backend.state.transactions[0].photo]).toBeTruthy();
});

test('an offline camera entry survives reload and syncs with one photo', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  backend.setMode('down');
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await chooseEntryPhoto(page, 'camera');
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  await page.locator('#txn-save').click();
  await expect.poll(() => queueLen(page)).toBe(1);
  await page.reload();
  await expect(page.locator('#chip-pending')).toContainText('1');
  backend.setMode('ok');
  await page.locator('#chip-pending').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(backend.state.transactions.filter((t) => t.amount === 42)).toHaveLength(1);
  expect(Object.keys(backend.state.photos)).toHaveLength(1);
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('img.txn-thumb')).toBeVisible();
});

test('the camera path also saves and opens photos in the phone preview demo', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btn-demo').click();
  await page.locator('.customer-row').first().click();
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await chooseEntryPhoto(page, 'camera');
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  await page.locator('#txn-save').click();
  await page.locator('img.txn-thumb').first().click();
  await expect(page.locator('#photo-img')).toHaveAttribute('src', /^data:image/);
});

test('a viewed photo persists on-device and reopens offline after a reload', async ({ page }) => {
  const backend = createBackend(seedLedger());
  backend.state.transactions.push({
    id: 'tp1', user_name: 'u1', date: '2026-08-06',
    type: 'received', amount: 77, comment: 'photo wala', photo: 'ph1',
  });
  backend.state.photos.ph1 = TINY_PNG.toString('base64');
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  // first view fetches from the backend, then persists to IndexedDB
  const thumb = page.locator('img.txn-thumb');
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.locator('#dlg-photo')).toBeVisible();
  await expect(page.locator('#photo-img')).not.toHaveClass(/photo-loading/);
  await page.locator('#dlg-photo button[type="submit"]').click();

  // wait for the IndexedDB write to be durable before tearing the page down
  await expect.poll(() => page.evaluate((pid) => new Promise((resolve) => {
    const r = indexedDB.open('bahi-photos', 1);
    r.onsuccess = () => {
      const q = r.result.transaction('photos').objectStore('photos').get(pid);
      q.onsuccess = () => resolve(!!q.result);
      q.onerror = () => resolve(false);
    };
    r.onerror = () => resolve(false);
  }), 'ph1')).toBe(true);

  // dead network + fresh page = no memory cache, no backend — IndexedDB serves it
  backend.setMode('down');
  await page.reload();
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('img.txn-thumb').click();
  await expect(page.locator('#dlg-photo')).toBeVisible();
  await expect(page.locator('#photo-img')).not.toHaveClass(/photo-loading/);
  await expect(page.locator('#photo-img')).toHaveAttribute('src', /^data:image/);
});
