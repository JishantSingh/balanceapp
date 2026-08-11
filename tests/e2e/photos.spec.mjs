import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, TINY_PNG } from './helpers.mjs';

test('photo attaches, uploads, thumbnails in the ledger, and opens in the viewer', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('42');
  await page.locator('#txn-photo').setInputFiles({
    name: 'parchi.png', mimeType: 'image/png', buffer: TINY_PNG,
  });
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

  // ledger grows a thumbnail (lazy fetch via the photo action), tap → viewer
  const thumb = page.locator('img.txn-thumb').first();
  await expect(thumb).toBeVisible({ timeout: 10_000 });
  await thumb.click();
  await expect(page.locator('#dlg-photo')).toBeVisible();
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
