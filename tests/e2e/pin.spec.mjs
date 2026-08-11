import { test, expect } from '@playwright/test';
import {
  createBackend, seedLedger, pinHash, REVOKED_TOKEN, MOCK_SHEET_URL,
} from '../mock-backend.mjs';
import {
  openLedger, openCustomer, lsJSON, queueLen, inviteHash, inviteHashFor, OTHER_EXEC, TINY_PNG,
} from './helpers.mjs';

/* Sprint 3 "PIN Suraksha". Two tiers: the Master PIN never leaves the
   merchant's Script Properties and authorizes App-PIN changes server-side;
   the App PIN is 4 digits, verified on-device against the salt+hash that
   rides in `list` — so it works offline, on every phone sharing the khata.

   With a PIN configured it REPLACES the double-tap on six owner-level
   actions. With no PIN (or a pre-Suraksha backend) every one of those paths
   must behave exactly as it did before this sprint. */

const SALT = 'ffee000000000001';
const withPin = (pin) => ({ ...seedLedger(), pin: { salt: SALT, hash: pinHash(SALT, pin) } });

const typePin = async (page, digits) => {
  for (const d of digits) await page.locator(`#pin-grid .pin-key[data-k="${d}"]`).click();
};

const openSettings = async (page) => {
  await page.locator('#btn-settings').click();
  await expect(page.locator('#dlg-settings')).toBeVisible();
};

const openEntry = async (page, text) => {
  await page.locator('.txn-row', { hasText: text }).click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
};

/* ---------- gate off ---------- */

test('with no PIN configured, deleting an entry still takes the double-tap', async ({ page }) => {
  const backend = createBackend(seedLedger());   // v7, pin: null — able, not armed
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');

  const del = page.locator('#txn-delete');
  await del.click();
  await expect(page.locator('#dlg-pin')).toBeHidden();   // nothing to ask for
  await expect(del).toHaveText('Pakka?');
  await del.click();

  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});

/* ---------- setting a PIN ---------- */

test('Suraksha sets an App PIN behind the Master PIN', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openSettings(page);

  await expect(page.locator('#suraksha-note')).toContainText('shared phone');
  await page.locator('#btn-pin-set').click();

  // step 1: the Master PIN — six dots, and it says where to find it
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-sub')).toContainText('Script Properties');
  await expect(page.locator('.pin-dot')).toHaveCount(6);
  await typePin(page, '123456');

  // step 2: the new App PIN, twice
  await expect(page.locator('#pin-title')).toHaveText('Naya App PIN');
  await expect(page.locator('.pin-dot')).toHaveCount(4);
  await typePin(page, '4321');
  await expect(page.locator('#pin-title')).toContainText('dobara');
  await typePin(page, '4321');

  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('App PIN lag gaya');
  // the sheet holds salt+hash of the PIN we typed — never the PIN
  await expect.poll(() => !!backend.state.pin).toBe(true);
  expect(backend.state.pin.hash).toBe(pinHash(backend.state.pin.salt, '4321'));
  // …and this device re-read it, so the section tells the truth immediately
  await expect(page.locator('#suraksha-note')).toHaveText('App PIN laga hai ✓');
  await expect(page.locator('#btn-pin-set')).toBeHidden();
  await expect(page.locator('#btn-pin-change')).toBeVisible();
  await expect(page.locator('#btn-pin-remove')).toBeVisible();

  // the digits are nowhere on this phone: the cache keeps the sheet's salt+hash
  // and nothing else, and no other slot learned either PIN
  const cache = await lsJSON(page, 'bahi.cache');
  expect(Object.keys(cache.pin).sort()).toEqual(['hash', 'salt']);
  expect(cache.pin.hash).toBe(pinHash(cache.pin.salt, '4321'));
  const others = await page.evaluate(() => Object.keys(localStorage)
    .filter((k) => k !== 'bahi.cache')   // the seed's own tokens live in here
    .map((k) => k + '=' + localStorage.getItem(k)).join('\n'));
  expect(others).not.toContain('4321');
  expect(others).not.toContain('123456');
});

