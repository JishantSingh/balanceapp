import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { inviteHash, openLedger } from './helpers.mjs';

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

test('invite link with a valid key opens the ledger', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await expect(page.locator('.customer-row', { hasText: 'Sunita Tailor' })).toBeVisible();
});

test('invite link with a bad key must NOT claim success', async ({ page }) => {
  // UX-AUDIT 0.3 — today this shows "Connected ✓" + an empty ledger inviting
  // doomed entries. Fixed behavior: validate before declaring success, land
  // on a failure state, never the happy home screen.
  test.fail(true, 'audit 0.3: invite link never validates the key');
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + inviteHash(backend, 'rotated-away'));
  await page.waitForTimeout(1500); // give the (currently silent) refresh time to fail
  await expect(page.locator('#screen-home')).toBeHidden();
  await expect(page.locator('#screen-connect')).toBeVisible();
});

test('switching ledgers must not replay the old queue into the new sheet', async ({ page }) => {
  // UX-AUDIT 0.3 — today ledger A's unsynced queue survives the switch and
  // drains into ledger B's sheet.
  test.fail(true, 'audit 0.3: connection switch does not clear cache/queue');
  const a = createBackend(seedLedger());
  await openLedger(page, a);
  await page.locator('.customer-row', { hasText: 'Ramu Halwai' }).click();

  a.setMode('down'); // network "drops" so the write stays queued
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill('999');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  const b = createBackend({ key: 'otherkey' });
  await page.unrouteAll();
  await b.install(page);
  // query param forces a real reload — a hash-only goto is same-document
  // navigation and the app never re-boots
  await page.goto('/?ledger=b' + inviteHash(b));
  await page.waitForTimeout(1500); // time for any (buggy) queue drain
  expect(b.state.transactions.map((t) => t.amount)).not.toContain(999);
});
