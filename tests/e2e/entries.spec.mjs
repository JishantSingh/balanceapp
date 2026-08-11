import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry } from './helpers.mjs';

test('given and received entries reach the sheet with correct balance', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('#bal-amt')).toContainText('300');

  await addEntry(page, { type: 'given', amount: 250, note: 'chai patti' });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#bal-amt')).toContainText('550');
  await expect.poll(() => backend.state.transactions.some(
    (t) => t.amount === 250 && t.type === 'given' && t.comment === 'chai patti'
  )).toBe(true);

  await addEntry(page, { type: 'received', amount: 50 });
  await expect(page.locator('#bal-amt')).toContainText('500');
  await expect.poll(() => backend.state.transactions.some(
    (t) => t.amount === 50 && t.type === 'received'
  )).toBe(true);
});

test('editing an entry updates the sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await page.locator('#txn-amount').fill('600');
  await page.locator('#txn-save').click();

  await expect(page.locator('#bal-amt')).toContainText('400'); // 600 - 200
  await expect.poll(() => backend.state.transactions.find((t) => t.id === 't1')?.amount).toBe(600);
});

test('double-tap delete removes the entry from the sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  const del = page.locator('#txn-delete');
  await del.click();                     // arms
  await expect(del).not.toHaveText('Delete');
  await del.click();                     // confirms
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});
