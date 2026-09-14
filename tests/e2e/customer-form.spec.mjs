import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { openLedger, openCustomer, decodePassbookLink, stubClipboard } from './helpers.mjs';

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

test('name fields request word capitals but preserve manually typed casing on add and edit', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.locator('#fab').click();
  const input = page.locator('#cust-input-name');
  await expect(input).toHaveAttribute('autocapitalize', 'words');
  // Physical keyboard input deliberately bypasses the mobile keyboard hint.
  await input.pressSequentially('ram mcDonald');
  await expect(input).toHaveValue('ram mcDonald');
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === 'ram mcDonald')).toBe(true);
  await openCustomer(page, 'ram mcDonald');
  await page.locator('#cust-head-main').click();
  await expect(input).toHaveAttribute('autocapitalize', 'words');
  await expect(input).toHaveValue('ram mcDonald');
  await input.fill('ramu mcDonald');
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === 'ramu mcDonald')).toBe(true);
  await page.locator('#cust-head-main').click();
  await expect(input).toHaveValue('ramu mcDonald');
});

test('pasted names keep their original casing and scripts when saved and reopened', async ({ page, context }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.locator('#fab').click();
  const pasted = 'mcDonald  IIT émilie anne-marie o’neil राम कुमार';
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(text => navigator.clipboard.writeText(text), pasted);
  await page.locator('#cust-input-name').press('ControlOrMeta+v');
  await expect(page.locator('#cust-input-name')).toHaveValue(pasted);
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === pasted)).toBe(true);
  await openCustomer(page, pasted);
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-input-name')).toHaveValue(pasted);
});

test('search-prefilled names are not rewritten by the keyboard hint', async ({ page }) => {
  await openLedger(page, createBackend(seedLedger()));
  await page.locator('#search').fill('naya vyapari');
  await page.locator('#search-empty-add').click();
  await expect(page.locator('#cust-input-name')).toHaveValue('naya vyapari');
  await expect(page.locator('#search')).toHaveValue('naya vyapari');
});

test('existing names remain unchanged on phone-only edits', async ({ page }) => {
  const seed = seedLedger();
  seed.users[0].name = 'ramu halwai';
  const backend = createBackend(seed);
  await openLedger(page, backend);
  await openCustomer(page, 'ramu halwai');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-input-name')).toHaveValue('ramu halwai');
  await page.locator('#cust-input-phone').fill('9876543210');
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users[0].phone).toBe('9876543210');
  expect(backend.state.users[0].name).toBe('ramu halwai');
});

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

test('the passbook link is offered only where a token exists, and copies a compact customer link', async ({ page }) => {
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
  expect(copied).toContain('/p/#MOCKDEPLOY.');
  expect(decodePassbookLink(copied)).toEqual({ u: MOCK_EXEC, t: 'tok_ramu_1234567890' });
});
