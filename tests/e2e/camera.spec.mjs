import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { CAMERA_TEST_OPTIONS, trackCamera, openLedger, openCustomer, openEntryCamera, TINY_PNG } from './helpers.mjs';

test.use(CAMERA_TEST_OPTIONS);
test.beforeEach(async ({ page }) => trackCamera(page));

async function openDraft(page) {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await page.locator('#txn-comment').fill('camera test bill');
  return backend;
}

const liveTracks = (page) => page.evaluate(() => window.cameraStreams
  .flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').length);

test('live capture, retake and use photo work without opening a file picker', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const backend = await openDraft(page);
  let filePickers = 0;
  page.on('filechooser', () => { filePickers++; });
  await openEntryCamera(page);
  await expect(page.locator('#camera-capture')).toBeEnabled();
  await expect.poll(() => liveTracks(page)).toBe(1);
  const request = await page.evaluate(() => window.cameraRequests[0]);
  expect(request.audio).toBe(false);
  expect(request.video.facingMode).toEqual({ ideal: 'environment' });
  await page.screenshot({ path: testInfo.outputPath('camera-live.png') });

  await page.locator('#camera-capture').click();
  await expect(page.locator('#camera-shot')).toBeVisible();
  await expect.poll(() => liveTracks(page)).toBe(0); // camera stops while reviewing
  await expect(page.locator('#camera-retake')).toBeVisible();
  expect(backend.state.log).not.toContain('addTxn');
  await page.screenshot({ path: testInfo.outputPath('camera-review.png') });

  await page.locator('#camera-retake').click();
  await expect(page.locator('#camera-capture')).toBeEnabled();
  await expect(page.locator('#camera-shot')).toBeHidden();
  await expect.poll(() => liveTracks(page)).toBe(1);
  await page.locator('#camera-capture').click();
  await page.locator('#camera-use').click();
  await expect(page.locator('#dlg-camera')).toBeHidden();
  await expect(page.locator('#txn-photo-prev')).toBeVisible();
  await expect(page.locator('#txn-amount')).toHaveValue('42');
  await expect(page.locator('#txn-comment')).toHaveValue('camera test bill');
  await expect.poll(() => liveTracks(page)).toBe(0);
  expect(filePickers).toBe(0);
  expect(backend.state.log).not.toContain('addTxn');
  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions.find((t) => t.amount === 42)?.photo || '').toMatch(/^ph/);
});

test('cancelling a permission request releases a stream granted after cancellation', async ({ page }) => {
  const backend = await openDraft(page);
  await page.evaluate(() => { window.cameraPermissionPending = true; });
  await openEntryCamera(page);
  await expect(page.locator('#camera-capture')).toBeDisabled();
  await page.locator('#camera-cancel').click();
  await expect(page.locator('#dlg-camera')).toBeHidden();
  await page.evaluate(() => window.grantPendingCamera());
  await expect.poll(() => page.evaluate(() => window.cameraStreams.length)).toBe(1);
  await expect.poll(() => liveTracks(page)).toBe(0);
  await expect(page.locator('#txn-photo-prev')).toBeHidden();
  await expect(page.locator('#txn-amount')).toHaveValue('42');
  expect(backend.state.log).not.toContain('addTxn');
});

test('a late permission result cannot replace or stop a newer camera session', async ({ page }) => {
  await openDraft(page);
  await page.evaluate(() => { window.cameraPermissionPending = true; });
  await openEntryCamera(page);
  await page.locator('#camera-cancel').click();
  await page.evaluate(() => { window.cameraPermissionPending = false; });
  await openEntryCamera(page);
  await expect(page.locator('#camera-capture')).toBeEnabled();
  await page.evaluate(() => window.grantPendingCamera());
  await expect.poll(() => page.evaluate(() => window.cameraStreams.length)).toBe(2);
  await expect.poll(() => liveTracks(page)).toBe(1);
  expect(await page.locator('#camera-video').evaluate((video) => video.srcObject === window.cameraStreams[0])).toBe(true);
  await page.locator('#camera-cancel').click();
  await expect.poll(() => liveTracks(page)).toBe(0);
});

