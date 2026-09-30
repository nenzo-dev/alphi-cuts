// System notifications. Android Chrome refuses `new Notification()` from a page, so these go
// through the service worker when one is registered. Everything here fails quietly: the ringing
// and the on-screen alert still work without notification permission.
export function notifySupported() {
  return typeof Notification !== 'undefined';
}

export function notifyPermission() {
  return notifySupported() ? Notification.permission : 'unsupported';
}

export async function requestNotifyPermission() {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export async function notify(title, body, { tag = 'alphi-cuts', urgent = false } = {}) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  const options = {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag,
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [500, 200, 500, 200, 800] : [200, 100, 200],
    data: { url: location.href.split('#')[0] + '#book' },
  };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* not allowed right now */ }
}
