import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { inviteHash, openCustomer, addEntry, lsJSON, OTHER_EXEC } from './helpers.mjs';

/* Settings → Connection holds the same two fields an invite link carries, so
   editing them IS switching ledgers — and it was the one door that did it with
   no validation, no confirm, no wipe, draining this khata's queue into the
   other sheet on the way. It goes through the invite guard now. */

const NAYA = {
  user_id: 'z1', name: 'Naya Khata Wala', created_at: '2026-08-01',
  phone: '', cohort: '', last_reminded: '', token: '',
};

async function twoLedgers(page) {
  const a = createBackend(seedLedger());
  const b = createBackend({ key: 'otherkey', url: OTHER_EXEC, users: [NAYA] });
  await a.install(page, { only: true });
  await b.install(page, { only: true });
  await page.goto('/' + inviteHash(a));
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  return { a, b };
}

async function pasteConnection(page, url, key) {
  await page.locator('#btn-settings').click();
  await expect(page.locator('#dlg-settings')).toBeVisible();
  await page.locator('.settings-conn summary').click();
  await page.locator('#set-url').fill(url);
  await page.locator('#set-key').fill(key);
  await page.locator('#dlg-settings button[type="submit"]').click();
}

test('pasting another khata into Settings must not switch behind the unsynced guard', async ({ page }) => {
  const { a, b } = await twoLedgers(page);
  await openCustomer(page, 'Ramu Halwai');

  a.setMode('down');                       // one write that has not reached the sheet
  await addEntry(page, { type: 'given', amount: 999 });
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  await pasteConnection(page, OTHER_EXEC, 'otherkey');

  // exactly the invite guard: asked first, unsynced writes named
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await expect(page.locator('#switch-msg')).toContainText('sync karein');
  await expect(page.locator('#switch-go')).toHaveText('Hata kar jodein');
  const saved = await lsJSON(page, 'bahi.config');
  expect(saved.url).toBe(MOCK_EXEC);       // nothing was written straight through
  expect(saved.key).toBe('testkey');
  expect(b.state.log).toEqual([]);         // and the other khata never heard from us

  await page.locator('#dlg-switch [data-close]').click();
  await expect(page.locator('#chip-pending')).toContainText('1');
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
});

test('a Settings connection change validates, confirms and wipes like any invite', async ({ page }) => {
  const { b } = await twoLedgers(page);

  await pasteConnection(page, OTHER_EXEC, 'otherkey');
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await expect(page.locator('#switch-go')).toHaveText('Jodein');
  await page.locator('#switch-go').click();

  await expect(page.locator('.customer-row', { hasText: 'Naya Khata Wala' })).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toHaveCount(0);
  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).url).toBe(OTHER_EXEC);
  expect(b.state.log).toContain('list');
});

test('a Settings connection that does not work leaves the khata exactly as it was', async ({ page }) => {
  await twoLedgers(page);

  await pasteConnection(page, OTHER_EXEC, 'galat-key');
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();

  await expect(page.locator('#toast')).toContainText('purana khata waisa hi hai');
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  expect((await lsJSON(page, 'bahi.config')).url).toBe(MOCK_EXEC);
});

test('other Settings still save without touching the connection', async ({ page }) => {
  const a = createBackend(seedLedger());
  await a.install(page, { only: true });
  await page.goto('/' + inviteHash(a));
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();

  await page.locator('#btn-settings').click();
  await page.locator('#set-merchant').fill('Singh General Store');
  await page.locator('#dlg-settings button[type="submit"]').click();

  await expect(page.locator('#toast')).toContainText('Settings saved');
  await expect(page.locator('#dlg-switch')).toBeHidden();
  const saved = await lsJSON(page, 'bahi.config');
  expect(saved.merchant).toBe('Singh General Store');
  expect(saved.url).toBe(MOCK_EXEC);
});
