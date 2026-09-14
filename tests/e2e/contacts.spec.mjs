import { test, expect } from '@playwright/test';
import { createBackend, seedLedger } from '../mock-backend.mjs';
import { openLedger, openCustomer, lsJSON, queueLen, OTHER_EXEC, inviteHashFor } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const sample = { name: ['ram mcDonald राम'], tel: ['+91 98765 43210'] };

// Only synthetic contacts. The tests never open the computer's address book.
async function stubContacts(page, options = {}) {
  await page.addInitScript(({ sample, options }) => {
    const stub = window.contactStub = {
      calls: [], propertyCalls: 0, result: [sample], properties: ['name', 'tel'],
      mode: 'ok', ...options,
    };
    if (options.insecure) Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(navigator, 'contacts', { configurable: true, value: options.unsupported ? undefined : {
      getProperties: async () => {
        stub.propertyCalls++;
        if (stub.propertyError) throw new Error('Unavailable');
        if (stub.holdProperties) await new Promise(resolve => { stub.releaseProperties = resolve; });
        return stub.properties;
      },
      select: async (properties, opts) => {
        stub.calls.push({ properties, opts, userActivated: navigator.userActivation.isActive });
        if (stub.mode === 'hold') return new Promise((resolve, reject) => {
          stub.finish = result => resolve(result ?? stub.result);
          stub.reject = name => reject(new DOMException('Synthetic picker error', name));
        });
        if (stub.mode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
        if (stub.mode === 'error') throw new DOMException('Denied', 'NotAllowedError');
        return stub.result;
      },
    } });
  }, { sample, options });
}

async function setup(page, options = {}) {
  await stubContacts(page, options);
  const backend = createBackend(seedLedger());
  await openLedger(page, backend);
  await page.locator('#fab').click();
  return backend;
}

async function pick(page) {
  await expect(page.locator('#cust-contacts')).toBeEnabled();
  await page.locator('#cust-contacts').click();
}

async function allStorage(page) {
  return page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))));
}

const writes = backend => backend.state.log.filter(action => action !== 'list');

test('picking requests only one contact from a tap; nothing is stored or written before Save', async ({ page }, testInfo) => {
  const contact = { ...sample, id: 'UNUSED-CONTACT-ID', email: ['UNUSED@example.invalid'] };
  const backend = await setup(page, { result: [contact] });
  const requests = [];
  page.on('request', req => { if (req.method() === 'POST') requests.push(req.postDataJSON()); });
  await expect(page.locator('#cust-contacts')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('new-customer.png'), animations: 'disabled' });
  await pick(page);
  await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
  await expect(page.locator('#cust-input-phone')).toHaveValue('9876543210');
  await page.screenshot({ path: testInfo.outputPath('contact-filled.png'), animations: 'disabled' });
  expect(await page.evaluate(() => window.contactStub.calls)).toEqual([
    { properties: ['name', 'tel'], opts: { multiple: false }, userActivated: true },
  ]);
  expect(writes(backend)).toEqual([]);
  expect(await queueLen(page)).toBe(0);
  expect(await allStorage(page)).not.toContain(sample.name[0]);
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === sample.name[0] && u.phone === '9876543210')).toBe(true);
  expect(writes(backend)).toEqual(['addUser']);
  expect(requests[0].data).toEqual({ name: sample.name[0], phone: '9876543210' });
  expect(await allStorage(page)).not.toContain('UNUSED');
  expect(JSON.stringify(requests)).not.toContain('UNUSED');
  await openCustomer(page, sample.name[0]);
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-input-name')).toHaveAttribute('autocapitalize', 'words');
  await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
});

