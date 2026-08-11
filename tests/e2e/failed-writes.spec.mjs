import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry, lsJSON } from './helpers.mjs';

/* A write the server *refuses* (bad key, stale row, bad data) is not an offline
   write: retrying forever would jam the queue. It is rolled back locally and
   parked in the failed list behind the red chip, where it can be retried or
   thrown away on purpose — never silently dropped (audit 0.1). */

/* Make one addTxn get refused, then land on home with the red chip up. */
async function rejectEntry(page, backend, amount) {
  await openCustomer(page, 'Ramu Halwai');
  backend.setMode('badkey');
  await addEntry(page, { type: 'given', amount });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Save nahi hua');
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeVisible();
}

test('a refused write is parked in the failed sheet under a readable label', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await rejectEntry(page, backend, 888);

  await expect(page.locator('#chip-failed')).toHaveText('1 nahi bache');
  await page.locator('#chip-failed').click();
  await expect(page.locator('#dlg-failed')).toBeVisible();
  await expect(page.locator('#failed-list .failed-row')).toHaveCount(1);
  // the label has to name the money and the person, not the action verb
  await expect(page.locator('.failed-label')).toHaveText('₹888 · Ramu Halwai');
  await expect(page.locator('.failed-why')).toContainText(/unauthor/i);

  // and the phantom entry is gone from the ledger it never reached
  expect(backend.state.transactions.some((t) => t.amount === 888)).toBe(false);
});

test('Retry after the backend is fixed sends the write and clears the chip', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await rejectEntry(page, backend, 888);
  await page.locator('#chip-failed').click();
  await expect(page.locator('#dlg-failed')).toBeVisible();

  backend.setMode('ok');
  await page.locator('#failed-list [data-retry="0"]').click();

  await expect.poll(() => backend.state.transactions.some((t) => t.amount === 888)).toBe(true);
  await expect(page.locator('#dlg-failed')).toBeHidden();
  await expect(page.locator('#chip-failed')).toBeHidden();
  await expect.poll(() => lsJSON(page, 'bahi.failed')).toEqual([]);

  // the entry is back in the customer's ledger, this time for real
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: '888' })).toBeVisible();
});

test('Hatayein throws a refused write away for good — it does not come back on reload', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await rejectEntry(page, backend, 888);
  await page.locator('#chip-failed').click();
  await expect(page.locator('#dlg-failed')).toBeVisible();

  await page.locator('#failed-list [data-drop="0"]').click();
  await expect(page.locator('#dlg-failed')).toBeHidden();
  await expect(page.locator('#chip-failed')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Hata diya — ₹888 · Ramu Halwai');
  expect(await lsJSON(page, 'bahi.failed')).toEqual([]);

  backend.setMode('ok');
  await page.reload();
  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('#chip-failed')).toBeHidden();
  expect(await lsJSON(page, 'bahi.failed')).toEqual([]);
  expect(backend.state.transactions.some((t) => t.amount === 888)).toBe(false);
});

test('a refused edit rolls the entry back to what the sheet still holds', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('#bal-amt')).toContainText('300');

  backend.setMode('badkey');
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await page.locator('#txn-amount').fill('600');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Save nahi hua');

  // the optimistic 600 is undone — screen and sheet agree on 500 again
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toContainText('500');
  await expect(page.locator('#bal-amt')).toContainText('300');
  expect(backend.state.transactions.find((t) => t.id === 't1').amount).toBe(500);

  await page.locator('#btn-back').click();
  await page.locator('#chip-failed').click();
  await expect(page.locator('.failed-label')).toHaveText('₹600 · Ramu Halwai · badla');
});

test('a refused customer delete brings back the customer AND their entries', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#dlg-customer')).toBeVisible();

  backend.setMode('badkey');
  const del = page.locator('#cust-delete');
  await del.click();                       // arms
  await expect(del).toHaveText('Pakka?');
  await del.click();                       // confirms
  await expect(page.locator('#dlg-customer')).toBeHidden();
  await expect(page.locator('#screen-home')).toBeVisible();

  await expect(page.locator('#chip-failed')).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  await expect(page.locator('.customer-row')).toHaveCount(2);
  await expect(page.locator('#sum-get')).toContainText('300');

  await page.locator('#chip-failed').click();
  await expect(page.locator('.failed-label')).toHaveText('Ramu Halwai · hataya');
  await page.locator('#dlg-failed button[type="submit"]').click();
  await expect(page.locator('#dlg-failed')).toBeHidden();

  // the entries came back with the customer, not just the name row
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row')).toHaveCount(2);
  await expect(page.locator('#bal-amt')).toContainText('300');

  // and the sheet was never touched
  expect(backend.state.users.some((u) => u.user_id === 'u1')).toBe(true);
  expect(backend.state.transactions).toHaveLength(2);
});
