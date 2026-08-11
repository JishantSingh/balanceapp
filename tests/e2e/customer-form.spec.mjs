import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { openLedger, decodeHash, stubClipboard } from './helpers.mjs';

/* The customer dialog holds two things that only bite much later: a phone
   number that WhatsApp will refuse days from now (audit 1.5), and the safe
   read-only passbook link that must exist before it is offered (audit 1.1). */

async function newCustomer(page, { name, phone }) {
  await page.locator('#fab').click();
  await expect(page.locator('#dlg-customer')).toBeVisible();
  await page.locator('#cust-input-name').fill(name);
  if (phone !== undefined) await page.locator('#cust-input-phone').fill(phone);
  await page.locator('#cust-save').click();
}

test('a phone number that cannot work is refused before it is saved', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await newCustomer(page, { name: 'Chhota Number', phone: '12345' });

  await expect(page.locator('#dlg-customer')).toBeVisible();   // held open on purpose
  await expect(page.locator('#cust-error')).toBeVisible();
  await expect(page.locator('#cust-error')).toContainText('10 digit');
  expect(backend.state.users.some((u) => u.name === 'Chhota Number')).toBe(false);
});

test('a leading zero is normalised away and the customer saves', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await newCustomer(page, { name: 'Zero Prefix', phone: '09876543210' });

  await expect(page.locator('#dlg-customer')).toBeHidden();
  await expect.poll(() =>
    backend.state.users.find((u) => u.name === 'Zero Prefix')?.phone).toBe('9876543210');
  // and the merchant sees the number the reminder will actually use
  await expect(page.locator('.customer-row', { hasText: 'Zero Prefix' })).toBeVisible();
});

test('no phone number at all is perfectly fine', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await newCustomer(page, { name: 'Bina Phone', phone: '' });

  await expect(page.locator('#dlg-customer')).toBeHidden();
  await expect(page.locator('#cust-error')).toBeHidden();
  await expect.poll(() =>
    backend.state.users.some((u) => u.name === 'Bina Phone' && u.phone === '')).toBe(true);
});

test('the passbook link is offered only where a token exists, and copies a #p= link', async ({ page }) => {
  const seed = seedLedger();
  seed.users.push({
    user_id: 'u3', name: 'Bina Token', created_at: '2026-07-03',
    phone: '', cohort: '', last_reminded: '', token: '',
  });
  const backend = createBackend(seed);
  await stubClipboard(page);
  await openLedger(page, backend);

  // a pre-v3 row (or a customer still queued) has no token — nothing to hand out
  await page.locator('.customer-row', { hasText: 'Bina Token' }).click();
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#dlg-customer')).toBeVisible();
  await expect(page.locator('#cust-passbook-wrap')).toBeHidden();
  await page.locator('#dlg-customer [data-close]').click();
  await page.locator('#btn-back').click();

  // a tokened customer gets the safe, read-only, one-customer link
  await page.locator('.customer-row', { hasText: 'Ramu Halwai' }).click();
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-passbook-wrap')).toBeVisible();
  await page.locator('#cust-passbook').click();
  await expect(page.locator('#toast')).toContainText('Passbook link copy ho gaya');

  const copied = await page.evaluate(() => window.__copied[0]);
  expect(copied).toContain('#p=');
  expect(decodeHash(copied)).toEqual({ u: MOCK_EXEC, t: 'tok_ramu_1234567890' });
});
