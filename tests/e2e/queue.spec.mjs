import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry, lsJSON } from './helpers.mjs';

test('offline entries queue with a visible chip, then sync when back online', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  // 'down' aborts routed requests with a network error — the correct offline
  // simulation here (context.setOffline doesn't affect page.route fulfills)
  backend.setMode('down');
  await addEntry(page, { type: 'given', amount: 777 });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: '777' })).toBeVisible(); // optimistic

  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toBeVisible();
  await expect(page.locator('#chip-pending')).toContainText('1');

  backend.setMode('ok');
  await page.locator('#chip-pending').click(); // tap to retry
  await expect.poll(() => backend.state.transactions.some((t) => t.amount === 777)).toBe(true);
  await expect(page.locator('#chip-pending')).toBeHidden();
});

test('a reply that is not JSON keeps the write queued — it is not a refusal', async ({ page }) => {
  /* An Apps Script deployment shared "Only myself" answers Google's sign-in
     HTML instead of JSON. That SyntaxError is neither a network failure nor a
     backend saying no, and it used to be classified as a refusal: the whole
     queue rolled back into the failed list over a sharing setting. */
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('html');
  await addEntry(page, { type: 'given', amount: 321 });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await page.locator('#btn-back').click();

  await expect(page.locator('#chip-pending')).toContainText('1');   // still waiting
  await expect(page.locator('#chip-failed')).toBeHidden();          // never rolled back
  expect(await lsJSON(page, 'bahi.failed')).toEqual(null);

  // and it goes through untouched the moment the deployment answers properly
  backend.setMode('ok');
  await page.locator('#chip-pending').click();
  await expect.poll(() => backend.state.transactions.some((t) => t.amount === 321)).toBe(true);
  await expect(page.locator('#chip-pending')).toBeHidden();
});

test('a server-rejected write must surface visibly, not vanish', async ({ page }) => {
  // UX-AUDIT 0.1 — today the queue drops the item with a 3.2s toast, the
  // ledger keeps showing the phantom entry, and the next sync erases it
  // silently. Fixed behavior: a persistent failed-writes surface
  // (#chip-failed) and the optimistic entry rolled back or visibly marked.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('badkey');
  await addEntry(page, { type: 'given', amount: 888 });
  await expect(page.locator('#dlg-txn')).toBeHidden();

  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeVisible({ timeout: 5000 });

  // the phantom entry must not sit in the ledger looking synced
  backend.setMode('ok');
  await page.locator('#btn-refresh').click();
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: '888' })).toHaveCount(0);
});
