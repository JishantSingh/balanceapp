import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer } from './helpers.mjs';

test('an armed delete must not carry over to a different entry', async ({ page }) => {
  // UX-AUDIT 0.2 — armConfirm uses a constant token ('del-txn') and nothing
  // clears it when another dialog opens: arm on entry A, cancel, open entry B
  // within 2.6s → a SINGLE tap of "Delete" destroys B.
  test.fail(true, 'audit 0.2: cross-entity single-tap delete');
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  // arm delete on the 'atta' entry, then cancel
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await page.locator('#txn-delete').click();
  await page.locator('#dlg-txn [data-close]').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  // open the other entry and tap Delete ONCE — it must only arm, never delete
  await page.locator('.txn-row', { hasText: '200' }).click();
  await page.locator('#txn-delete').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#dlg-txn')).toBeVisible();          // still open, only armed
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't2')).toBe(true);
});
