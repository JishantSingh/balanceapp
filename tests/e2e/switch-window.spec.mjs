import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { inviteHash, inviteHashFor, openCustomer, addEntry, lsJSON, queueLen, OTHER_EXEC } from './helpers.mjs';

/* Validating an invite takes a round trip, and the phone stays fully usable
   for the whole of it — the old ledger is still on screen, the queue is still
   full of the old ledger's writes. Everything that happens inside that window
   belongs to the khata this phone is still holding, and nothing at all may be
   addressed to a backend the merchant has not agreed to yet. */

test('a write made while a new ledger is being validated goes to the OLD backend', async ({ page }) => {
  const a = createBackend(seedLedger());
  const b = createBackend({ key: 'otherkey', url: OTHER_EXEC });
  await a.install(page, { only: true });   // each backend answers only for itself,
  await b.install(page, { only: true });   // so its log says what was sent to IT
  await page.goto('/' + inviteHash(a));
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();

  // B is held: from here until release the app is standing inside the
  // validation window with the candidate's answer still on the wire.
  const releaseB = b.hold();
  await page.evaluate((h) => { location.hash = h; }, inviteHashFor(OTHER_EXEC, 'otherkey'));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();
  await expect.poll(() => b.state.requests.length).toBe(1);   // the list, in flight

  // …and the merchant saves an entry right now, into the khata on screen
  await openCustomer(page, 'Ramu Halwai');
  await addEntry(page, { type: 'given', amount: 424 });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('sync baaki');   // queued, not sent

  // the candidate turns out to be wrong; the old khata stays, and so does its entry
  b.setMode('badkey');
  releaseB();
  await expect.poll(() => a.state.transactions.some((t) => t.amount === 424)).toBe(true);
  expect(b.state.log).toEqual(['list']);      // the validation call, and nothing else
  expect(b.state.requests).toHaveLength(1);
  expect((await lsJSON(page, 'bahi.config')).url).toBe(MOCK_EXEC);
});

test('Settings cannot persist a candidate connection while it is being validated', async ({ page }) => {
  const a = createBackend(seedLedger());
  const b = createBackend({ key: 'otherkey', url: OTHER_EXEC });
  await a.install(page, { only: true });
  await b.install(page, { only: true });
  await page.goto('/' + inviteHash(a));
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();

  const releaseB = b.hold();
  await page.evaluate((h) => { location.hash = h; }, inviteHashFor(OTHER_EXEC, 'otherkey'));
  await page.locator('#switch-go').click();
  await expect.poll(() => b.state.requests.length).toBe(1);

  // saving Settings mid-validation must write the ledger this phone HAS
  await page.locator('#btn-settings').click();
  await expect(page.locator('#set-url')).toHaveValue(MOCK_EXEC);
  await page.locator('#set-merchant').fill('Purani Dukaan');
  await page.locator('#dlg-settings button[type="submit"]').click();
  const saved = await lsJSON(page, 'bahi.config');
  expect(saved.url).toBe(MOCK_EXEC);
  expect(saved.key).toBe('testkey');
  expect(saved.merchant).toBe('Purani Dukaan');

  b.setMode('badkey');
  releaseB();
  await expect(page.locator('#toast')).toContainText('purana khata waisa hi hai');
  expect((await lsJSON(page, 'bahi.config')).url).toBe(MOCK_EXEC);
  expect(await queueLen(page)).toBe(0);
});
