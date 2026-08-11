import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, TINY_PNG } from './helpers.mjs';

/* Deleting an entry offers one tappable undo for 7s (audit 1.2). It has two
   shapes and both have to be right: while the delete is still queued the undo
   is purely local (the sheet never hears about it at all), and once the queue
   has drained the row is really gone upstream, so undo re-creates it. */

const queueLen = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bahi.queue') || '[]').length);

async function deleteAtta(page) {
  await page.locator('.txn-row', { hasText: 'atta' }).click();
  const del = page.locator('#txn-delete');
  await del.click();                       // arms
  await expect(del).toHaveText('Pakka?');
  await del.click();                       // confirms
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
}

test('undoing a still-queued delete never reaches the sheet at all', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('down');                 // the delete cannot leave the phone
  await deleteAtta(page);
  await expect.poll(() => queueLen(page)).toBe(1);

  await page.locator('.toast-act').click();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toBeVisible();
  await expect(page.locator('#bal-amt')).toContainText('300');
  // dropping the queued item *is* the undo — nothing is left to sync
  await expect.poll(() => queueLen(page)).toBe(0);

  backend.setMode('ok');
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toBeHidden();
  await page.locator('#btn-refresh').click();
  await expect(page.locator('#sum-get')).toContainText('300');
  expect(backend.state.log).not.toContain('deleteTxn');
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(true);
});

test('undoing a delete that already synced re-creates the row in the sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await deleteAtta(page);
  // let it really land upstream before undoing — that is the whole point
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(false);

  await page.locator('.toast-act').click();
  await expect.poll(() =>
    backend.state.transactions.filter((t) => t.comment === 'atta').length).toBe(1);

  const back = backend.state.transactions.find((t) => t.comment === 'atta');
  expect(back.id).not.toBe('t1');          // a fresh row, not a resurrection
  expect(back.amount).toBe(500);
  expect(back.type).toBe('given');
  expect(back.date).toBe('2026-08-01');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toBeVisible();
  await expect(page.locator('#bal-amt')).toContainText('300');
});

test('a drained-delete undo restores the note AND the photo from the device store', async ({ page }) => {
  const backend = createBackend(seedLedger());
  backend.state.transactions.push({
    id: 'tp9', user_name: 'u1', date: '2026-08-07',
    type: 'given', amount: 999, comment: 'parchi #42', photo: 'ph9',
  });
  backend.state.photos.ph9 = TINY_PNG.toString('base64');
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  // the thumbnail loader fetches the full photo into the device store
  await expect(page.locator('img.txn-thumb')).toBeVisible({ timeout: 10_000 });

  // delete syncs (backend up), then undo re-creates the entry
  await page.locator('.txn-row', { hasText: 'parchi #42' }).click();
  const del = page.locator('#txn-delete');
  await del.click();
  await expect(del).toHaveText('Pakka?');
  await del.click();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 'tp9')).toBe(false);

  await page.locator('.toast-act').click();
  await expect(page.locator('.txn-row', { hasText: 'parchi #42' })).toBeVisible();

  // the re-created sheet row carries the note and a fresh re-uploaded photo
  await expect.poll(() => {
    const t = backend.state.transactions.find((x) => Number(x.amount) === 999);
    return t && t.comment === 'parchi #42' && t.photo && t.photo !== 'ph9' && !!backend.state.photos[t.photo];
  }).toBe(true);
});
