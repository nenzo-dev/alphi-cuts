// Service worker: makes the site open fast and installable, lets it open on a flaky connection, shows
// the shop's notifications when they arrive (even with the site closed, 2.7.0), and opens the right
// page when one is tapped.
//
// Since 2.10.0 the pages and their code are kept on the phone and opened from there, so a visit
// doesn't wait for the network for every file. Each release has its own VERSION, so a new release
// is a new service worker: it downloads the new files in the background, replaces the old copies,
// and js/lib/autoupdate.js then reloads open pages onto it. So every release must bump VERSION here
// (and in js/config.js). Version checks and anything asked for fresh still go to the network.
const VERSION = '2.10.1';
const CACHE = `alphicuts-${VERSION}`;
// Photos and icons are kept across releases (they rarely change), so a new release doesn't download
// them all again. Raise the number if a picture is ever replaced at the same address.
const IMAGES = 'alphicuts-images-1';
const CORE = [
  './', 'admin', 'privacy', 'terms', 'disclaimer', 'developers',
  'css/style.css', 'manifest.webmanifest',
  'icons/logo-96.webp', 'icons/logo-512.webp', 'icons/favicon-32.png', 'icons/icon-192.png',
  'js/app.js', 'js/admin.js', 'js/page.js', 'js/config.js', 'js/fx.js', 'js/styles-data.js', 'js/legal-content.js',
  'js/lib/api.js', 'js/lib/ui.js', 'js/lib/slots.js', 'js/lib/content.js', 'js/lib/client.js',
  'js/lib/alarm.js', 'js/lib/ringtone.js', 'js/lib/notify.js', 'js/lib/ics.js', 'js/lib/image.js',
  'js/lib/appupdate.js', 'js/lib/arrival.js', 'js/lib/showcase.js', 'js/lib/autoupdate.js',
  'js/lib/push.js', 'js/lib/notifyui.js', 'js/lib/soundui.js', 'js/lib/markdown.js',
  'img/map.webp',
];

self.addEventListener('install', (event) => {
  // One by one, so a single missing file doesn't stop the rest being saved. `reload` skips the
  // browser's own cache, so this version's files are the ones saved.
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(CORE.map((path) => c.add(new Request(path, { cache: 'reload' })).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== IMAGES).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function store(request, response, cacheName = CACHE) {
  if (response && response.ok && response.type === 'basic' && !response.redirected) {
    const copy = response.clone();
    caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
  }
  return response;
}

async function fromCache(name, request, options) {
  const c = await caches.open(name);
  return c.match(request, options);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // database and other sites: never cached here
  if (url.pathname.startsWith('/app/')) return;    // the Android app download is always fetched fresh
  // The new-version check (js/lib/autoupdate.js) asks for config.js with no-store: straight to the network.
  if (request.cache === 'no-store' || request.cache === 'reload' || (url.search && request.mode !== 'navigate')) return;

  // Pictures: this release's copy (the map, the icons), else the long-lived picture store.
  if (url.pathname.startsWith('/img/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const hit = (await fromCache(CACHE, request)) || (await fromCache(IMAGES, request));
      if (hit) return hit;
      try {
        return store(request, await fetch(request), IMAGES);
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // Saved copy first; the network only for something not saved yet (which is then saved).
  event.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    try {
      return store(request, await fetch(request));
    } catch {
      if (request.mode === 'navigate') return (await caches.match('./')) || Response.error();
      return Response.error();
    }
  })());
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
