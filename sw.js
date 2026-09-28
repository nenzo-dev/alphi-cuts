// Minimal service worker: exists mainly so Chrome/Android consider this site installable (a PWA
// needs one registered fetch handler to qualify), plus a network-first pass on the site's own
// static files so it still opens (even if stale) with a flaky connection -- network-first (not
// cache-first) matters here because this site ships real updates often; a cache-first strategy
// would permanently stick returning visitors on whatever was cached on their first visit, since
// nothing about a same-named cache forces a re-fetch just because the deployed files changed.
const CACHE = 'alphicuts-v2';
const CORE = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/config.js', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API/database calls -- only this site's own static files.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