test('edit replaces both draft fields, cancellation preserves the customer, Save updates the same ID', async ({ page }) => {
  const backend = await setup(page);
  await page.locator('#dlg-customer [data-close]').click();
  await openCustomer(page, 'Ramu Halwai');
  await page.locator('#cust-head-main').click();
  const original = structuredClone(backend.state.users[0]);
  const transactions = structuredClone(backend.state.transactions);
  await pick(page);
  await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
  await expect(page.locator('#cust-input-phone')).toHaveValue('9876543210');
  await page.locator('#dlg-customer [data-close]').click();
  expect(backend.state.users[0]).toEqual(original);
  expect(writes(backend)).toEqual([]);
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-input-name')).toHaveValue(original.name);
  await pick(page);
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users[0].name).toBe(sample.name[0]);
  expect(backend.state.users[0]).toEqual({ ...original, name: sample.name[0], phone: '9876543210' });
  expect(backend.state.transactions).toEqual(transactions);
  expect(writes(backend)).toEqual(['updateUser']);
});

test('multiple numbers require an explicit choice and equivalent formatted duplicates are collapsed', async ({ page }, testInfo) => {
  const backend = await setup(page, { result: [{ name: ['Contact Name'], tel: ['+91 98765 43210', '9876543210', '9123456780'] }] });
  await page.locator('#cust-input-name').fill('Original draft');
  await page.locator('#cust-input-phone').fill('9000000000');
  await pick(page);
  await expect(page.locator('.contact-number')).toHaveText(['+91 98765 43210›', '9123456780›']);
  await expect(page.locator('#cust-input-name')).toHaveValue('Original draft');
  await expect(page.locator('#cust-input-phone')).toHaveValue('9000000000');
  await expect(page.locator('#cust-save')).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('choose-number.png'), animations: 'disabled' });
  await page.locator('#form-customer').evaluate(form => form.requestSubmit());
  expect(writes(backend)).toEqual([]);
  await page.locator('#cust-contact-cancel').click();
  await expect(page.locator('#cust-contact-numbers')).toBeHidden();
  await expect(page.locator('#cust-input-name')).toHaveValue('Original draft');
  await expect(page.locator('#cust-input-phone')).toHaveValue('9000000000');
  await pick(page);
  await page.locator('.contact-number').nth(1).click();
  await expect(page.locator('#cust-input-name')).toHaveValue('Contact Name');
  await expect(page.locator('#cust-input-phone')).toHaveValue('9123456780');
  await expect(page.locator('.contact-number')).toHaveCount(0);
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === 'Contact Name' && u.phone === '9123456780')).toBe(true);
  expect(await allStorage(page)).not.toContain('9876543210');
  expect(await allStorage(page)).not.toContain('+91 98765 43210');
});

test('selected details can be manually changed before Save without capitalization rewriting', async ({ page }) => {
  const backend = await setup(page);
  await pick(page);
  await page.locator('#cust-input-name').fill('my SHOP');
  await page.locator('#cust-input-phone').fill('09123456780');
  await page.locator('#cust-save').click();
  await expect.poll(() => backend.state.users.some(u => u.name === 'my SHOP' && u.phone === '9123456780')).toBe(true);
});

for (const [label, contact, expectedName, expectedPhone, notice] of [
  ['missing phone', { name: ['Name Only'], tel: [] }, 'Name Only', '', 'No phone number shared'],
  ['missing name', { name: [], tel: ['9876543210'] }, '', '9876543210', 'No name shared'],
  ['both missing', { name: [], tel: [] }, '', '', 'No name shared'],
]) {
  test(`${label} clears old draft fields and remains editable`, async ({ page }) => {
    const backend = await setup(page, { result: [contact] });
    await page.locator('#cust-input-name').fill('Old name');
    await page.locator('#cust-input-phone').fill('9000000000');
    await pick(page);
    await expect(page.locator('#cust-input-name')).toHaveValue(expectedName);
    await expect(page.locator('#cust-input-phone')).toHaveValue(expectedPhone);
    await expect(page.locator('#cust-contact-status')).toContainText(notice);
    await page.locator('#cust-save').click();
    if (!expectedName) {
      await expect(page.locator('#cust-error')).toContainText('Name is required');
      expect(writes(backend)).toEqual([]);
      await page.locator('#cust-input-name').fill('Manual name');
      await page.locator('#cust-save').click();
    }
    await expect.poll(() => backend.state.users.some(u => u.name === (expectedName || 'Manual name') && u.phone === expectedPhone)).toBe(true);
  });
}

