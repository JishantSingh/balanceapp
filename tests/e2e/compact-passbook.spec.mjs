import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createBackend, seedLedger, MOCK_EXEC } from '../mock-backend.mjs';
import { openLedger, openCustomer, passbookHash, b64url, stubClipboard, decodePassbookLink } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });
const compact = token => '/p/#MOCKDEPLOY.' + encodeURIComponent(token);
const originalToken = 'tok_ramu_1234567890';

async function ready(page, backend, link = compact(originalToken)) {
  await backend.install(page);
  await page.goto(link);
  await expect(page.locator('#pb-name')).toHaveText(backend.state.users[0].name);
}

test('compact links keep the entire deployment ID and token with no registry or owner key', async ({ page }) => {
  await page.goto('/p/');
  const example = await page.evaluate(() => {
    const deployment = 'A'.repeat(74);
    const token = '0123456789abcdef';
    const backend = 'https://script.google.com/macros/s/' + deployment + '/exec';
    const pageUrl = 'https://jishantsingh.github.io/balanceapp/';
    const link = BahiPassbook.createLink(pageUrl, backend, token);
    return { link, parsed: BahiPassbook.parseHash(new URL(link).hash), backend, token,
      legacyLength: (pageUrl + '#p=' + btoa(JSON.stringify({ u: backend, t: token })).replace(/=+$/, '')).length };
  });
  expect(example.link.length).toBe(136);
  expect(example.legacyLength).toBe(239);
  expect(example.parsed).toEqual({ u: example.backend, t: example.token });
  expect(example.link).not.toContain('key');
});

test('opaque customer tokens round-trip without truncation, including URL punctuation and Unicode', async ({ page }) => {
  await page.goto('/p/');
  const tokens = ['0123456789abcdef', 'Mixed_CASE-token_123456', 'token.with.periods123', 'abc#?/&%=+ 123456', 'ग्राहक-ä-123456789'];
  const results = await page.evaluate(({ tokens, backend }) => tokens.map(token => {
    const link = BahiPassbook.createLink(location.href.replace('/p/', '/'), backend, token);
    return BahiPassbook.parseHash(new URL(link).hash);
  }), { tokens, backend: MOCK_EXEC });
  expect(results).toEqual(tokens.map(t => ({ u: MOCK_EXEC, t })));
});

test('copied compact link opens the real reader and survives reload', async ({ page }, testInfo) => {
  const backend = createBackend(seedLedger());
  await stubClipboard(page);
  await openLedger(page, backend);
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#cust-head-main').click();
  await page.locator('#cust-passbook').click();
  const link = await page.evaluate(() => window.__copied.at(-1));
  expect(decodePassbookLink(link)).toEqual({ u: MOCK_EXEC, t: originalToken });
  await page.goto(link);
  await expect(page.locator('#pb-name')).toHaveText('Ramu Halwai');
  await expect(page.locator('#pb-amt')).toHaveText('₹300');
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(2);
  await expect(page.locator('#screen-home')).toHaveCount(0);
  await expect(page.locator('#pb-mine-go')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('compact-passbook.png'), animations: 'disabled' });
  await page.reload();
  await expect(page.locator('#pb-amt')).toHaveText('₹300');
  expect(page.url()).toBe(link);
});