test('a mistyped second entry is caught before anything is sent', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openSettings(page);

  await page.locator('#btn-pin-set').click();
  await typePin(page, '123456');
  await typePin(page, '4321');
  await typePin(page, '4322');                            // slip

  await expect(page.locator('#pin-error')).toContainText('alag');
  await expect(page.locator('#dlg-pin')).toBeVisible();    // still asking
  expect(backend.state.log).not.toContain('setTxnPin');

  await typePin(page, '4321');                             // correct this time
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect.poll(() => !!backend.state.pin).toBe(true);
});

test('a wrong Master PIN sets nothing and says where the right one lives', async ({ page }) => {
  const backend = createBackend(seedLedger());   // adminPin is '123456'
  await openLedger(page, backend);
  await openSettings(page);

  await page.locator('#btn-pin-set').click();
  await typePin(page, '999999');
  await typePin(page, '4321');
  await typePin(page, '4321');

  await expect(page.locator('#toast')).toContainText('Master PIN galat hai');
  await expect(page.locator('#toast')).toContainText('Script Properties');
  expect(backend.state.pin).toBe(null);
  await expect(page.locator('#suraksha-note')).toContainText('shared phone');
  await expect(page.locator('#btn-pin-set')).toBeVisible();
});

/* ---------- the gate itself ---------- */

test('a configured PIN replaces the double-tap on entry delete', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');

  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-title')).toHaveText('Entry hatane ke liye PIN');
  await expect(page.locator('#txn-delete')).toHaveText('Delete');   // never armed

  await typePin(page, '9999');
  await expect(page.locator('#pin-error')).toContainText('PIN galat hai');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(1);

  await typePin(page, '1234');
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
  // the post-confirm behaviour is untouched: the undo is still offered
  await expect(page.locator('.toast-act')).toHaveText('WAPAS LAYEIN');
});

test('three wrong PINs lock the pad, with a countdown and a way out', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');

  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await typePin(page, '1111');
  await expect(page.locator('#pin-lock')).toBeHidden();
  await typePin(page, '2222');
  await expect(page.locator('#pin-lock')).toBeHidden();
  await typePin(page, '3333');

  // 30s for the first round, ticking down in the pad
  await expect(page.locator('#pin-lock')).toContainText(/Phir se koshish karein \d+s mein/);
  await expect(page.locator('#pin-grid .pin-key[data-k="1"]')).toBeDisabled();
  await expect(page.locator('#pin-grid .pin-key[data-k="back"]')).toBeDisabled();
  // …and the keys really are dead, not merely greyed: even a synthesized click
  // (which skips the disabled check a real finger cannot) gets nowhere
  for (const d of '1234') await page.locator(`#pin-grid .pin-key[data-k="${d}"]`).dispatchEvent('click');
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('.pin-dot.on')).toHaveCount(0);
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(true);

  // the limiter survives a reload, and the escape hatch stays live
  await expect(page.locator('#pin-forgot')).toBeEnabled();
  const lock = await lsJSON(page, 'bahi.pinlock');
  expect(lock.round).toBe(1);
  expect(lock.until).toBeGreaterThan(Date.now());
  expect(JSON.stringify(lock)).not.toContain('1111');
});

test('one correct PIN covers the next couple of minutes of work', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await typePin(page, '1234');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);

  // second delete inside the window: no pad at all
  await openEntry(page, '200');
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#dlg-txn')).toBeHidden();
  await expect.poll(() => backend.state.transactions.length).toBe(0);
});

test('a device that never set the PIN still has to type it, and adopts a changed one', async ({ page }) => {
  const backend = createBackend(withPin('1234'));   // another phone set it
  await openLedger(page, backend);

  // nothing about the PIN was set up here — it arrived with the first `list`
  const cached = await lsJSON(page, 'bahi.cache');
  expect(cached.pin.hash).toBe(pinHash(SALT, '1234'));

  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await page.locator('#dlg-pin [data-close]').click();
  await expect(page.locator('#dlg-pin')).toBeHidden();

  // the owner changes it on their own phone; this one picks it up on sync
  const salt2 = 'ffee000000000002';
  backend.state.pin = { salt: salt2, hash: pinHash(salt2, '5678') };
  await page.reload();
  await expect.poll(async () => ((await lsJSON(page, 'bahi.cache')).pin || {}).salt).toBe(salt2);

  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await typePin(page, '1234');                       // yesterday's PIN
  await expect(page.locator('#pin-error')).toContainText('PIN galat hai');
  await typePin(page, '5678');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
});

