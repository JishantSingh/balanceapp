import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

test.use({ serviceWorkers: 'allow' });
const oldWorker = readFileSync(new URL('../fixtures/pre-compact-sw.js', import.meta.url), 'utf8');
const currentWorker = readFileSync(new URL('../../docs/sw.js', import.meta.url), 'utf8');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html', '.webmanifest': 'application/manifest+json' };

async function oldInstallation(page, context, worker = oldWorker) {
  let legacy = true;
  let backendDown = false;
  const paths = [];
  const posts = [];
  // A real HTTP origin/service worker, with unmistakable owner-only cached
  // assets. No fake page.route service worker or production Google requests.
  const server = createServer((req, res) => {
    let path = new URL(req.url, 'http://localhost').pathname;
    paths.push(path);
    if (path === '/balanceapp/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(worker); return;
    }
    if (legacy && ['/balanceapp/', '/balanceapp/index.html'].includes(path)) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><p>OWNER_ONLY_CACHE_SENTINEL</p><script src="app.js"></script>'); return;
    }
    if (legacy && path === '/balanceapp/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.ownerBootstrapExecuted = true;'); return;
    }
    if (!path.startsWith('/balanceapp/') || path.includes('..')) { res.writeHead(404).end(); return; }
    path = path.slice('/balanceapp/'.length);
    if (path.endsWith('/') || !path) path += 'index.html';
    try {
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' })
        .end(readFileSync(new URL('../../docs/' + path, import.meta.url)));
    } catch (_) { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/balanceapp/`;
  await context.route('https://script.google.com/**', async route => {
    posts.push(route.request().postDataJSON());
    if (backendDown) return route.abort('internetdisconnected');
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, data: { name: 'Customer only', transactions: [
        { date: '2026-09-14', type: 'given', amount: 25, comment: 'test entry' },
      ] } }) });
  });
  await page.goto(base);
  await page.evaluate(async () => {
    localStorage.setItem('bahi.config', JSON.stringify({ key: 'PRIVATE_OWNER_KEY' }));
    localStorage.setItem('bahi.cache', 'PRIVATE_OWNER_LEDGER');
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  expect(await page.evaluate(() => window.ownerBootstrapExecuted)).toBe(true);
  expect(await page.evaluate(() => caches.keys())).toContain(worker === oldWorker ? 'bahi-shell-v28' : 'bahi-shell-v29');
  legacy = false;
  paths.length = 0;
  return { base, paths, posts, down: () => { backendDown = true; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test('v29 caches only the reader shell: offline reload and invalid hashes never reveal owner data', async ({ page, context }) => {
  const fixture = await oldInstallation(page, context, currentWorker);
  try {
    await page.goto(fixture.base + 'p/#MOCKDEPLOY.tok_customer_123456');
    await expect(page.locator('#pb-name')).toHaveText('Customer only');
    await expect(page.locator('#pb-amt')).toHaveText('₹25');
    expect(await page.evaluate(() => window.ownerBootstrapExecuted)).toBeUndefined();
    expect(fixture.paths).not.toContain('/balanceapp/app.js');
    expect(fixture.posts).toEqual([{ action: 'passbook', token: 'tok_customer_123456' }]);
    await expect(page.locator('#screen-home, button, input')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('bahi.cache'))).toBe('PRIVATE_OWNER_LEDGER');
    await page.waitForFunction(async () => !!(await caches.match(location.pathname)) &&
      !!(await caches.match(new URL('../passbook.js', location.href))) && !!(await caches.match(new URL('reader.js', location.href))));
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    fixture.down();
    await context.setOffline(true);
    const hashes = await page.evaluate(async () => {
      const cache = await caches.open('bahi-shell-v29');
      return (await cache.keys()).map(req => new URL(req.url).hash);
    });
    expect(hashes.every(hash => hash === '')).toBe(true);
    await page.reload();
    await expect(page.locator('#pb-status')).toContainText('Could not reach');
    await expect(page.locator('#pb-name')).toHaveText('…');
    expect(await page.content()).not.toContain('PRIVATE_OWNER_LEDGER');
    await page.evaluate(() => { location.hash = '#invalid'; });
    await expect(page.locator('#pb-status')).toContainText('Invalid passbook link');
    expect(await page.evaluate(() => window.ownerBootstrapExecuted)).toBeUndefined();
  } finally { await context.setOffline(false); await fixture.close(); }
});

test('a real v28 owner cache opens the new reader online without executing its cached owner bundle', async ({ page, context }) => {
  const fixture = await oldInstallation(page, context);
  try {
    await page.goto(fixture.base + 'p/#MOCKDEPLOY.tok_customer_123456');
    await expect(page.locator('#pb-name')).toHaveText('Customer only');
    expect(await page.evaluate(() => window.ownerBootstrapExecuted)).toBeUndefined();
    expect(fixture.paths).not.toContain('/balanceapp/app.js');
    expect(fixture.posts).toEqual([{ action: 'passbook', token: 'tok_customer_123456' }]);
    await expect(page.locator('#screen-home, button, input')).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#invalid'; });
    await expect(page.locator('#pb-status')).toContainText('Invalid passbook link');
    expect(await page.evaluate(() => localStorage.getItem('bahi.cache'))).toBe('PRIVATE_OWNER_LEDGER');
  } finally { await fixture.close(); }
});

test('first compact-link visit offline with only old owner assets cannot fall back to the owner dashboard', async ({ page, context }) => {
  const fixture = await oldInstallation(page, context);
  try {
    await context.setOffline(true);
    await expect(page.goto(fixture.base + 'p/#MOCKDEPLOY.tok_customer_123456')).rejects.toThrow(/net::ERR/);
    await expect.poll(async () => {
      try { return (await page.content()).includes('OWNER_ONLY_CACHE_SENTINEL'); }
      catch (_) { return null; } // Chromium is still committing its network-error document
    }).toBe(false);
    expect(fixture.paths).not.toContain('/balanceapp/app.js');
  } finally { await context.setOffline(false); await fixture.close(); }
});
