// Service worker: makes the site installable, lets it open on a flaky connection, and brings the
// booking page forward when an alert notification is tapped.
// Pages and code are network-first so updates show up straight away; images are cache-first.
const VERSION = '2.6.1';
const CACHE = `alphicuts-${VERSION}`;
const CORE = [
  './', 'css/style.css', 'manifest.webmanifest', 'icons/logo-96.webp', 'icons/logo-512.webp',
  'js/app.js', 'js/config.js', 'js/styles-data.js',
  'js/lib/api.js', 'js/lib/ui.js', 'js/lib/slots.js', 'js/lib/content.js', 'js/lib/client.js',
  'js/lib/alarm.js', 'js/lib/ringtone.js', 'js/lib/notify.js', 'js/lib/ics.js', 'js/lib/image.js', 'js/lib/appupdate.js', 'js/lib/arrival.js',
  'js/fx.js', 'js/lib/showcase.js', 'js/lib/autoupdate.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function store(request, response) {
  if (response && response.ok && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // database and other sites: never cached here
  if (url.pathname.startsWith('/app/')) return;    // the Android app download is always fetched fresh

  if (url.pathname.includes('/img/') || url.pathname.includes('/icons/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => store(request, res))));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => store(request, res))
      .catch(async () => (await caches.match(request)) || (request.mode === 'navigate' ? caches.match('./') : Response.error())),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './#book';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow(target);
  })());
});