test('the PIN verifies with the network dead — the delete simply queues', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  backend.setMode('down');                          // hash is on-device; nothing to ask anyone
  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await typePin(page, '1234');

  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(true);
  await page.locator('#btn-back').click();
  await expect(page.locator('#chip-pending')).toContainText('1');

  backend.setMode('ok');
  await page.locator('#chip-pending').click();
  await expect(page.locator('#chip-pending')).toBeHidden();
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});

/* ---------- the other five gates ---------- */

test('customer delete and the Connection section ask too', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);

  // Connection <details> — the toggle is intercepted, not the summary's look
  await openSettings(page);
  const conn = page.locator('.settings-conn');
  await page.locator('.settings-conn summary').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-title')).toHaveText('Connection kholne ke liye PIN');
  await expect(conn).not.toHaveAttribute('open', '');
  await typePin(page, '1234');
  await expect(conn).toHaveAttribute('open', '');
  await page.locator('#dlg-settings [data-close]').click();

  // customer delete — a fresh page, so the grace window is not doing the work
  await page.reload();
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#dlg-customer')).toBeVisible();
  await page.locator('#cust-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-title')).toHaveText('Customer hatane ke liye PIN');
  await expect(page.locator('#cust-delete')).toHaveText('Delete');   // never armed
  await typePin(page, '1234');
  await expect(page.locator('#screen-home')).toBeVisible();
  await expect.poll(() => backend.state.users.some((u) => u.user_id === 'u1')).toBe(false);
});

test('the invite link asks for the PIN before it is ever copied', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
    });
  });
  await openLedger(page, backend);
  await openSettings(page);

  await page.locator('#btn-invite').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-title')).toHaveText('Link copy karne ke liye PIN');
  expect(await page.evaluate(() => window.__copied.length)).toBe(0);

  await page.locator('#dlg-pin [data-close]').click();
  expect(await page.evaluate(() => window.__copied.length)).toBe(0);   // cancel copies nothing

  await page.locator('#btn-invite').click();
  await typePin(page, '1234');
  await expect(page.locator('#toast')).toContainText('Link copy ho gaya');
  expect(await page.evaluate(() => window.__copied[0])).toContain('#s=');
});

test('removing a bill photo asks, and still only marks the form', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  backend.state.transactions.push({
    id: 'tp1', user_name: 'u1', date: '2026-08-06',
    type: 'given', amount: 77, comment: 'photo wala', photo: 'ph1',
  });
  backend.state.photos.ph1 = TINY_PNG.toString('base64');
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');

  await openEntry(page, 'photo wala');
  await page.locator('#txn-photo-view').click();
  await expect(page.locator('#dlg-photo')).toBeVisible();
  await page.locator('#photo-remove').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await expect(page.locator('#pin-title')).toHaveText('Photo hatane ke liye PIN');
  await typePin(page, '1234');

  // unchanged post-confirm behaviour: the viewer closes, the form says so, and
  // the photo only really goes when the entry is saved
  await expect(page.locator('#dlg-photo')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('entry save karein');
  await expect(page.locator('#txn-photo-label')).toHaveText('Add photo');
  expect(backend.state.transactions.find((t) => t.id === 'tp1').photo).toBe('ph1');

  await page.locator('#txn-save').click();
  await expect.poll(() => backend.state.transactions.find((t) => t.id === 'tp1').photo).toBe('');
});

test('"PIN bhool gaye?" hands the locked-out owner over to the Master PIN', async ({ page }) => {
  const backend = createBackend(withPin('1234'));
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');

  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await page.locator('#pin-forgot').click();

  // the delete is abandoned; the reset flow takes the sheet over
  await expect(page.locator('#pin-title')).toHaveText('Master PIN daalein');
  await expect(page.locator('.pin-dot')).toHaveCount(6);
  await typePin(page, '123456');
  await typePin(page, '5678');
  await typePin(page, '5678');
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('App PIN lag gaya');
  expect(backend.state.transactions.some((t) => t.id === 't1')).toBe(true);

  // the new PIN is what the gate wants now — and the reset did not leave a
  // grace window behind for the delete that was abandoned
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await typePin(page, '5678');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
});

