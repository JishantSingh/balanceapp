import { expect } from '@playwright/test';
import { MOCK_EXEC } from '../mock-backend.mjs';

export const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const inviteHash = (backend, key) =>
  '#s=' + b64url({ u: MOCK_EXEC, k: key ?? backend.state.key });

/* A second deployment URL — "a different khata" as far as the app is concerned.
   The mock backend routes every script.google host, so this only has to differ
   as a string and still satisfy the app's /exec URL check. */
export const OTHER_EXEC = 'https://script.google.com/macros/s/OTHERDEPLOY/exec';

export const inviteHashFor = (url, key) => '#s=' + b64url({ u: url, k: key });

export const passbookHash = (token) =>
  '#p=' + b64url({ u: MOCK_EXEC, t: token });

/* Read one of the app's localStorage slots back out of the page. Returns null
   when the key is absent, so "wiped" and "empty" stay distinguishable. */
export const lsJSON = (page, key) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw === null ? null : JSON.parse(raw);
  }, key);

/* Decode a #p= / #s= link the app produced. */
export const decodeHash = (link) => {
  const b64 = link.split('#')[1].slice(2).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString());
};

/* Record clipboard writes instead of touching the real one — headless Chromium
   rejects writeText without a permission grant, and copyText() falls back to
   execCommand, which we could not observe. */
export const stubClipboard = (page) =>
  page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
    });
  });

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

/* How many writes are still waiting to reach the sheet. */
export const queueLen = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bahi.queue') || '[]').length);

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
