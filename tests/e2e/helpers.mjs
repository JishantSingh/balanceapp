import { expect } from '@playwright/test';
import { MOCK_EXEC } from '../mock-backend.mjs';

export const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const inviteHash = (backend, key) =>
  '#s=' + b64url({ u: MOCK_EXEC, k: key ?? backend.state.key });

export const passbookHash = (token) =>
  '#p=' + b64url({ u: MOCK_EXEC, t: token });

/* Connect via invite link and wait for the ledger to render. */
export async function openLedger(page, backend) {
  await backend.install(page);
  await page.goto('/' + inviteHash(backend));
  await expect(page.locator('#screen-home')).toBeVisible();
  if (backend.state.users.length) {
    await expect(page.locator('.customer-row').first()).toBeVisible();
  }
}

export async function openCustomer(page, name) {
  await page.locator('.customer-row', { hasText: name }).click();
  await expect(page.locator('#screen-customer')).toBeVisible();
}

/* Add an entry from the customer screen. */
export async function addEntry(page, { type = 'given', amount, note }) {
  await page.locator(type === 'given' ? '#btn-gave' : '#btn-got').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await page.locator('#txn-amount').fill(String(amount));
  if (note) await page.locator('#txn-comment').fill(note);
  await page.locator('#txn-save').click();
}

/* 1x1 red PNG — enough for compressImage to decode and re-encode. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