test('the grace window does not follow the phone into another khata', async ({ page }) => {
  const a = createBackend(withPin('1234'));
  const b = createBackend({
    key: 'otherkey', url: OTHER_EXEC,
    users: [{ user_id: 'z1', name: 'Naya Khata Wala', created_at: '2026-08-01', phone: '', token: '' }],
    transactions: [{ id: 'z9', user_name: 'z1', date: '2026-08-02', type: 'given', amount: 700, comment: 'naya', photo: '' }],
    pin: { salt: SALT, hash: pinHash(SALT, '5678') },
  });
  await a.install(page, { only: true });
  await b.install(page, { only: true });
  await page.goto('/' + inviteHash(a));

  // buy a grace window in khata A…
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await typePin(page, '1234');
  await expect(page.locator('.txn-row', { hasText: 'atta' })).toHaveCount(0);
  await page.locator('#btn-back').click();
  await expect.poll(() => queueLen(page)).toBe(0);

  /* …then switch this phone's khata underneath it, WITHOUT a reload — an
     invite tapped while the app is already open is same-document navigation,
     which is the only path where the old ledger's grace window is still in
     memory to leak. */
  await page.evaluate((h) => { location.hash = h; }, inviteHashFor(OTHER_EXEC, 'otherkey'));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();
  await openCustomer(page, 'Naya Khata Wala');

  // A's PIN bought nothing here — B asks, in B's own PIN
  await openEntry(page, 'naya');
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeVisible();
  await typePin(page, '1234');
  await expect(page.locator('#pin-error')).toContainText('PIN galat hai');
  await typePin(page, '5678');
  await expect(page.locator('.txn-row', { hasText: 'naya' })).toHaveCount(0);
});

/* ---------- older backends, and the merchant's own sheet ---------- */

test('a pre-Suraksha backend asks for an update and leaves the double-tap alone', async ({ page }) => {
  const backend = createBackend({ ...seedLedger(), v: 6 });   // no pin/sheetUrl in `list`
  await openLedger(page, backend);
  await openSettings(page);

  await expect(page.locator('#suraksha-note')).toHaveText('Backend update chahiye — PIN ke liye');
  await expect(page.locator('#btn-pin-set')).toBeHidden();
  await expect(page.locator('#btn-pin-change')).toBeHidden();
  await expect(page.locator('#btn-pin-remove')).toBeHidden();
  await expect(page.locator('#btn-sheet')).toBeHidden();
  await page.locator('#dlg-settings [data-close]').click();

  // …and every gated path is exactly what it was before Suraksha
  await openCustomer(page, 'Ramu Halwai');
  await openEntry(page, 'atta');
  await page.locator('#txn-delete').click();
  await expect(page.locator('#dlg-pin')).toBeHidden();
  await expect(page.locator('#txn-delete')).toHaveText('Pakka?');
  await page.locator('#txn-delete').click();
  await expect.poll(() => backend.state.transactions.some((t) => t.id === 't1')).toBe(false);
});

test('Settings opens the merchant own Google Sheet', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await openSettings(page);

  const sheet = page.locator('#btn-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('href', MOCK_SHEET_URL);
  await expect(sheet).toHaveAttribute('target', '_blank');
});

/* ---------- revoked passbook token ---------- */

test('a revoked passbook token offers no link to copy', async ({ page }) => {
  const seed = seedLedger();
  seed.users[0].token = REVOKED_TOKEN;   // the owner turned this one off
  const backend = createBackend(seed);
  await openLedger(page, backend);

  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#dlg-customer')).toBeVisible();
  await expect(page.locator('#cust-passbook-wrap')).toBeHidden();
  await page.locator('#dlg-customer [data-close]').click();

  // the control: a customer with a live token still gets one
  await page.locator('#btn-back').click();
  await openCustomer(page, 'Sunita Tailor');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-passbook-wrap')).toBeVisible();
});
