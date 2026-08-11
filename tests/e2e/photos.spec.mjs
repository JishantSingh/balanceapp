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