for (const phone of ['12345', '+44 7700 900123', 'not a number']) {
  test(`invalid imported phone ${phone} is not silently saved or discarded`, async ({ page }) => {
    const backend = await setup(page, { result: [{ name: ['Needs correction'], tel: [phone] }] });
    await pick(page);
    await expect(page.locator('#cust-input-phone')).toHaveValue(phone);
    await expect(page.locator('#cust-contact-status')).toContainText('10 digit');
    await page.locator('#cust-save').click();
    await expect(page.locator('#cust-error')).toBeVisible();
    expect(writes(backend)).toEqual([]);
    await page.locator('#cust-input-phone').fill('');
    await page.locator('#cust-save').click();
    await expect.poll(() => backend.state.users.some(u => u.name === 'Needs correction' && u.phone === '')).toBe(true);
  });
}

for (const [label, options] of [
  ['unsupported API', { unsupported: true }],
  ['insecure context', { insecure: true }],
  ['unsupported properties', { properties: ['name', 'email'] }],
  ['failed property check', { propertyError: true }],
]) {
  test(`${label}: hide the picker and keep normal customer creation working`, async ({ page }) => {
    const backend = await setup(page, options);
    await expect(page.locator('#cust-contacts')).toBeHidden();
    await page.locator('#cust-input-name').fill('Manual customer');
    await page.locator('#cust-save').click();
    await expect.poll(() => backend.state.users.some(u => u.name === 'Manual customer')).toBe(true);
    expect(await page.evaluate(() => window.contactStub.calls)).toEqual([]);
  });
}

for (const [label, options, error] of [
  ['cancelled', { mode: 'cancel' }, false],
  ['empty result', { result: [] }, false],
  ['denied', { mode: 'error' }, true],
  ['malformed result', { result: null }, true],
]) {
  test(`${label}: preserve draft and offer another attempt`, async ({ page }) => {
    const backend = await setup(page, options);
    await page.locator('#cust-input-name').fill('Draft to keep');
    await page.locator('#cust-input-phone').fill('9000000000');
    await pick(page);
    await expect(page.locator('#cust-contacts')).toBeEnabled();
    await expect(page.locator('#cust-input-name')).toHaveValue('Draft to keep');
    await expect(page.locator('#cust-input-phone')).toHaveValue('9000000000');
    if (error) await expect(page.locator('#cust-contact-status')).toContainText('enter the details manually');
    else await expect(page.locator('#cust-contact-status')).toBeHidden();
    expect(writes(backend)).toEqual([]);
    await page.evaluate(contact => { window.contactStub.mode = 'ok'; window.contactStub.result = [contact]; }, sample);
    await pick(page);
    await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
  });
}

test('pending native picker blocks repeated taps and Save, but permits cancelling the form', async ({ page }) => {
  const backend = await setup(page, { mode: 'hold' });
  await page.locator('#cust-input-name').fill('Pending draft');
  await pick(page);
  await expect(page.locator('#cust-contacts')).toBeDisabled();
  await expect(page.locator('#cust-save')).toBeDisabled();
  await page.locator('#cust-contacts').dispatchEvent('click');
  await page.locator('#form-customer').evaluate(form => form.requestSubmit());
  expect(await page.evaluate(() => window.contactStub.calls.length)).toBe(1);
  expect(writes(backend)).toEqual([]);
  await page.locator('#dlg-customer [data-close]').click();
  await page.evaluate(() => window.contactStub.finish());
  await expect.poll(() => page.evaluate(() => customerContactRequest === null)).toBe(true);
  await page.locator('#fab').click();
  await expect(page.locator('#cust-input-name')).toHaveValue('');
  await expect(page.locator('#cust-contacts')).toBeEnabled();
  expect(await allStorage(page)).not.toContain(sample.name[0]);
});

