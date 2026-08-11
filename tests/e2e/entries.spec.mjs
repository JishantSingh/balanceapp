import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry } from './helpers.mjs';

test('given and received entries reach the sheet with correct balance', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await expect(page.locator('#bal-amt')).toContainText('300');

  await addEntry(page, { type: 'given', amount: 250, note: 'chai patti' });
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#bal-amt')).toContainText('550');
  await expect.poll(() => backend.state.transactions.some(
    (t) => t.amount === 250 && t.type === 'given' && t.comment === 'chai patti'
  )).toBe(true);

  await addEntry(page, { type: 'received', amount: 50 });
  await expect(page.locator('#bal-amt')).toContainText('500');
  await expect.poll(() => backend.state.transactions.some(
    (t) => t.amount === 50 && t.type === 'received'
  )).toBe(true);
});

test('editing an entry updates the sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await page.locator('#txn-amount').fill('600');
  await page.locator('#txn-save').click();

  await expect(page.locator('#bal-amt')).toContainText('400'); // 600 - 200
  await expect.poll(() => backend.state.transactions.find((t) => t.id === 't1')?.amount).toBe(600);
});

test('an all-digit id (a Number out of Sheets) is still tappable and editable', async ({ page }) => {
  /* Ids are 8 random hex characters, so roughly one in fifty is all digits —
     and Sheets hands those back as Numbers, not strings. Reads compared with
     String() and worked; every mutation path compared with === against a
     string data-attribute and quietly missed, so the row could not be opened
     at all. Ids are normalised where they enter the app now. */
  const backend = createBackend({
    users: [{
      user_id: 90210, name: 'Numeric Nandu', created_at: '2026-07-01',
      phone: '', cohort: '', last_reminded: '', token: 'tok_nandu_1234567890',
    }],
    transactions: [
      { id: 12345678, user_name: 90210, date: '2026-08-01', type: 'given', amount: 500, comment: 'atta', photo: '' },
    ],
  });
  await openLedger(page, backend);
  await openCustomer(page, 'Numeric Nandu');
  await expect(page.locator('#bal-amt')).toContainText('500');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#dlg-txn')).toBeVisible();      // used to never open
  await page.locator('#txn-amount').fill('600');
  await page.locator('#txn-save').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  await expect(page.locator('#bal-amt')).toContainText('600');
  await expect.poll(() =>
    backend.state.transactions.find((t) => String(t.id) === '12345678').amount).toBe(600);
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-failed')).toBeHidden();
});

test('the direction toggle is edit-only and flips the type in the sheet', async ({ page }) => {
  // Direction is the most-mistapped thing in the app, but the two entry buttons
  // are deliberately frozen — the fix lives in the edit dialog only (audit 1.3).
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('#btn-gave').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await expect(page.locator('#txn-dir')).toBeHidden();     // new entry: no toggle
  await page.locator('#dlg-txn [data-close]').click();
  await expect(page.locator('#dlg-txn')).toBeHidden();

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  await expect(page.locator('#txn-dir')).toBeVisible();    // edit: the toggle appears
  await page.locator('.dir-btn[data-dir="received"]').click();
  await expect(page.locator('#txn-title')).toHaveText('Received');
  await expect(page.locator('.dir-btn[data-dir="received"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.dir-btn[data-dir="given"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#txn-save').click();

  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('#bal-amt')).toContainText('700');  // -500 - 200
  await expect.poll(() => backend.state.transactions.find((t) => t.id === 't1')?.type)
    .toBe('received');
});

test('every save gets a coloured readback — red for diya, green for mila', async ({ page }) => {
  // The only place a red/green mis-tap gets noticed at all (audit 1.3).
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  const toast = page.locator('#toast');

  await addEntry(page, { type: 'given', amount: 250 });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/\bgave\b/);
  await expect(toast).toContainText('diya');
  await expect(toast).toContainText('Ramu');
  await expect(toast).toContainText('550');       // the balance the entry produced

  await addEntry(page, { type: 'received', amount: 50 });
  await expect(toast).toHaveClass(/\bgot\b/);
  await expect(toast).toContainText('mila');
  await expect(toast).toContainText('500');
});

test('double-tap delete removes the entry from the sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await page.locator('.txn-row', { hasText: 'atta' }).click();
  const del = page.locator('#txn-delete');
  await del.click();                     // arms
  await expect(del).not.toHaveText('Delete');
  await del.click();                     // confirms
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});
