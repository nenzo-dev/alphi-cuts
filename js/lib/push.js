// Notifications that reach this phone or computer even when the site is closed (Web Push, 2.7.0).
//
// Turning them on asks the browser for permission, gets a push address from the browser's push
// service, and gives it to the database together with this device's booking tokens and chat token
// (push_subscribe). From then on the shop's server (supabase/functions/push-send) can tell this device
// when it's almost their turn, when it's their turn, when the barber replies, and, if they ask, when
// the barber is free. Whenever the bookings on this device change, syncPush() updates the list.
//
// What's possible depends on the device, and pushState() says which:
//   on           notifications are on for this device
//   off          they can be turned on
//   blocked      the person said no; it has to be undone in the browser's site settings
//   ios-install  iPhone and iPad: only once the site is added to the Home Screen and opened from there
//   app          inside the Android app, which rings by itself (no Web Push in an app's web view)
//   unsupported  this browser has no push notifications
//   unavailable  the shop's server isn't ready for notifications yet
import { rpc } from './api.js';
import { deviceToken, bookingTokens } from './client.js';

const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const inAndroidApp = () => !!(window.AlphiAndroid && typeof window.AlphiAndroid.syncBookings === 'function');

let publicKey = null;   // the shop's push key (base64url), once fetched
let keyChecked = false;

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

async function serverKey() {
  if (keyChecked) return publicKey;
  try {
    publicKey = await rpc('push_public_key');
  } catch {
    publicKey = null;
  }
  keyChecked = true;
  return publicKey;
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) {
    try { await navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url)); } catch { return null; }
  }
  return navigator.serviceWorker.ready;
}

async function currentSubscription() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** What's possible on this device right now (see the list at the top). */
export async function pushState() {
  if (inAndroidApp()) return 'app';
  if (!pushSupported()) return isIOS && !standalone() ? 'ios-install' : 'unsupported';
  if (!(await serverKey())) return 'unavailable';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await currentSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function fromB64u(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function tellServer(sub, free = null) {
  const keys = sub.toJSON().keys || {};
  await rpc('push_subscribe', {
    p_endpoint: sub.endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
    p_device: deviceToken(),
    p_bookings: bookingTokens(),
    p_free: free,
  });
}

/**
 * Asks for permission and turns notifications on. Answers the new state. `free` also asks to be told
 * when the barber is free today. Must be called from a tap, so the browser shows its question.
 */
export async function turnOnPush({ free = null } = {}) {
  const state = await pushState();
  if (['app', 'unsupported', 'ios-install', 'unavailable', 'blocked'].includes(state)) return state;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  let sub = await reg.pushManager.getSubscription();
  const key = fromB64u(await serverKey());
  if (sub && sub.options && sub.options.applicationServerKey) {
    // A subscription made with another key (an older setup) can't be used: start again.
    const old = new Uint8Array(sub.options.applicationServerKey);
    if (old.length !== key.length || old.some((b, i) => b !== key[i])) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await tellServer(sub, free);
  return 'on';
}

export async function turnOffPush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await rpc('push_unsubscribe', { p_endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Keeps the server's copy of this device's bookings up to date. Quiet if notifications are off. */
export async function syncPush() {
  if (inAndroidApp() || !pushSupported() || Notification.permission !== 'granted') return;
  try {
    const sub = await currentSubscription();
    if (sub && (await serverKey())) await tellServer(sub);
  } catch {
    /* tried again on the next change */
  }
}

/** Whether this device has asked to hear when the barber is free today. */
export async function freeToday() {
  try {
    const sub = await currentSubscription();
    if (!sub) return false;
    const rows = await rpc('push_status', { p_endpoint: sub.endpoint });
    return !!(rows && rows[0] && rows[0].free_today);
  } catch {
    return false;
  }
}

export async function setFreeToday(on) {
  const sub = await currentSubscription();
  if (sub) await tellServer(sub, !!on);
}

export async function sendTestPush() {
  const sub = await currentSubscription();
  if (!sub) throw new Error('not subscribed');
  await rpc('push_test', { p_endpoint: sub.endpoint });
}

/** For the owner panel: the owner's devices get new bookings, messages and requests. */
export async function ownerPushState() {
  const state = await pushState();
  if (state !== 'on' && state !== 'off') return state;
  const sub = await currentSubscription();
  if (!sub) return 'off';
  try {
    return (await rpc('admin_push_status', { p_endpoint: sub.endpoint })) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export async function ownerTurnOn() {
  const state = await pushState();
  if (['app', 'unsupported', 'ios-install', 'unavailable', 'blocked'].includes(state)) return state;
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const key = fromB64u(await serverKey());
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const keys = sub.toJSON().keys || {};
  await rpc('admin_push_subscribe', { p_endpoint: sub.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
  return 'on';
}

export async function ownerTurnOff() {
  const sub = await currentSubscription();
  if (sub) await rpc('admin_push_unsubscribe', { p_endpoint: sub.endpoint });
}

export const deviceInfo = { isIOS, standalone, inAndroidApp };
