/* Bahi service worker — caches the app shell so the app opens instantly
   and works offline (data itself is cached by app.js in localStorage). */

const CACHE = 'bahi-shell-v29';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './balance-card.js',
  './passbook.js',
  './p/',
  './p/reader.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept the Apps Script API
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // App shell: cache-first, refresh in background
  if (e.request.method === 'GET' && url.origin === location.origin) {
    // Hashes select customer data, not different HTML files. Navigation
    // Requests can include them: strip before matching/storing shell assets,
    // both for offline hits and to keep private tokens out of cache metadata.
    url.hash = '';
    const cacheKey = url.href;
    e.respondWith(
      caches.match(cacheKey).then((hit) => {
        const fresh = fetch(e.request)
          .then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(cacheKey, res.clone()));
            return res;
          })
          .catch(() => hit);
        return hit || fresh;
      })
    );
  }
});
