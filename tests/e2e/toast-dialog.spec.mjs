import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer } from './helpers.mjs';

test('a toast fired while a dialog is open must be visible to the user', async ({ page }) => {
  // UX-AUDIT 0.4 — showModal() promotes the dialog to the top layer, which
  // paints above the toast regardless of z-index. Every toast fired from
  // inside a dialog (photo loading/errors, copy confirmations) is invisible.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#btn-gave').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();

  await page.evaluate(() => window.toast('hello from the test'));
  const onTop = await page.evaluate(() => {
    const el = document.getElementById('toast');
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el.contains(hit);
  });
  expect(onTop).toBe(true);
});
