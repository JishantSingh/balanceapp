import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { passbookHash, openLedger, b64url } from './helpers.mjs';

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

test("a demo passbook link must not invent a ledger on a stranger's phone", async ({ page }) => {
  // #p={d:…} reads the demo store on THIS device. It used to seed one when
  // none existed — showing invented customers and amounts, on a phone that
  // has never opened the demo, as if they were somebody's real khata.
  await page.goto('/');
  await page.goto('/#p=' + b64url({ d: 'demo0001' }));
  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-status')).toContainText(/no longer valid/i);
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
  await expect(page.locator('#pb-name')).toHaveText('…');   // no fabricated customer
  await expect(page.locator('#pb-amt')).toHaveText('…');
});

test('a passbook opened on the merchant own phone offers a way back to the khata', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);                     // this phone holds a real ledger
  await page.goto('/?pb=1' + passbookHash('tok_ramu_1234567890'));

  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-mine')).toBeVisible();
  await page.locator('#pb-mine-go').click();

  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  expect(page.url()).not.toContain('#p=');
});

test('a passbook on a phone with no khata offers no way in', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_ramu_1234567890'));
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expect(page.locator('#pb-mine')).toBeHidden();
  // The token stays in the URL: it is the customer's only way back in on
  // reload (scoped + revocable, unlike the invite key which is stripped).
  expect(page.url()).toContain('#p=');
  await page.reload();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
});
