import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger } from './helpers.mjs';

test('search filters the customer list', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.locator('#search').fill('sun');
  await expect(page.locator('.customer-row')).toHaveCount(1);
  await expect(page.locator('.customer-row')).toContainText('Sunita');
  await page.locator('#search').fill('');
  await expect(page.locator('.customer-row')).toHaveCount(2);
});

test('a no-match search must show a next action, not a blank screen', async ({ page }) => {
  // UX-AUDIT 3.2 — today the list is simply empty (the empty-state is gated
  // on total customers, not filtered count). Fixed behavior: a visible
  // no-results state (#search-empty) offering to create the typed name.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.locator('#search').fill('zzz');
  await expect(page.locator('.customer-row')).toHaveCount(0);
  await expect(page.locator('#search-empty')).toBeVisible();
});

test('a just-created customer must appear at the top of the list', async ({ page }) => {
  // UX-AUDIT 0.8 — created_at carries no time, ties sort by array order, and
  // the new user is pushed last: the person created 2 seconds ago is at the
  // BOTTOM of today's rows.
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);

  // give an existing customer activity *today* to create the date tie
  await page.locator('.customer-row', { hasText: 'Ramu' }).click();
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('10');
  await page.locator('#txn-save').click();
  await page.locator('#btn-back').click();

  await page.locator('#fab').click();
  await page.locator('#cust-input-name').fill('Zebra New');
  await page.locator('#cust-save').click();
  await expect(page.locator('.customer-row').first()).toContainText('Zebra New');
});
