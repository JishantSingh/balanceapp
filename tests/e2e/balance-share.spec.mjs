import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createBackend, seedLedger, pinHash } from '../mock-backend.mjs';
import { openLedger, openCustomer, addEntry, queueLen, stubClipboard, b64url, lsJSON, OTHER_EXEC } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata' });

async function sharingHarness(page, options = {}) {
  await page.clock.setFixedTime(new Date('2026-09-14T10:30:00+05:30'));
  await stubClipboard(page);
  await page.addInitScript(() => {
    window.shareCalls = []; window.shareMode = 'ok'; window.fileSharing = true;
    window.cardText = []; window.createdCardUrls = []; window.revokedCardUrls = []; window.openedChats = [];
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      if (this.canvas.width === 1080 && this.canvas.height === 710) {
        window.cardText.push({ text, x, y, color: this.fillStyle, width: this.measureText(text).width });
      }
      return draw.call(this, text, x, y, ...args);
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.createdCardUrls.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedCardUrls.push(url); revoke(url); };
    window.open = (...args) => { window.openedChats.push(args); return null; };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: data =>
      window.fileSharing && data.files?.length === 1 && data.files[0] instanceof File });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
      const file = data.files[0];
      const call = { text: data.text, name: file.name, type: file.type, size: file.size,
        userActivated: navigator.userActivation.isActive };
      window.shareCalls.push(call);
      const bytes = new Uint8Array(await file.arrayBuffer());
      call.signature = [...bytes.slice(0, 8)];
      const bitmap = await createImageBitmap(file);
      call.width = bitmap.width; call.height = bitmap.height; bitmap.close();
      if (window.shareMode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
      if (window.shareMode === 'error') throw new DOMException('Sharing failed', 'NotAllowedError');
      if (window.shareMode === 'hold') await new Promise(resolve => { window.finishShare = resolve; });
    } });
  });
  const seed = seedLedger();
  seed.pin = { salt: 'share-pin-salt', hash: pinHash('share-pin-salt', '1234') };
  seed.users[0].name = options.customerName || 'Ramesh Kumar';
  seed.users[0].phone = options.phone === undefined ? '9876500001' : options.phone;
  if (options.token !== undefined) seed.users[0].token = options.token;
  const balance = options.balance ?? 12500;
  seed.transactions = balance === 0 ? [] : [{ id: 't1', user_name: 'u1', date: '2026-09-14',
    type: balance < 0 ? 'received' : 'given', amount: Math.abs(balance), comment: 'sample', photo: '' }];
  const backend = createBackend(seed);
  await openLedger(page, backend);
  await page.locator('#btn-settings').click();
  await page.locator('#set-merchant').fill(options.merchant || 'Sharma Kirana Store');
  if (options.template !== undefined) await page.locator('#set-template').fill(options.template);
  if (options.creditTemplate !== undefined) await page.locator('#set-credit-template').fill(options.creditTemplate);
  if (options.currency) await page.locator('#set-currency').fill(options.currency);
  await page.locator('#form-settings button[type=submit]').click();
  await openCustomer(page, seed.users[0].name);
  return backend;
}
async function readyCard(page) {
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-ready')).toBeVisible();
  await expect(page.locator('#balance-share-native')).toBeEnabled();
}

for (const [direction, balance, label, color] of [
  ['red', 12500, 'Aapka baki', '#d93025'], ['green', -12500, 'Aapko milenge', '#188038'],
]) {
  test(`${direction} card is a real PNG with matching text, color and safe native share payload`, async ({ page }, testInfo) => {
    const backend = await sharingHarness(page, { balance });
    const before = JSON.stringify(backend.state.transactions);
    const readsBefore = backend.state.log.filter(a => a === 'list').length;
    await readyCard(page);
    expect(backend.state.log.filter(a => a === 'list').length).toBeGreaterThan(readsBefore);
    const drawn = await page.evaluate(() => window.cardText);
    expect(drawn.find(p => p.text === label)?.color).toBe(color);
    expect(drawn.find(p => p.text === '₹12,500')?.color).toBe(color);
    expect(drawn.some(p => p.text === '14 Sep 2026 ka hisaab')).toBe(true);
    expect(drawn.some(p => /Payment reminder|bhugtan|Dhanyavaad|https?:/.test(p.text))).toBe(false);
    const message = await page.locator('#balance-share-message').textContent();
    expect(message).toContain('₹12,500');
    expect(message).toContain('/p/#MOCKDEPLOY.');
    expect(message).not.toContain('#s=');
    expect(message).not.toContain(backend.state.key);
    if (balance < 0) { expect(message).toContain('aapko ₹12,500 milenge'); expect(message).not.toContain('bhugtan'); }
    else expect(message).toContain('bhugtan');
    await expect(page.locator('#toast')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(direction + '-initial-preview.png'), animations: 'disabled' });
    await page.locator('#balance-share-native').click();
    await expect.poll(() => page.evaluate(() => window.shareCalls[0]?.width)).toBe(1080);
    const call = await page.evaluate(() => window.shareCalls[0]);
    expect(call).toMatchObject({ type: 'image/png', width: 1080, height: 710, text: message, userActivated: true,
      signature: [137, 80, 78, 71, 13, 10, 26, 10] });
    expect(call.size).toBeGreaterThan(1000);
    expect(JSON.stringify(backend.state.transactions)).toBe(before);
    expect(backend.state.log.every(action => action === 'list')).toBe(true);
    await expect(page.locator('#dlg-pin')).toBeHidden();
    await expect(page.locator('#toast')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(direction + '-preview.png'), animations: 'disabled' });
    await page.locator('#dlg-balance-share button[type=submit]').click();
    await expect.poll(() => page.evaluate(() => window.revokedCardUrls)).toEqual(await page.evaluate(() => window.createdCardUrls));
  });
}