test('reader never loads owner scripts, reads/writes browser storage, or sends credentials', async ({ page }) => {
  const backend = createBackend(seedLedger());
  const requested = [];
  const posts = [];
  page.on('request', req => {
    requested.push(req.url());
    if (req.method() === 'POST') posts.push(req.postDataJSON());
  });
  await page.addInitScript(() => {
    localStorage.setItem('bahi.config', JSON.stringify({ key: 'PRIVATE_OWNER_KEY', url: 'https://not-used.invalid' }));
    localStorage.setItem('bahi.cache', JSON.stringify({ users: [{ name: 'PRIVATE_OTHER_CUSTOMER' }] }));
    localStorage.setItem('bahi.queue', JSON.stringify([{ action: 'deleteUser', payload: { id: 'PRIVATE_USER' } }]));
    window.storageAccesses = [];
    for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      Storage.prototype[method] = function() { window.storageAccesses.push(method); throw new Error('Owner storage must not be touched'); };
    }
    const fetchOriginal = window.fetch;
    window.passbookFetchOptions = [];
    window.fetch = (url, options) => { window.passbookFetchOptions.push({ credentials: options?.credentials, cache: options?.cache, referrerPolicy: options?.referrerPolicy }); return fetchOriginal(url, options); };
  });
  await ready(page, backend);
  expect(await page.evaluate(() => window.storageAccesses)).toEqual([]);
  expect(posts).toEqual([{ action: 'passbook', token: originalToken }]);
  expect(requested.some(url => /\/(?:app|balance-card)\.js/.test(url))).toBe(false);
  expect(requested.some(url => url.includes(originalToken))).toBe(false); // fragment is not sent in requests
  expect(JSON.stringify(posts)).not.toContain('PRIVATE');
  expect(await page.content()).not.toContain('PRIVATE');
  expect(await page.evaluate(() => window.passbookFetchOptions)).toEqual([{ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
  expect(backend.state.log).toEqual(['passbook']);
  await expect(page.locator('button, input, form')).toHaveCount(0);
});

for (const hash of ['', '#garbage', '#MISSINGTOKEN.', '#.tok_1234567890', '#MOCKDEPLOY.%ZZ', '#MOCKDEPLOY.off', '#s=owner-invite', '#p9=future-version']) {
  test(`invalid compact link ${hash || '(empty)'} shows an error, never an owner screen`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('bahi.config', JSON.stringify({ key: 'saved-owner-key' }));
      localStorage.setItem('bahi.cache', JSON.stringify({ users: [{ name: 'Hidden owner customer' }] }));
    });
    const backend = createBackend(seedLedger());
    await backend.install(page);
    await page.goto('/p/' + hash);
    await expect(page.locator('#pb-status')).toContainText('Invalid passbook link');
    await expect(page.locator('#pb-name')).toHaveText('…');
    await expect(page.locator('#screen-home, #screen-connect, #pb-mine-go')).toHaveCount(0);
    expect(backend.state.log).toEqual([]);
  });
}

test('legacy links still load in the owner entry point and in the new reader', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  for (const prefix of ['/', '/p/']) {
    await page.goto(prefix + passbookHash(originalToken));
    await expect(page.locator('#pb-amt')).toHaveText('₹300');
    await expect(page.locator('#pb-list .txn-row')).toHaveCount(2);
    expect(page.url()).toContain('#p=');
  }
});

test('legacy nonstandard backend URLs keep the full URL instead of losing query parameters', async ({ page }) => {
  await openLedger(page, createBackend(seedLedger()));
  const result = await page.evaluate(() => {
    config.url += '?custom=keep-me';
    const link = passbookLink(db.users[0]);
    return { link, parsed: BahiPassbook.parseHash(new URL(link).hash), url: config.url };
  });
  expect(result.link).toContain('#p=');
  expect(result.parsed).toEqual({ u: result.url, t: originalToken });
});

test('old HTML without the codec falls back to long links and dynamically loads the legacy reader', async ({ page }) => {
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8').replace('<script src="passbook.js"></script>', '');
  await page.route('http://localhost:4173/', route => route.fulfill({ contentType: 'text/html', body: html }));
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  const link = await page.evaluate(() => passbookLink(db.users[0]));
  expect(link).toContain('#p=');
  await page.goto(link);
  await expect(page.locator('#pb-amt')).toHaveText('₹300');
});

test('invalid/revoked/newer-version legacy hashes fail closed even with a saved owner connection', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  for (const hash of ['#p', '#p=broken', '#p2=unknown', passbookHash('tok_gone_1234567890')]) {
    await page.goto('/' + hash);
    await expect(page.locator('#pb-status')).toBeVisible();
    await expect(page.locator('#pb-status')).not.toContainText('Loading');
    await expect(page.locator('#screen-home')).toBeHidden();
    await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
  }
});

