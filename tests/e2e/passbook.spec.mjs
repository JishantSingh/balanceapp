import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { passbookHash, openLedger, b64url, lsJSON } from './helpers.mjs';

async function expectNoOwnerShortcut(page) {
  await expect(page.locator('#pb-mine')).toHaveCount(0);
  await expect(page.locator('#pb-mine-go')).toHaveCount(0);
  await expect(page.locator('#screen-passbook').getByRole('button')).toHaveCount(0);
}

test('passbook link renders name, balance, and history — and only safe fields', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_ramu_1234567890'));

  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expect(page.locator('#pb-amt')).toContainText('300');
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(2);

  // the customer must never see phone numbers, tokens, or other customers
  const html = await page.content();
  expect(html).not.toContain('9876500001');
  expect(html).not.toContain('tok_ramu');
  expect(html).not.toContain('Sunita');
});

test('a revoked/invalid passbook token shows an error, not a ledger', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_gone_1234567890'));
  await expect(page.locator('#pb-status')).toContainText(/no longer valid/i);
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
});

test("a demo passbook link must not invent a ledger on a stranger's phone", async ({ page }) => {
  // #p={d:…} reads the demo store on THIS device. It used to seed one when
  // none existed — showing invented customers and amounts, on a phone that
  // has never opened the demo, as if they were somebody's real khata.
  await page.goto('/');
  await page.goto('/#p=' + b64url({ d: 'demo0001' }));
  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-status')).toContainText(/no longer valid/i);
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
  await expect(page.locator('#pb-name')).toHaveText('…');   // no fabricated customer
  await expect(page.locator('#pb-amt')).toHaveText('…');
});

test('a passbook on a connected owner browser has no owner-return shortcut, including after reload', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);                     // this phone holds a real ledger
  const savedConfig = await lsJSON(page, 'bahi.config');
  const savedCache = await lsJSON(page, 'bahi.cache');
  await page.goto('/?pb=1' + passbookHash('tok_ramu_1234567890'));

  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
  await expect(page.locator('#screen-home')).toBeHidden();
  await page.reload();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
  expect(page.url()).toContain('#p=');
  expect(await lsJSON(page, 'bahi.config')).toEqual(savedConfig);
  expect(await lsJSON(page, 'bahi.cache')).toEqual(savedCache);

  // Deliberately NOT an owner-app lock: opening the normal app still uses
  // this browser's existing connection. Do not erase it or claim isolation.
  await page.goto('/');
  await expect(page.locator('#screen-home')).toBeVisible();
  await expect(page.locator('.customer-row', { hasText: 'Ramu Halwai' })).toBeVisible();
});

test('a passbook on a phone with no khata offers no way in', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_ramu_1234567890'));
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
  // The token stays in the URL: it is the customer's only way back in on
  // reload (scoped + revocable, unlike the invite key which is stripped).
  expect(page.url()).toContain('#p=');
  await page.reload();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
});

test('same-document passbook navigation has no owner shortcut or ledger mutations', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.evaluate(hash => { location.hash = hash; }, passbookHash('tok_ramu_1234567890'));
  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
  expect(backend.state.log.every(action => action === 'list' || action === 'passbook')).toBe(true);
});

test('an invalid passbook with a saved owner connection stays on the error without an owner shortcut', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.goto('/' + passbookHash('tok_gone_1234567890'));
  await expect(page.locator('#pb-status')).toContainText(/no longer valid/i);
  await expect(page.locator('#screen-home')).toBeHidden();
  await expectNoOwnerShortcut(page);
});

const legacyMarkup = '<p id="pb-mine" class="pb-mine" hidden><button type="button" id="pb-mine-go">Yeh mera ledger hai — kholein</button></p>';
const pageHtml = () => readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
const withLegacyMarkup = html => html.replace(/<span id="pb-mine"[^>]*><span id="pb-mine-go"><\/span><\/span>/, legacyMarkup);

test('new JS removes the shortcut from cached old HTML without breaking startup', async ({ page }) => {
  await page.route('http://localhost:4173/', route => route.fulfill({ contentType: 'text/html', body: withLegacyMarkup(pageHtml()) }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const backend = createBackend(seedLedger());
  await backend.install(page);
  await page.goto('/' + passbookHash('tok_ramu_1234567890'));
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expectNoOwnerShortcut(page);
  expect(errors).toEqual([]);
});

for (const cachedHtml of [false, true]) {
  test(`stale JS cannot expose the retired shortcut with ${cachedHtml ? 'old HTML and new CSS' : 'new HTML and old CSS'}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (cachedHtml) {
      await page.route('http://localhost:4173/', route => route.fulfill({ contentType: 'text/html', body: withLegacyMarkup(pageHtml()) }));
    } else {
      const oldCss = readFileSync(new URL('../../docs/styles.css', import.meta.url), 'utf8')
        .replace('#pb-mine { display: none !important; }', '.pb-mine { text-align: center; margin-top: 20px; }');
      await page.route('**/styles.css', route => route.fulfill({ contentType: 'text/css', body: oldCss }));
    }
    // Replay the precise DOM operations pre-v28 code performed at startup
    // and when opening a passbook, without keeping a full old app snapshot.
    await page.route('**/app.js', route => route.fulfill({ contentType: 'application/javascript', body: `
      document.getElementById('pb-mine-go').addEventListener('click', () => {});
      document.getElementById('screen-passbook').hidden = false;
      document.getElementById('pb-mine').hidden = false;
    ` }));
    await page.goto('/');
    await expect(page.locator('#screen-passbook')).toBeVisible();
    await expect(page.locator('#pb-mine')).toBeHidden();
    await expect(page.locator('#screen-passbook').getByRole('button')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
