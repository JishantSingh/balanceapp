import { expect } from '@playwright/test';
import { MOCK_EXEC } from '../mock-backend.mjs';

export const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const inviteHash = (backend, key) =>
  '#s=' + b64url({ u: MOCK_EXEC, k: key ?? backend.state.key });

/* A second deployment URL — "a different khata" as far as the app is concerned.
   The mock backend routes every script.google host, so this only has to differ
   as a string and still satisfy the app's /exec URL check. */
export const OTHER_EXEC = 'https://script.google.com/macros/s/OTHERDEPLOY/exec';

export const inviteHashFor = (url, key) => '#s=' + b64url({ u: url, k: key });

export const passbookHash = (token) =>
  '#p=' + b64url({ u: MOCK_EXEC, t: token });

/* Read one of the app's localStorage slots back out of the page. Returns null
   when the key is absent, so "wiped" and "empty" stay distinguishable. */
export const lsJSON = (page, key) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw === null ? null : JSON.parse(raw);
  }, key);

/* Decode a #p= / #s= link the app produced. */
export const decodeHash = (link) => {
  const b64 = link.split('#')[1].slice(2).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString());
};

export const decodePassbookLink = (link) => {
  const url = new URL(link);
  if (url.hash.startsWith('#p=')) return decodeHash(link);
  const dot = url.hash.indexOf('.');
  return { u: 'https://script.google.com/macros/s/' + url.hash.slice(1, dot) + '/exec',
    t: decodeURIComponent(url.hash.slice(dot + 1)) };
};

/* Record clipboard writes instead of touching the real one — headless Chromium
   rejects writeText without a permission grant, and copyText() falls back to
   execCommand, which we could not observe. */
export const stubClipboard = (page) =>
  page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
    });
  });

/* Connect via invite link and wait for the ledger to render. */
export async function openLedger(page, backend) {
  await backend.install(page);
  await page.goto('/' + inviteHash(backend));
  await expect(page.locator('#screen-home')).toBeVisible();
  if (backend.state.users.length) {
    await expect(page.locator('.customer-row').first()).toBeVisible();
  }
}

export async function openCustomer(page, name) {
  await page.locator('.customer-row', { hasText: name }).click();
  await expect(page.locator('#screen-customer')).toBeVisible();
}

/* How many writes are still waiting to reach the sheet. */
export const queueLen = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bahi.queue') || '[]').length);

/* Add an entry from the customer screen. */
export async function addEntry(page, { type = 'given', amount, note }) {
  await page.locator(type === 'given' ? '#btn-gave' : '#btn-got').click();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await page.locator('#txn-amount').fill(String(amount));
  if (note) await page.locator('#txn-comment').fill(note);
  await page.locator('#txn-save').click();
}

/* 1x1 red PNG — enough for compressImage to decode and re-encode. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// Chromium's synthetic camera exercises real getUserMedia/video/canvas without
// opening any physical camera or microphone on the developer's computer.
export const CAMERA_TEST_OPTIONS = {
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
};

export async function trackCamera(page) {
  await page.addInitScript(() => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.cameraRequests = [];
    window.cameraStreams = [];
    window.cameraFailure = null;
    window.cameraPermissionPending = false;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.cameraRequests.push(constraints);
      if (window.cameraFailure) throw new DOMException('Test camera error', window.cameraFailure);
      if (window.cameraPermissionPending) {
        await new Promise((resolve) => { window.grantPendingCamera = resolve; });
      }
      const stream = await getMedia(constraints);
      window.cameraStreams.push(stream);
      return stream;
    };
  });
}

export async function openEntryCamera(page) {
  await page.locator('#txn-photo-add').click();
  await page.locator('#photo-take').click();
  await expect(page.locator('#dlg-camera')).toBeVisible();
}

// Exercise the visible chooser and either live camera or gallery path.
export async function chooseEntryPhoto(page, source = 'gallery', file = {
  name: 'parchi.png', mimeType: 'image/png', buffer: TINY_PNG,
}) {
  if (source === 'camera') {
    await openEntryCamera(page);
    await expect(page.locator('#camera-capture')).toBeEnabled();
    await page.locator('#camera-capture').click();
    await expect(page.locator('#camera-shot')).toBeVisible();
    await page.locator('#camera-use').click();
    await expect(page.locator('#dlg-camera')).toBeHidden();
    return;
  }
  await page.locator('#txn-photo-add').click();
  await expect(page.locator('#dlg-photo-source')).toBeVisible();
  const picker = page.waitForEvent('filechooser');
  await page.locator('#photo-choose').click();
  const chooser = await picker;
  expect(await chooser.element().getAttribute('capture')).toBe(null);
  await expect(page.locator('#dlg-photo-source')).toBeHidden();
  await expect(page.locator('#dlg-txn')).toBeVisible();
  await chooser.setFiles(file);
}
