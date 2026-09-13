import { test, expect } from '@playwright/test';
import { createScriptBackend } from '../backend-harness.mjs';
import { MOCK_EXEC } from '../mock-backend.mjs';
import { b64url, openCustomer, queueLen } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function viewer(page, count = 5, index = 0) {
  const images = await page.evaluate(() => ['#246', '#a31', '#184', '#628', '#a60'].map((color, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 240, 300);
    ctx.fillStyle = 'white'; ctx.font = '80px sans-serif'; ctx.fillText(String(i + 1), 90, 175);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  }));
  const b = createScriptBackend();
  b.run('photoFolder()');
  const user = b.api({ action: 'addUser', data: { name: 'Swipe test' } }).data;
  const txn = b.api({ action: 'addTxn', cid: 'swipe-money', data: {
    user_id: user.user_id, type: 'given', amount: 25, comment: 'Swipe bills', date: '2026-09-13',
  } }).data;
  const photos = images.slice(0, count).map((b64, i) => b.api({ action: 'uploadTxnPhoto',
    id: txn.id, attachmentId: 'swipe-' + i, b64 }).data.attachment);
  b.api({ action: 'setTxnPin', admin: b.run('adminPin_()'), pin: '1234' });
  const control = { requests: [], held: null, release: null, holdId: null };
  await page.route('https://script.google.com/**', async route => {
    const req = route.request();
    const params = req.method() === 'POST' ? JSON.parse(req.postData()) : Object.fromEntries(new URL(req.url()).searchParams);
    control.requests.push(params.action);
    if (params.action === 'photo' && params.id === control.holdId) {
      control.held = params.id;
      await new Promise(resolve => { control.release = resolve; });
    }
    const response = b.api(params);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto('/#s=' + b64url({ u: MOCK_EXEC, k: 'test-key' }));
  await openCustomer(page, 'Swipe test');
  await page.locator('#txn-list [data-photo-index="' + index + '"]').click();
  await expect(page.locator('#photo-counter')).toHaveText(`${index + 1} / ${count}`);
  await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + images[index]);
  // Cancellation also settles an entrance animation (e.g. a fresh render).
  await page.locator('#dlg-photo').evaluate(el => Promise.allSettled(el.getAnimations({ subtree: true }).map(a => a.finished)));
  const cdp = await page.context().newCDPSession(page);
  return { b, photos, images, control, cdp };
}

// Browser input pipeline, not DOM dispatchEvent or app navigation functions.
async function stroke(page, cdp, dx, dy = 0, options = {}) {
  const box = await page.locator('#photo-swipe-area').boundingBox();
  const start = { x: box.x + box.width / 2 - dx / 2, y: box.y + box.height / 2 - dy / 2 };
  const point = (x, y, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  const stamp = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start.x, start.y)], timestamp: stamp });
  for (let i = 1; i <= 6; i++) {
    const points = [point(start.x + dx * i / 6, start.y + dy * i / 6)];
    if (options.multi) points.push(point(start.x + 20 + dx * i / 6, start.y + 35 + dy * i / 6, 2));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points, timestamp: stamp + i * 0.025 });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: options.cancel ? 'touchCancel' : 'touchEnd', touchPoints: [], timestamp: stamp + (options.long ? 2 : 0.2),
  });
}

test('touch swipes change the actual photo and counter without PIN, edits or writes', async ({ page }, testInfo) => {
  const h = await viewer(page);
  const before = JSON.stringify(h.b.api({ action: 'list' }).data.transactions);
  for (let i = 1; i < 5; i++) {
    await stroke(page, h.cdp, -150);
    await expect(page.locator('#photo-counter')).toHaveText(`${i + 1} / 5`);
    await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + h.images[i]);
  }
  await stroke(page, h.cdp, 150);
  await expect(page.locator('#photo-counter')).toHaveText('4 / 5');
  await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + h.images[3]);
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  expect(await queueLen(page)).toBe(0);
  expect(h.control.requests.every(action => ['photo', 'list'].includes(action))).toBe(true);
  expect(JSON.stringify(h.b.api({ action: 'list' }).data.transactions)).toBe(before);
  await page.locator('#photo-prev').click();
  await expect(page.locator('#photo-counter')).toHaveText('3 / 5');
  await page.locator('#photo-next').click();
  await expect(page.locator('#photo-counter')).toHaveText('4 / 5');
  await expect(page.locator('#toast')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('swipe-viewer-390.png'), animations: 'disabled' });
});

test('swiping first/last photos never wraps or closes the viewer', async ({ page }) => {
  const { cdp } = await viewer(page);
  await stroke(page, cdp, 150);
  await expect(page.locator('#photo-counter')).toHaveText('1 / 5');
  for (let i = 0; i < 5; i++) await stroke(page, cdp, -150);
  await expect(page.locator('#photo-counter')).toHaveText('5 / 5');
  await expect(page.locator('#dlg-photo')).toBeVisible();
});

