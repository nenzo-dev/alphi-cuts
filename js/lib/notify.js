// Thin wrapper around the browser Notification API. Safe to call even where notifications aren't
// supported or haven't been granted yet -- every function is a no-op in that case rather than an
// error, since none of this is required for the site to work (the ringtone + on-screen ticket
// already carry the "you're up" signal; this just adds an OS-level nudge when granted).

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

export function notify(title, body) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: 'icons/icon.svg', tag: 'alphi-cuts-queue' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers throw if the page isn't in a state that allows this -- ignore */ }
}
