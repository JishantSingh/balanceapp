import { test, expect } from '@playwright/test';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry, inviteHash, inviteHashFor, lsJSON, OTHER_EXEC } from './helpers.mjs';

/* An invite link is a credential for somebody's whole khata. Applying one is
   never silent and never symmetric: the same ledger with a refreshed key must
   keep everything this phone is holding, a *different* ledger must leave
   nothing of the old one behind, and unsynced writes veto the switch outright
   (audit 0.3). */

const seedThumbs = (page) => page.evaluate(() => {
  localStorage.setItem('bahi.thumbs', JSON.stringify({ marker: { d: 'data:,x', t: 1 } }));
  localStorage.setItem('bahi.demo', JSON.stringify({ users: [], transactions: [] }));
});

test('a refreshed key for the same ledger must not wipe the phone', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await seedThumbs(page);

  backend.state.key = 'rotated';           // merchant re-deployed with a new secret
  await page.goto('/?again=1' + inviteHash(backend, 'rotated'));

  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Nayi key lag gayi');
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();

  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).key).toBe('rotated');
  expect(await lsJSON(page, 'bahi.thumbs')).toHaveProperty('marker');
});

test('switching to a different ledger asks first, then leaves nothing behind', async ({ page }) => {
  const a = createBackend(seedLedger());
  await openLedger(page, a);
  await seedThumbs(page);

  const b = createBackend({
    key: 'otherkey',
    users: [{ user_id: 'z1', name: 'Naya Khata Wala', created_at: '2026-08-01', phone: '', token: '' }],
  });
  await page.unrouteAll();
  await b.install(page);
  await page.goto('/?ledger=b' + inviteHashFor(OTHER_EXEC, 'otherkey'));

  // nothing happens until the merchant says so
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await expect(page.locator('#switch-sync')).toBeHidden();     // nothing unsynced to protect
  await expect(page.locator('#switch-go')).toHaveText('Jodein');
  await page.locator('#switch-go').click();

  await expect(page.locator('.customer-row', { hasText: 'Naya Khata Wala' })).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toHaveCount(0);
  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).url).toBe(OTHER_EXEC);
  // bill thumbnails and demo residue belong to the ledger that made them
  expect(await lsJSON(page, 'bahi.thumbs')).toBe(null);
  expect(await lsJSON(page, 'bahi.demo')).toBe(null);
});

test('a key refresh with unsynced writes keeps every write and sends it with the new key', async ({ page }) => {
  /* The same khata, reached by the same URL, with a refreshed key. The queued
     entry belongs to this ledger and the new key is exactly what lets it
     through — so there is nothing here to warn about and nothing to discard.
     (This used to show the wrong-khata warning, whose only way forward threw
     the entry away for good.) */
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('down');
  await addEntry(page, { type: 'given', amount: 555 });
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  backend.setMode('ok');
  backend.state.key = 'rotated';           // merchant re-deployed with a new secret
  await page.goto('/?again=1' + inviteHash(backend, 'rotated'));

  await expect(page.locator('#toast')).toContainText('Nayi key lag gayi');
  await expect(page.locator('#dlg-switch')).toBeHidden();   // no warning: same khata
  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).key).toBe('rotated');

  // the entry the old key could not deliver goes through with the new one
  await expect.poll(() => backend.state.transactions.some((t) => t.amount === 555)).toBe(true);
  await expect(page.locator('#chip-pending')).toBeHidden();
  await expect(page.locator('#chip-failed')).toBeHidden();
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: '555' })).toBeVisible();
});

test('discarding unsynced writes for a link that turns out to be dead keeps them', async ({ page }) => {
  /* "Hata kar jodein" is the only way past unsynced writes, and it used to
     clear the queue *before* the new link had proved it works: a typo, an
     expired deployment, no signal — the writes were destroyed for nothing.
     They are held until the connection is real. */
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('down');                 // the entry stays on the phone…
  await addEntry(page, { type: 'given', amount: 555 });
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  // …and the invite for the other khata cannot be validated either
  await page.goto('/?ledger=b' + inviteHashFor(OTHER_EXEC, 'otherkey'));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await expect(page.locator('#switch-go')).toHaveText('Hata kar jodein');
  await page.locator('#switch-go').click();

  await expect(page.locator('#toast')).toContainText('purana khata waisa hi hai');
  await expect(page.locator('#chip-pending')).toContainText('1');       // not destroyed
  expect(await lsJSON(page, 'bahi.queue')).toHaveLength(1);
  expect((await lsJSON(page, 'bahi.config')).url).toBe(MOCK_EXEC);
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: '555' })).toBeVisible();
});

test('an invite arriving on top of unsynced writes must refuse to switch quietly', async ({ page }) => {
  const a = createBackend(seedLedger());
  await openLedger(page, a);
  await openCustomer(page, 'Ramu Halwai');

  a.setMode('down');                       // the entry stays on the phone
  await addEntry(page, { type: 'given', amount: 999 });
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  await page.goto('/?ledger=b' + inviteHashFor(OTHER_EXEC, 'otherkey'));

  await expect(page.locator('#dlg-switch')).toBeVisible();
  await expect(page.locator('#switch-msg')).toContainText('sync karein');
  await expect(page.locator('#switch-sync')).toBeVisible();    // the safe way out
  await expect(page.locator('#switch-go')).toHaveText('Hata kar jodein');

  // declining leaves this phone exactly where it was
  await page.locator('#dlg-switch [data-close]').click();
  await expect(page.locator('#dlg-switch')).toBeHidden();
  await expect(page.locator('#chip-pending')).toContainText('1');
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
  expect((await lsJSON(page, 'bahi.config')).url).toBe(MOCK_EXEC);
});