test('untrusted legacy destinations and owner invite payloads cannot make reader requests', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await backend.install(page);
  const requests = [];
  page.on('request', req => { if (req.method() === 'POST') requests.push(req.url()); });
  for (const payload of [
    { u: 'https://script.google.com.evil.invalid/exec', t: originalToken },
    { u: 'http://script.google.com/macros/s/MOCKDEPLOY/exec', t: originalToken },
    { u: 'https://name:password@script.google.com/macros/s/MOCKDEPLOY/exec', t: originalToken },
    { u: MOCK_EXEC, k: 'owner-secret-not-a-customer-token' },
  ]) {
    await page.goto('/p/#p=' + b64url(payload));
    await expect(page.locator('#pb-status')).toContainText('Invalid passbook link');
    await expect(page.locator('#screen-home')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
});

test('a missing reader asset shows a read-only reload message, not the owner application', async ({ page }) => {
  await page.route('**/passbook.js', route => route.abort());
  await page.goto(compact(originalToken));
  await expect(page.locator('#pb-status')).toContainText('Please refresh this page');
  await expect(page.locator('#screen-home, #screen-connect, button, input')).toHaveCount(0);
});

test('changing to invalid/revoked links clears the previous customer, and late replies cannot return', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await ready(page, backend);
  const release = backend.hold();
  await page.evaluate(() => { location.hash = '#MOCKDEPLOY.tok_sunita_123456789'; });
  await expect(page.locator('#pb-name')).toHaveText('…');
  await page.evaluate(() => { location.hash = '#invalid'; });
  await expect(page.locator('#pb-status')).toContainText('Invalid passbook link');
  release();
  await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
  await expect(page.locator('#pb-name')).toHaveText('…');
  await page.evaluate(() => { location.hash = '#MOCKDEPLOY.tok_gone_1234567890'; });
  await expect(page.locator('#pb-status')).toContainText('no longer valid');
  await expect(page.locator('#pb-name')).toHaveText('…');
});

test('offline and malformed backend replies show errors without using an owner cache', async ({ page }) => {
  const backend = createBackend(seedLedger());
  await ready(page, backend);
  for (const mode of ['down', 'html']) {
    backend.setMode(mode);
    await page.reload();
    await expect(page.locator('#pb-status')).toBeVisible();
    await expect(page.locator('#pb-status')).toContainText(mode === 'down' ? 'Could not reach' : 'invalid response');
    await expect(page.locator('#pb-list .txn-row')).toHaveCount(0);
    await expect(page.locator('#pb-amt')).toHaveText('…');
  }
});

test('an unresponsive backend times out; reloading can recover', async ({ page }) => {
  await page.clock.install();
  const backend = createBackend(seedLedger());
  await backend.install(page);
  const release = backend.hold();
  await page.goto(compact(originalToken));
  await expect.poll(() => backend.state.requests.length).toBeGreaterThan(0);
  await page.clock.fastForward(31000);
  await expect(page.locator('#pb-status')).toContainText('took too long');
  release();
  await page.reload();
  await expect(page.locator('#pb-amt')).toHaveText('₹300');
});

test('read-only data remains correctly formatted and markup-safe at phone widths', async ({ page }, testInfo) => {
  const seed = seedLedger();
  seed.users[0].name = 'Ramu Halwai <script>unsafe</script>';
  seed.transactions[0].comment = '<img src=x onerror="window.injected=true"> चावल';
  seed.transactions[0].amount = 1234567.89;
  seed.transactions[1].date = '05/08/2026';
  await ready(page, createBackend(seed));
  await expect(page.locator('#pb-amt')).toHaveText('₹12,34,367.89');
  await expect(page.locator('.txn-note').first()).toHaveText(seed.transactions[0].comment);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`compact-passbook-${width}-${colorScheme}.png`), animations: 'disabled' });
    }
  }
});
