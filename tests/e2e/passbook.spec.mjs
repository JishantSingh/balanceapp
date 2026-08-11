import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { passbookHash } from './helpers.mjs';

test('passbook link renders name, balance, and history — and only safe fields', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_ramu_1234567890'));

  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expect(page.locator('#pb-amt')).toContainText('300');
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(2);

  // the customer must never see phone numbers, tokens, or other customers
  const html = await page.content();
  expect(html).not.toContain('9876500001');
  expect(html).not.toContain('tok_ramu');
  expect(html).not.toContain('Sunita');
});

test('a revoked/invalid passbook token shows an error, not a ledger', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_gone_1234567890'));
  await expect(page.locator('#pb-status')).toContainText(/no longer valid/i);
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
});