test('no phone is needed for an image; text-only opens the known customer chat when available', async ({ page }) => {
  const backend = await sharingHarness(page, { phone: '' });
  await readyCard(page);
  await expect(page.locator('#balance-share-text')).toBeDisabled();
  await page.locator('#balance-share-copy').click();
  expect(await page.evaluate(() => window.__copied[0])).toContain('₹12,500');
  await page.locator('#dlg-balance-share button[type=submit]').click();
  backend.state.users[0].phone = '9876500001';
  await readyCard(page);
  await page.locator('#balance-share-text').click();
  const opened = await page.evaluate(() => window.openedChats[0]);
  expect(opened[0]).toMatch(/^https:\/\/wa.me\/919876500001\?text=/);
  expect(new URL(opened[0]).searchParams.get('text')).toBe(await page.locator('#balance-share-message').textContent());
  expect(opened[2]).toBe('noopener,noreferrer');
});

test('zero balances are hidden and a newly settled server balance prevents export', async ({ page }) => {
  const backend = await sharingHarness(page, { balance: 0 });
  await expect(page.locator('#btn-remind')).toBeHidden();
  backend.state.transactions.push({ id: 't1', user_name: 'u1', amount: 10, type: 'given', date: '2026-09-14' });
  await page.evaluate(() => refresh(true));
  await expect(page.locator('#btn-remind')).toBeVisible();
  backend.state.transactions = [];
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toHaveText('No outstanding balance.');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('unsupported native sharing keeps download and copy fallbacks', async ({ page }) => {
  await sharingHarness(page);
  await page.evaluate(() => { window.fileSharing = false; });
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-ready')).toBeVisible();
  await expect(page.locator('#balance-share-native')).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.locator('#balance-share-download').click();
  expect((await download).suggestedFilename()).toMatch(/^bahi-balance-\d{4}-\d{2}-\d{2}\.png$/);
  await page.locator('#balance-share-copy').click();
  expect(await page.evaluate(() => window.__copied)).toEqual([await page.locator('#balance-share-message').textContent()]);
});

test('share cancellation is quiet, errors allow retry, and repeated taps cannot open two share menus', async ({ page }) => {
  await sharingHarness(page);
  await readyCard(page);
  await page.evaluate(() => { window.shareMode = 'hold'; });
  await page.locator('#balance-share-native').click();
  await expect(page.locator('#balance-share-native')).toBeDisabled();
  await page.locator('#balance-share-native').evaluate(el => el.click());
  expect(await page.evaluate(() => window.shareCalls.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => typeof window.finishShare)).toBe('function');
  await page.evaluate(() => window.finishShare());
  await expect(page.locator('#balance-share-native')).toBeEnabled();
  await page.evaluate(() => { window.shareMode = 'cancel'; });
  await page.locator('#balance-share-native').click();
  await expect(page.locator('#balance-share-native')).toBeEnabled();
  await expect(page.locator('#balance-share-status')).toContainText('Review');
  await page.evaluate(() => { window.shareMode = 'error'; });
  await page.locator('#balance-share-native').click();
  await expect(page.locator('#balance-share-status')).toContainText('Could not open sharing');
  await expect(page.locator('#balance-share-download')).toBeEnabled();
  await expect(page.locator('#balance-share-ready')).toBeVisible();
});

for (const mode of ['down', 'badkey', 'html']) {
  test(`a ${mode} refresh cannot export cached balance data`, async ({ page }) => {
    const backend = await sharingHarness(page);
    backend.setMode(mode);
    await page.locator('#btn-remind').click();
    await expect(page.locator('#balance-share-status')).toContainText('Could not prepare balance');
    await expect(page.locator('#balance-share-ready')).toBeHidden();
    expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
    backend.setMode('ok');
    await page.locator('#balance-share-retry').click();
    await expect(page.locator('#balance-share-native')).toBeEnabled();
  });
}

test('revoked passbook links are omitted and owner credentials in custom text block export', async ({ page }) => {
  await sharingHarness(page, { token: 'off', template: 'Hello {name}\nLedger: {passbook}\nDue {amount}' });
  await readyCard(page);
  await expect(page.locator('#balance-share-message')).toHaveText('Hello Ramesh Kumar\nDue ₹12,500');
  await page.locator('#dlg-balance-share button[type=submit]').click();
  await page.evaluate(() => { config.template = 'Secret ' + config.key; });
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Remove the owner invite link or API key');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  await page.evaluate(() => { config.template = inviteLink(); });
  await page.locator('#balance-share-retry').click();
  await expect(page.locator('#balance-share-status')).toContainText('Remove the owner invite link or API key');
});

test('a changed balance invalidates the prepared image and releases its URL', async ({ page }) => {
  const backend = await sharingHarness(page);
  await readyCard(page);
  backend.state.transactions[0].amount = 13000;
  await page.evaluate(() => refresh(true));
  await expect(page.locator('#balance-share-status')).toContainText('details changed');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  expect(await page.evaluate(() => window.revokedCardUrls)).toEqual(await page.evaluate(() => window.createdCardUrls));
  await page.locator('#balance-share-retry').click();
  await expect(page.locator('#balance-share-native')).toBeEnabled();
  await expect(page.locator('#balance-share-message')).toContainText('₹13,000');
});

test('long names wrap and a large decimal amount uses the configured currency without clipping', async ({ page }) => {
  await sharingHarness(page, { merchant: 'Sharma Kirana and Wholesale General Store',
    customerName: 'Ramesh Kumar and Family Trading Account', balance: -123456789.45, currency: '$' });
  await readyCard(page);
  const texts = await page.evaluate(() => window.cardText);
  const amount = texts.find(p => p.text === '$12,34,56,789.45');
  expect(amount.color).toBe('#188038');
  expect(amount.width).toBeLessThanOrEqual(920);
  expect(texts.filter(p => p.y === 58 || p.y === 112).length).toBe(2);
  await expect(page.locator('#balance-share-message')).toContainText('$12,34,56,789.45');
});

test('both custom templates survive reload and a same-ledger credential refresh', async ({ page }) => {
  const red = 'PAY {name}: {amount} at {merchant}\n{passbook}';
  const green = 'CREDIT {name}: {amount} at {merchant}\n{passbook}';
  const backend = await sharingHarness(page, { balance: -45, template: red, creditTemplate: green });
  await readyCard(page);
  await expect(page.locator('#balance-share-message')).toContainText('CREDIT Ramesh Kumar: ₹45 at Sharma Kirana Store');
  await page.reload();
  const newKey = 'rotated-share-test-key';
  backend.state.key = newKey;
  await page.evaluate(hash => { location.hash = hash; }, '#s=' + b64url({ u: backend.state.url, k: newKey }));
  await expect.poll(async () => (await lsJSON(page, 'bahi.config'))?.key).toBe(newKey);
  const config = await lsJSON(page, 'bahi.config');
  expect(config.template).toBe(red); expect(config.creditTemplate).toBe(green);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#set-template')).toHaveValue(red);
  await expect(page.locator('#set-credit-template')).toHaveValue(green);
});

test('pending financial entries sync before the fresh balance is rendered', async ({ page }) => {
  const backend = await sharingHarness(page);
  backend.setMode('down');
  await addEntry(page, { amount: 50, note: 'queued before sharing' });
  await expect.poll(() => queueLen(page)).toBe(1);
  backend.setMode('ok');
  await readyCard(page);
  await expect(page.locator('#balance-share-message')).toContainText('₹12,550');
  expect(await queueLen(page)).toBe(0);
  expect(backend.state.transactions.filter(t => t.comment === 'queued before sharing')).toHaveLength(1);
  expect(backend.state.log.filter(a => a === 'addTxn')).toHaveLength(1);
});

test('failed financial work blocks sharing without retrying or discarding it', async ({ page }) => {
  const backend = await sharingHarness(page);
  backend.setMode('badkey');
  await addEntry(page, { amount: 50, note: 'refused before sharing' });
  await expect.poll(async () => (await lsJSON(page, 'bahi.failed'))?.length).toBe(1);
  backend.setMode('ok');
  const failures = await lsJSON(page, 'bahi.failed');
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Resolve failed financial changes');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  expect(await lsJSON(page, 'bahi.failed')).toEqual(failures);
});

test('a pending photo-only queue does not block a fresh balance card', async ({ page }) => {
  await sharingHarness(page);
  await page.evaluate(() => commitQueue([{ qid: 'pending-photo', action: 'uploadTxnPhoto', status: 'pending',
    payload: { id: 't1', attachmentId: 'not-uploaded', b64: 'photo-test' } }]));
  await readyCard(page);
  expect(await queueLen(page)).toBe(1);
  await expect(page.locator('#balance-share-message')).toContainText('₹12,500');
});

test('cancelled preparation ignores a late image and does not leak an object URL', async ({ page }) => {
  await sharingHarness(page);
  await page.evaluate(() => {
    const render = BahiBalanceCard.render;
    window.BahiBalanceCard = { render: snapshot => new Promise(resolve => {
      window.finishCard = async () => resolve(await render(snapshot));
    }) };
  });
  await page.locator('#btn-remind').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishCard)).toBe('function');
  await page.locator('#dlg-balance-share button[type=submit]').click();
  await expect(page.locator('#dlg-balance-share')).toBeHidden();
  await page.evaluate(() => window.finishCard());
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('a changed customer during preparation discards the old result', async ({ page }) => {
  const backend = await sharingHarness(page);
  const release = backend.hold();
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Syncing');
  await page.evaluate(() => openCustomer('u2'));
  await expect(page.locator('#dlg-balance-share')).toBeHidden();
  release();
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('a slow preparation times out and keeps pending financial work intact', async ({ page }) => {
  const backend = await sharingHarness(page);
  backend.setMode('down');
  await addEntry(page, { amount: 75, note: 'kept on timeout' });
  await expect.poll(() => queueLen(page)).toBe(1);
  const queued = await lsJSON(page, 'bahi.queue');
  backend.setMode('ok');
  const release = backend.hold();
  await page.clock.install();
  await page.locator('#btn-remind').click();
  await page.clock.fastForward(31000);
  await expect(page.locator('#balance-share-status')).toContainText('timed out');
  expect((await lsJSON(page, 'bahi.queue'))[0].qid).toBe(queued[0].qid);
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  release();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(backend.state.transactions.filter(t => t.comment === 'kept on timeout')).toHaveLength(1);
  await page.locator('#balance-share-retry').click();
  await expect(page.locator('#balance-share-native')).toBeEnabled();
});

test('image-rendering failure retains freshly synced text fallbacks', async ({ page }) => {
  await sharingHarness(page);
  await page.evaluate(() => { window.BahiBalanceCard = { render: async () => { throw new Error('Canvas unavailable'); } }; });
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Canvas unavailable');
  await expect(page.locator('#balance-share-native')).toBeDisabled();
  await expect(page.locator('#balance-share-download')).toBeDisabled();
  await expect(page.locator('#balance-share-copy')).toBeEnabled();
  await page.locator('#balance-share-copy').click();
  expect(await page.evaluate(() => window.__copied[0])).toContain('₹12,500');
});

test('a stopped network invalidates an already prepared card', async ({ page, context }) => {
  await sharingHarness(page);
  await readyCard(page);
  await context.setOffline(true);
  await expect(page.locator('#balance-share-status')).toContainText('details changed');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  expect(await page.evaluate(() => window.revokedCardUrls)).toEqual(await page.evaluate(() => window.createdCardUrls));
});

test('offline preparation does not fall back to exporting the cached ledger', async ({ page, context }) => {
  await sharingHarness(page);
  await context.setOffline(true);
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Connect to the internet');
  await expect(page.locator('#balance-share-ready')).toBeHidden();
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('a slow list request times out even without queued work and Retry can recover', async ({ page }) => {
  const backend = await sharingHarness(page);
  const release = backend.hold();
  await page.clock.install();
  await page.locator('#btn-remind').click();
  await page.clock.fastForward(31000);
  await expect(page.locator('#balance-share-status')).toContainText('timed out');
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
  release();
  await page.locator('#balance-share-retry').click();
  await expect(page.locator('#balance-share-native')).toBeEnabled();
});

test('changes made while the renderer is delayed require a new review', async ({ page }) => {
  await sharingHarness(page);
  await page.evaluate(() => {
    const render = BahiBalanceCard.render;
    window.BahiBalanceCard = { render: snapshot => new Promise(resolve => {
      window.finishCard = async () => resolve(await render(snapshot));
    }) };
  });
  await page.locator('#btn-remind').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishCard)).toBe('function');
  await page.evaluate(() => { config.currency = '$'; });
  await page.evaluate(() => window.finishCard());
  await expect(page.locator('#balance-share-status')).toContainText('details changed');
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('switching ledgers clears the prepared file and cannot share the previous account', async ({ page }) => {
  await sharingHarness(page);
  await readyCard(page);
  const next = createBackend({ key: 'other-share-key', users: [{ user_id: 'u9', name: 'Other ledger', token: '' }] });
  await page.unrouteAll();
  await next.install(page);
  await page.evaluate(hash => { location.hash = hash; }, '#s=' + b64url({ u: OTHER_EXEC, k: next.state.key }));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();
  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).url).toBe(OTHER_EXEC);
  await expect(page.locator('#dlg-balance-share')).toBeHidden();
  expect(await page.evaluate(() => window.revokedCardUrls)).toEqual(await page.evaluate(() => window.createdCardUrls));
  expect(await page.evaluate(() => window.shareCalls.length)).toBe(0);
});

test('literal names and merchant text do not become HTML or nested template substitutions', async ({ page }) => {
  await sharingHarness(page, { customerName: 'Ramesh $& {amount}', merchant: '<Shop> $& Sons',
    template: '{name}\n{merchant}\n{amount}', token: 'off' });
  await readyCard(page);
  await expect(page.locator('#balance-share-message')).toHaveText('Ramesh $& {amount}\n<Shop> $& Sons\n₹12,500');
  expect(await page.locator('#balance-share-message shop').count()).toBe(0);
});

test('oversized amounts fail visibly rather than creating a clipped image', async ({ page }) => {
  await sharingHarness(page, { balance: 1e60 });
  await page.locator('#btn-remind').click();
  await expect(page.locator('#balance-share-status')).toContainText('Amount is too long');
  await expect(page.locator('#balance-share-download')).toBeDisabled();
  await expect(page.locator('#balance-share-copy')).toBeEnabled();
  expect(await page.evaluate(() => window.createdCardUrls)).toEqual([]);
});

test('mobile preview keeps controls reachable without horizontal page overflow', async ({ page }, testInfo) => {
  await sharingHarness(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await readyCard(page);
  await expect(page.locator('#toast')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('preview-320.png'), animations: 'disabled' });
  await page.locator('#balance-share-copy').click();
  expect(await page.evaluate(() => window.__copied.length)).toBe(1);
});

test('a queued new customer and entry resolve their IDs before sharing', async ({ page }) => {
  const backend = await sharingHarness(page);
  await page.locator('#btn-back').click();
  backend.setMode('down');
  await page.locator('#fab').click();
  await page.locator('#cust-input-name').fill('Queued Customer');
  await page.locator('#cust-save').click();
  await openCustomer(page, 'Queued Customer');
  await addEntry(page, { amount: 50, note: 'new customer balance' });
  await expect.poll(() => queueLen(page)).toBe(2);
  backend.setMode('ok');
  await readyCard(page);
  await expect(page.locator('#balance-share-message')).toContainText('Queued Customer');
  await expect(page.locator('#balance-share-message')).toContainText('₹50');
  expect(await queueLen(page)).toBe(0);
  expect(backend.state.users.filter(u => u.name === 'Queued Customer')).toHaveLength(1);
});

test('opening a passbook cancels the owner share preview', async ({ page }) => {
  const backend = await sharingHarness(page);
  await readyCard(page);
  await page.evaluate(hash => { location.hash = hash; }, '#p=' + b64url({
    u: backend.state.url, t: backend.state.users[0].token,
  }));
  await expect(page.locator('#screen-passbook')).toBeVisible();
  await expect(page.locator('#dlg-balance-share')).toBeHidden();
  expect(await page.evaluate(() => window.revokedCardUrls)).toEqual(await page.evaluate(() => window.createdCardUrls));
});

test('an older cached HTML shell stays usable and asks for reload instead of exporting', async ({ page }) => {
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8')
    .replace(/<dialog id="dlg-balance-share"[\s\S]*?<\/dialog>/, '')
    .replace(/<label class="field">\s*<span>Message when you owe the customer<\/span>[\s\S]*?<\/label>/, '')
    .replace('<script src="balance-card.js"></script>', '');
  await page.route('http://localhost:4173/', route => route.fulfill({ contentType: 'text/html', body: html }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await sharingHarness(page);
  await page.locator('#btn-remind').click();
  await expect(page.locator('#update-bar')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Reload the new app version');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.shareCalls)).toEqual([]);
});
