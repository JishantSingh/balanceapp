/* Frozen v28 service-worker behavior (before compact passbook links).
   Retain the real cache-first/exact-URL logic for upgrade regression tests. */
const CACHE = 'bahi-shell-v28';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './balance-card.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (event.request.method === 'GET' && url.origin === location.origin) {
    event.respondWith(caches.match(event.request).then(hit => {
      const fresh = fetch(event.request).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