for (const exit of ['cancel', 'escape', 'background', 'pagehide', 'back']) {
  test(`${exit} stops live camera access and leaves no captured draft`, async ({ page }) => {
    const backend = await openDraft(page);
    await openEntryCamera(page);
    await expect(page.locator('#camera-capture')).toBeEnabled();
    if (exit === 'cancel') await page.locator('#camera-cancel').click();
    if (exit === 'escape') await page.keyboard.press('Escape');
    if (exit === 'background') {
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    if (exit === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    if (exit === 'back') await page.goBack();
    await expect(page.locator('#dlg-camera')).toBeHidden();
    await expect.poll(() => liveTracks(page)).toBe(0);
    expect(backend.state.log).not.toContain('addTxn');
  });
}

for (const [error, message] of [
  ['NotAllowedError', 'Camera access is blocked'],
  ['NotFoundError', 'No camera is available'],
  ['NotReadableError', 'Camera could not start'],
]) {
  test(`${error} offers gallery fallback and preserves the entry`, async ({ page }) => {
    await openDraft(page);
    await page.evaluate((name) => { window.cameraFailure = name; }, error);
    await openEntryCamera(page);
    await expect(page.locator('#camera-status')).toContainText(message);
    await expect(page.locator('#camera-capture')).toBeHidden();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#camera-gallery').click();
    await (await picker).setFiles({ name: 'bill.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#dlg-camera')).toBeHidden();
    await expect(page.locator('#txn-photo-prev')).toBeVisible();
    await expect(page.locator('#txn-amount')).toHaveValue('42');
    await expect(page.locator('#txn-comment')).toHaveValue('camera test bill');
    expect(await liveTracks(page)).toBe(0);
  });
}

test('a browser without camera support still offers gallery selection', async ({ page }) => {
  await openDraft(page);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = undefined; });
  await openEntryCamera(page);
  await expect(page.locator('#camera-status')).toContainText('Camera access is not available here');
  await expect(page.locator('#camera-retry')).toBeHidden();
  await expect(page.locator('#camera-gallery')).toBeVisible();
  await page.locator('#camera-cancel').click();
  await expect(page.locator('#txn-amount')).toHaveValue('42');
});

test('a failed camera can be retried, and a failed snapshot releases the stream', async ({ page }) => {
  const backend = await openDraft(page);
  await page.evaluate(() => { window.cameraFailure = 'NotReadableError'; });
  await openEntryCamera(page);
  await expect(page.locator('#camera-retry')).toBeVisible();
  await page.evaluate(() => { window.cameraFailure = null; });
  await page.locator('#camera-retry').click();
  await expect(page.locator('#camera-capture')).toBeEnabled();
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); }; });
  await page.locator('#camera-capture').click();
  await expect(page.locator('#camera-status')).toContainText('Could not capture a photo');
  await expect.poll(() => liveTracks(page)).toBe(0);
  await page.locator('#camera-cancel').click();
  await expect(page.locator('#txn-photo-prev')).toBeHidden();
  expect(backend.state.log).not.toContain('addTxn');
});

test('a snapshot completing after cancel is discarded', async ({ page }) => {
  await openDraft(page);
  await openEntryCamera(page);
  await expect(page.locator('#camera-capture')).toBeEnabled();
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.finishSnapshot = () => toBlob.apply(this, args);
    };
  });
  await page.locator('#camera-capture').click();
  await page.locator('#camera-cancel').click();
  await page.evaluate(() => window.finishSnapshot());
  await expect.poll(() => liveTracks(page)).toBe(0);
  await expect(page.locator('#dlg-camera')).toBeHidden();
  await expect(page.locator('#txn-photo-prev')).toBeHidden();
  await expect(page.locator('#txn-amount')).toHaveValue('42');
});