test('single-photo viewer leaves native gestures alone and hides navigation hints', async ({ page }) => {
  const { cdp } = await viewer(page, 1);
  await stroke(page, cdp, -150);
  await stroke(page, cdp, 150);
  await expect(page.locator('#photo-counter')).toHaveText('1 / 1');
  await expect(page.locator('#photo-next')).toBeHidden();
  await expect(page.locator('#photo-swipe-hint')).toBeHidden();
  await expect(page.locator('#dlg-photo')).toBeVisible();
});

test('short, vertical, diagonal, long and cancelled gestures do not navigate', async ({ page }) => {
  const { cdp } = await viewer(page, 5, 2);
  for (const [dx, dy, options] of [[-15, 0, {}], [0, -100, {}], [-75, -100, {}], [-150, 0, { long: true }], [-150, 0, { cancel: true }]]) {
    await stroke(page, cdp, dx, dy, options);
    await expect(page.locator('#photo-counter')).toHaveText('3 / 5');
  }
  await stroke(page, cdp, -150);
  await expect(page.locator('#photo-counter')).toHaveText('4 / 5');
});

test('multiple fingers and browser zoom do not turn panning into photo navigation', async ({ page }) => {
  const { cdp } = await viewer(page, 5, 2);
  await stroke(page, cdp, -100, 0, { multi: true });
  await expect(page.locator('#photo-counter')).toHaveText('3 / 5');
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect(page.locator('#photo-swipe-area')).not.toHaveClass(/swipe-enabled/);
  await stroke(page, cdp, -100);
  await expect(page.locator('#photo-counter')).toHaveText('3 / 5');
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await expect(page.locator('#photo-swipe-area')).toHaveClass(/swipe-enabled/);
  await stroke(page, cdp, -150);
  await expect(page.locator('#photo-counter')).toHaveText('4 / 5');
});

test('rapid swipes cannot let a delayed earlier image overwrite the current photo', async ({ page }) => {
  const h = await viewer(page);
  h.control.holdId = h.photos[3].fileId;
  for (let i = 0; i < 3; i++) await stroke(page, h.cdp, -150);
  await expect.poll(() => h.control.held).toBe(h.photos[3].fileId);
  await stroke(page, h.cdp, -150);
  await expect(page.locator('#photo-counter')).toHaveText('5 / 5');
  await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + h.images[4]);
  const replied = page.waitForResponse(r => r.request().postDataJSON()?.id === h.photos[3].fileId);
  h.control.release();
  await replied;
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#photo-counter')).toHaveText('5 / 5');
  await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + h.images[4]);
});

test('vertical finger movement still scrolls a short-screen viewer', async ({ page }, testInfo) => {
  const { cdp } = await viewer(page);
  await page.setViewportSize({ width: 390, height: 360 });
  const dialog = page.locator('#dlg-photo form');
  await expect.poll(() => dialog.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // The connection toast is in the top layer and covers the image centre on
  // very short screens. Wait for it instead of accidentally swiping the toast.
  await expect(page.locator('#toast')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('before-scroll.png'), animations: 'disabled' });
  const box = await page.locator('#photo-swipe-area').boundingBox();
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#photo-swipe-area'),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 + 40 })).toBe(true);
  await stroke(page, cdp, 0, -80);
  await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('#photo-counter')).toHaveText('1 / 5');
});

test('swipe in the PIN-protected editor selects the correct draft photo and cancellation preserves all files', async ({ page }) => {
  const h = await viewer(page);
  await page.locator('#dlg-photo button[type=submit]').click();
  await page.locator('#txn-list .txn-text').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  for (const digit of '1234') await page.locator('#pin-grid [data-k="' + digit + '"]').click();
  await page.locator('#txn-photo-list [data-photo-index="0"]').click();
  await page.locator('#dlg-photo').evaluate(el => Promise.allSettled(el.getAnimations({ subtree: true }).map(a => a.finished)));
  await stroke(page, h.cdp, -150);
  await expect(page.locator('#photo-counter')).toHaveText('2 / 5');
  await expect(page.locator('#photo-img')).toHaveAttribute('src', 'data:image/jpeg;base64,' + h.images[1]);
  await page.locator('#photo-remove').click();
  await expect(page.locator('#txn-photo-list .photo-tile')).toHaveCount(4);
  await page.locator('#dlg-txn [data-close]').click();
  expect(h.b.api({ action: 'list' }).data.transactions[0].photos).toEqual(h.photos);
  expect(await queueLen(page)).toBe(0);
});

test('closing mid-gesture does not navigate a newly opened photo viewer', async ({ page }) => {
  const { cdp } = await viewer(page);
  const box = await page.locator('#photo-swipe-area').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: box.x + 200, y: box.y + 100 }] });
  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg-photo')).toBeHidden();
  await page.locator('#txn-list [data-photo-index="2"]').click();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: box.x + 50, y: box.y + 100 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#photo-counter')).toHaveText('3 / 5');
});
