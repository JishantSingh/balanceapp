import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { inviteHash, inviteHashFor, openLedger, OTHER_EXEC } from './helpers.mjs';

test('manual connect with URL and key opens the ledger', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/');
  await page.locator('#cfg-url').fill(MOCK_EXEC);
  await page.locator('#cfg-key').fill('testkey');
  await page.locator('#btn-connect').click();
  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  await expect(page.locator('#sum-get')).toContainText('300'); // 500 given - 200 received
});

test('manual connect with a wrong key stays on connect and shows an error', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/');
  await page.locator('#cfg-url').fill(MOCK_EXEC);
  await page.locator('#cfg-key').fill('wrong');
  await page.locator('#btn-connect').click();
  await expect(page.locator('#connect-error')).toBeVisible();
  await expect(page.locator('#screen-home')).toBeHidden();
});

test('a failed connect attempt must not leave the demo stuck on OFFLINE', async ({ page }) => {
  // The demo answers from localStorage and used to return before anything
  // cleared the offline flag, so one failed attempt before it left the chip
  // up for the whole session — on a ledger that needs no network at all.
  const backend = createBackend(seedLedger());
  backend.setMode('down');
  await backend.install(page);
  await page.goto('/');
  await page.locator('#cfg-url').fill(MOCK_EXEC);
  await page.locator('#cfg-key').fill('testkey');
  await page.locator('#btn-connect').click();
  await expect(page.locator('#connect-error')).toBeVisible();

  await page.locator('#btn-demo').click();
  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('.customer-row').first()).toBeVisible();
  await expect(page.locator('#chip-offline')).toBeHidden();
});

test('invite link with a valid key opens the ledger', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await expect(page.locator('.customer-row', { hasText: 'Sunita Tailor' })).toBeVisible();
});

test('invite link with a bad key must NOT claim success', async ({ page }) => {
  // UX-AUDIT 0.3 — today this shows "Connected ✓" + an empty ledger inviting
  // doomed entries. Fixed behavior: validate before declaring success, land
  // on a failure state, never the happy home screen.
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + inviteHash(backend, 'rotated-away'));
  await page.waitForTimeout(1500); // give the (currently silent) refresh time to fail
  await expect(page.locator('#screen-home')).toBeHidden();
  await expect(page.locator('#screen-connect')).toBeVisible();
});

test('switching ledgers must not replay the old queue into the new sheet', async ({ page }) => {
  // UX-AUDIT 0.3 — today ledger A's unsynced queue survives the switch and
  // drains into ledger B's sheet. B is a second *deployment* (its own URL):
  // the same URL with a new key is the same khata, not another one.
  const a = createBackend(seedLedger());
  const b = createBackend({ key: 'otherkey', url: OTHER_EXEC });
  await a.install(page, { only: true });
  await b.install(page, { only: true });
  await page.goto('/' + inviteHash(a));
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  await page.locator('.customer-row', { hasText: 'Ramu Halwai' }).click();

  a.setMode('down'); // network "drops" so the write stays queued
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('999');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  // query param forces a real reload — a hash-only goto is same-document
  // navigation and the app never re-boots
  await page.goto('/?ledger=b' + inviteHashFor(OTHER_EXEC, 'otherkey'));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();      // discard and switch, on purpose
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toHaveCount(0);

  expect(b.state.transactions.map((t) => t.amount)).not.toContain(999);
  expect(b.state.log).not.toContain('addTxn');
});

test('a malformed invite link leaves no key in the address bar', async ({ page }) => {
  // The fragment is a full-access credential. It used to survive every parse
  // failure — sitting in the address bar, the history, and any screenshot.
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/#s=not-a-real-payload');
  await expect(page.locator('#screen-connect')).toBeVisible();
  expect(page.url()).not.toContain('#');
});
