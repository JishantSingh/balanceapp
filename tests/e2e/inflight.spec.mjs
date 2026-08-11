import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry, queueLen, lsJSON } from './helpers.mjs';

/* A write that is already on the wire is the one thing on this phone that
   cannot be taken back. The queue is edited from four places while that is
   true — a delete, a customer delete, an undo, a ledger switch — and every one
   of them used to work on positions and stale ids. Both tests below stand in
   the middle of a real in-flight request (backend.hold()) and edit around it. */

test('deleting an entry whose add is on the wire must not lose the entry behind it', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  const release = backend.hold();
  await addEntry(page, { type: 'given', amount: 111, note: 'pehli' });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect.poll(() => backend.state.requests.length).toBeGreaterThan(1);  // add #1 in flight
  await addEntry(page, { type: 'given', amount: 222, note: 'doosri' });       // waits behind it
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect.poll(() => queueLen(page)).toBe(2);

  // now delete the FIRST entry, while its own add is still on the wire
  await page.locator('.txn-row', { hasText: 'pehli' }).click();
  const del = page.locator('#txn-delete');
  await del.click();                       // arms
  await del.click();                       // confirms
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'pehli' })).toHaveCount(0);

  release();
  await expect.poll(() => queueLen(page)).toBe(0);

  // the deleted one is gone from the sheet; the one behind it was never touched
  expect(backend.state.transactions.some((t) => t.comment === 'pehli')).toBe(false);
  expect(backend.state.transactions.filter((t) => t.comment === 'doosri')).toHaveLength(1);
  await expect(page.locator('.txn-row', { hasText: 'doosri' })).toBeVisible();
  await expect(page.locator('.txn-row', { hasText: 'pehli' })).toHaveCount(0);
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeHidden();
  await expect(page.locator('#chip-pending')).toBeHidden();
});

test('an entry edited across its own sync still saves, under the id the sheet gave it', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  const release = backend.hold();
  await addEntry(page, { type: 'given', amount: 400, note: 'nayi parchi' });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect.poll(() => backend.state.requests.length).toBeGreaterThan(1);

  // open it for editing while it still carries its temporary id…
  await page.locator('.txn-row', { hasText: 'nayi parchi' }).click();
  await expect(page.locator('#dlg-txn')).toBeVisible();

  // …and let the add land underneath the open dialog: the row's id changes
  release();
  await expect.poll(() => queueLen(page)).toBe(0);

  await page.locator('#txn-amount').fill('450');
  await page.locator('#txn-save').click();
  await expect(page.locator('#txn-error')).toBeHidden();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  await expect.poll(() =>
    backend.state.transactions.filter((t) => t.comment === 'nayi parchi').length).toBe(1);
  await expect.poll(() =>
    backend.state.transactions.find((t) => t.comment === 'nayi parchi').amount).toBe(450);
  await expect(page.locator('.txn-row', { hasText: 'nayi parchi' })).toContainText('450');
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeHidden();
  expect(await lsJSON(page, 'bahi.failed')).toEqual([]);
});
