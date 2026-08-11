import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, queueLen, lsJSON, TINY_PNG } from './helpers.mjs';

/* The queue's retries have to be idempotent, because the one failure it cannot
   see is a write that COMMITTED and then lost its answer. To the phone that is
   indistinguishable from a write that never arrived — and keeping it queued is
   the only safe reading, so the retry is not optional. What the retry must not
   do is happen twice:

   - an add sent again used to insert a SECOND identical row, with a second
     uploaded photo (the live incident: an undo's re-add, duplicated);
   - a delete sent again used to come back "not found", get classified as a
     refusal, and roll itself back — resurrecting the entry it had deleted.

   Backend v8 fixes both at the source (a client id per insert, "already gone"
   is success on delete); the frontend still has to cope with older backends,
   which is the last test here. `drop-once` is the whole mechanism under test:
   it applies the write to the sheet and then aborts the reply. */

async function deleteAtta(page) {
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  const del = page.locator('#txn-delete');
  await del.click();                       // arms
  await expect(del).toHaveText('Pakka?');
  await del.click();                       // confirms
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
}

async function addEntryWithPhoto(page, amount) {
  await page.locator('#btn-gave').click();
  await page.locator('#txn-amount').fill(String(amount));
  await page.locator('#txn-photo').setInputFiles({
    name: 'parchi.png', mimeType: 'image/png', buffer: TINY_PNG,
  });
  await expect(page.locator('#txn-photo-prev')).toBeVisible();   // compression done
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();
}

test('an add whose answer was lost lands ONCE, with one photo, when it retries', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('drop-once');            // the sheet takes it; the phone never hears
  await addEntryWithPhoto(page, 42);

  // committed upstream AND still queued here — the ambiguity, reproduced
  await expect.poll(() =>
    backend.state.transactions.filter((t) => Number(t.amount) === 42).length).toBe(1);
  await expect.poll(() => queueLen(page)).toBe(1);

  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toBeVisible();
  await page.locator('#chip-pending').click();          // retry, against a healthy backend
  await expect(page.locator('#chip-pending')).toBeHidden();

  // the retry replayed the first insert instead of writing a second row
  expect(backend.state.transactions.filter((t) => Number(t.amount) === 42)).toHaveLength(1);
  expect(Object.keys(backend.state.photos)).toHaveLength(1);   // and one uploaded photo
  await expect(page.locator('#chip-failed')).toBeHidden();
  expect(await lsJSON(page, 'bahi.failed') || []).toEqual([]);

  // the ledger agrees: one entry, and a balance that counted it once
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: '42' })).toHaveCount(1);
  await expect(page.locator('#bal-amt')).toContainText('342');
});

test('a delete whose answer was lost stays deleted when it retries', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('drop-once');
  await deleteAtta(page);

  // the row is already gone from the sheet, and the delete is still queued
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
  await expect.poll(() => queueLen(page)).toBe(1);

  await page.locator('#btn-back').click();
  await page.locator('#chip-pending').click();
  await expect(page.locator('#chip-pending')).toBeHidden();
  await expect(page.locator('#chip-failed')).toBeHidden();
  expect(await lsJSON(page, 'bahi.failed') || []).toEqual([]);

  // nothing resurrected — not on screen, not in the sheet
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect(page.locator('.txn-row')).toHaveCount(1);
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});

test('a pre-v8 backend refusing the retried delete still counts as deleted', async ({ page }) => {
  /* Older deployments answer "Transaction not found" to the second attempt, and
     that refusal used to roll the delete back. They cannot be updated on our
     schedule, so the frontend forgives exactly this one message on exactly the
     two delete actions — everything else stays a refusal. */
  const backend = createBackend({ ...seedLedger(), v: 7 });
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('drop-once');
  await deleteAtta(page);
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);

  await page.locator('#btn-back').click();
  await page.locator('#chip-pending').click();
  await expect(page.locator('#chip-pending')).toBeHidden();
  await expect(page.locator('#chip-failed')).toBeHidden();

  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect(page.locator('#bal-amt')).toContainText('200');
});

test('a freshly synced photo thumbnails from the phone, without fetching it back', async ({ page }) => {
  /* The bytes went up from this phone; downloading them again to draw a 96px
     square is the "thumbnail took forever after undo" symptom. The queue files
     the uploaded photo under the id the sheet gave it, so the thumb is made
     locally and no `photo` action is ever sent. */
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await addEntryWithPhoto(page, 55);
  await expect.poll(() => queueLen(page)).toBe(0);

  await expect(page.locator('img.txn-thumb')).toBeVisible();
  expect(backend.state.log).not.toContain('photo');
});
