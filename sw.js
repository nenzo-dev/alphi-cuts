// Service worker: makes the site installable, lets it open on a flaky connection, shows the shop's
// notifications when they arrive (even with the site closed, 2.7.0), and opens the right page when
// one is tapped.
// Pages and code are network-first so updates show up straight away; images are cache-first.
const VERSION = '2.7.0';
const CACHE = `alphicuts-${VERSION}`;
const CORE = [
  './', 'css/style.css', 'manifest.webmanifest', 'icons/logo-96.webp', 'icons/logo-512.webp',
  'js/app.js', 'js/config.js', 'js/styles-data.js',
  'js/lib/api.js', 'js/lib/ui.js', 'js/lib/slots.js', 'js/lib/content.js', 'js/lib/client.js',
  'js/lib/alarm.js', 'js/lib/ringtone.js', 'js/lib/notify.js', 'js/lib/ics.js', 'js/lib/image.js', 'js/lib/appupdate.js', 'js/lib/arrival.js',
  'js/fx.js', 'js/lib/showcase.js', 'js/lib/autoupdate.js', 'js/lib/push.js', 'js/lib/notifyui.js',
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

// A notification from the shop's server (supabase/functions/push-send): { title, body, url, tag, urgent }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const urgent = !!data.urgent;
  event.waitUntil(self.registration.showNotification(data.title || 'AlPhi Cuts', {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || 'alphi-cuts',
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [500, 200, 500, 200, 800] : [200, 100, 200],
    data: { url: data.url || './' },
  }));
});

// The push service replaced this device's address: subscribe again. The page sends the new address to
// the shop the next time it opens (js/lib/push.js syncPush).
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription;
  if (!old || !old.options) return;
  event.waitUntil(self.registration.pushManager.subscribe(old.options).catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './#book', self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const samePage = windows.find((w) => new URL(w.url).pathname === target.pathname);
    if (samePage) {
      await samePage.focus();
      if (samePage.url !== target.href && 'navigate' in samePage) await samePage.navigate(target.href).catch(() => {});
      return;
    }
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing && 'navigate' in existing) {
      await existing.focus();
      await existing.navigate(target.href).catch(() => self.clients.openWindow(target.href));
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
