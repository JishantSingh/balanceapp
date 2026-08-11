import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer } from './helpers.mjs';

test('an armed delete must not carry over to a different entry', async ({ page }) => {
  // UX-AUDIT 0.2 — armConfirm uses a constant token ('del-txn') and nothing
  // clears it when another dialog opens: arm on entry A, cancel, open entry B
  // within 2.6s → a SINGLE tap of "Delete" destroys B.
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

test('an armed delete must not resize the button under the finger', async ({ page }) => {
  // "Delete" → "Pakka?" is a wider word. Without the width pin the whole action
  // row slides sideways and the confirming tap lands on Cancel — or on Save.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('.txn-row', { hasText: 'atta' }).click();

  const del = page.locator('#txn-delete');
  await expect(del).toHaveText('Delete');
  const before = await del.boundingBox();

  await del.click();
  await expect(del).toHaveText('Pakka?');
  await expect(del).toHaveClass(/armed/);
  const after = await del.boundingBox();

  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  // …and the neighbours it would have shoved stay put too
  const cancel = page.locator('#dlg-txn [data-close]');
  await expect(del).toBeVisible();
  expect((await cancel.boundingBox()).width).toBeGreaterThan(0);
});

test('cancelling an armed delete and reopening the SAME entry still needs two taps', async ({ page }) => {
  // The other half of audit 0.2: disarming on close is not enough if reopening
  // the same entry re-uses a token that is still armed.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await page.locator('#txn-delete').click();
  await expect(page.locator('#txn-delete')).toHaveText('Pakka?');
  await page.locator('#dlg-txn [data-close]').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#txn-delete')).toHaveText('Delete');   // reopened disarmed
  await page.locator('#txn-delete').click();                        // one tap only arms
  await expect(page.locator('#txn-delete')).toHaveText('Pakka?');
  await expect(page.locator('#dlg-txn')).toBeVisible();             // never closed = never deleted
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(true);
});