test('late result cannot fill a reopened form or a different customer', async ({ page }) => {
  await setup(page, { mode: 'hold' });
  await pick(page);
  await page.locator('#dlg-customer [data-close]').click();
  await openCustomer(page, 'Sunita Tailor');
  await page.locator('#cust-head-main').click();
  await expect(page.locator('#cust-save')).toBeEnabled();
  await expect(page.locator('#cust-contacts')).toBeDisabled();
  await page.evaluate(() => window.contactStub.finish());
  await expect(page.locator('#cust-contacts')).toBeEnabled();
  await expect(page.locator('#cust-input-name')).toHaveValue('Sunita Tailor');
  await expect(page.locator('#cust-input-phone')).toHaveValue('');
});

test('delayed property check and queued close events do not affect a new form session', async ({ page }) => {
  await setup(page, { holdProperties: true });
  await expect.poll(() => page.evaluate(() => window.contactStub.propertyCalls)).toBe(1);
  await page.evaluate(() => {
    const releaseOld = window.contactStub.releaseProperties;
    document.getElementById('dlg-customer').close();
    window.contactStub.holdProperties = false;
    openCustomerForm('u2');
    releaseOld();
  });
  await expect(page.locator('#cust-input-name')).toHaveValue('Sunita Tailor');
  await pick(page);
  await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
});

test('returning from a native picker through visibility changes keeps the current draft session', async ({ page }) => {
  await setup(page, { mode: 'hold' });
  await pick(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.contactStub.finish();
  });
  await expect(page.locator('#cust-input-name')).toHaveValue(sample.name[0]);
  await expect(page.locator('#cust-save')).toBeEnabled();
});

test('ledger switch closes the old draft and drops a late contact result', async ({ page }) => {
  const a = await setup(page, { mode: 'hold' });
  const b = createBackend({ ...seedLedger(), key: 'otherkey', url: OTHER_EXEC });
  await b.install(page, { only: true });
  await pick(page);
  await page.evaluate(hash => { location.hash = hash; }, inviteHashFor(OTHER_EXEC, 'otherkey'));
  await expect(page.locator('#dlg-switch')).toBeVisible();
  await page.locator('#switch-go').click();
  await expect.poll(async () => (await lsJSON(page, 'bahi.config')).url).toBe(OTHER_EXEC);
  await expect(page.locator('#dlg-customer')).toBeHidden();
  await page.locator('#fab').click();
  await page.evaluate(() => window.contactStub.finish());
  await expect(page.locator('#cust-contacts')).toBeEnabled();
  await expect(page.locator('#cust-input-name')).toHaveValue('');
  expect(writes(a)).toEqual([]);
  expect(writes(b)).toEqual([]);
});

test('offline imported customer saves through the existing queue and survives reload/reconnect once', async ({ page }) => {
  const backend = await setup(page);
  backend.setMode('down');
  await pick(page);
  await page.locator('#cust-save').click();
  await expect.poll(() => queueLen(page)).toBe(1);
  expect((await lsJSON(page, 'bahi.queue'))[0].payload.data).toEqual({ name: sample.name[0], phone: '9876543210' });
  await page.reload();
  await expect(page.locator('.customer-row', { hasText: sample.name[0] })).toBeVisible();
  await expect.poll(() => queueLen(page)).toBe(1);
  backend.setMode('ok');
  await page.locator('#chip-pending').click();
  await expect.poll(() => queueLen(page)).toBe(0);
  expect(backend.state.users.filter(u => u.name === sample.name[0])).toHaveLength(1);
  expect(writes(backend)).toEqual(['addUser']);
});

test('contact markup renders as text; narrow light/dark forms fit and remain keyboard accessible', async ({ page }, testInfo) => {
  const name = '<img src=x onerror="window.contactInjected=true"> राम Kumar';
  await setup(page, { result: [{ name: [name], tel: ['9876543210', '9123456780'] }] });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await pick(page);
      await expect(page.locator('#cust-contact-name')).toHaveText(name);
      expect(await page.evaluate(() => window.contactInjected)).toBeUndefined();
      expect(await page.locator('#form-customer').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.locator('.contact-number').first().evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath(`contact-numbers-${width}-${colorScheme}.png`), animations: 'disabled' });
      await page.locator('.contact-number').nth(1).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#cust-input-phone')).toHaveValue('9123456780');
      await expect(page.locator('#cust-input-name')).toHaveValue(name);
    }
  }
});
