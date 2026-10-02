// Checking clients in when they arrive at the shop (2.5.0). The owner sets the shop's location in the
// owner panel. A client who turns on "Check me in when I arrive" has their position compared with the
// shop's on the day of their booking, from two hours before the slot until it ends, and is checked in
// as soon as they're within the arrival distance. In the Android app the app itself does this, even
// when it's closed (android/.../Arrival.java); in a browser it works while the page is open.
// Positions only go to arrive_at_shop(), which checks the distance again and keeps nothing.
import { rpc } from './api.js';
import { storageGet, storageSet } from './ui.js';
import { shopTimeToEpoch } from './slots.js';

const KEY = 'alphi.arrival';
const BEFORE_MS = 2 * 60 * 60 * 1000;
const RETRY_MS = 30000;

let watchId = null;
let current = null;    // { cfg, due, onCheckedIn } while watching
let denied = false;    // the browser said no to location
let lastTry = 0;

/** Has the owner set the shop's location, with automatic check-in on? */
export function arrivalAvailable(cfg) {
  return !!cfg && cfg.auto_checkin !== false && cfg.shop_lat != null && cfg.shop_lng != null;
}

export const arrivalOn = () => storageGet(KEY) === '1';
export const arrivalDenied = () => denied;

/** Metres between two points on the Earth (the same formula as distance_m() in the database). */
export function distanceM(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Waiting today, and between two hours before the slot and its end: when arrival counts. */
export function inArrivalWindow(cfg, b, now = Date.now()) {
  if (!['booked', 'on_deck', 'called'].includes(b.status)) return false;
  const start = shopTimeToEpoch(b.booking_date, b.slot_time);
  return now >= start - BEFORE_MS && now <= start + cfg.slot_minutes * 60000;
}

/** Turned on from a tap: asks the browser for location straight away, so its prompt shows now. */
export function turnArrivalOn(onChange) {
  storageSet(KEY, '1');
  denied = false;
  if (!('geolocation' in navigator)) { denied = true; onChange(); return; }
  navigator.geolocation.getCurrentPosition(
    () => { denied = false; onChange(); },
    (err) => { if (err.code === 1) denied = true; onChange(); },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 },
  );
}

export function turnArrivalOff() {
  storageSet(KEY, '0');
  stop();
}

/**
 * After every refresh of the client's bookings (browser only): watch the position while a booking is
 * in its arrival window, and check it in on arrival. onCheckedIn(booking) is called once it's done.
 */
export function updateArrivalWatch({ cfg, rows, onCheckedIn }) {
  const due = arrivalAvailable(cfg) && arrivalOn() && !denied && 'geolocation' in navigator
    ? rows.filter((r) => inArrivalWindow(cfg, r))
    : [];
  if (!due.length) { stop(); return; }
  current = { cfg, due, onCheckedIn };
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 });
}

async function onPosition(pos) {
  if (!current) return;
  const { cfg, due, onCheckedIn } = current;
  const { latitude, longitude, accuracy } = pos.coords;
  const slack = Math.min(Math.max(Number(accuracy) || 0, 0), 100);
  if (distanceM(Number(cfg.shop_lat), Number(cfg.shop_lng), latitude, longitude) > Number(cfg.arrival_radius_m || 150) + slack) return;
  if (Date.now() - lastTry < RETRY_MS) return;
  lastTry = Date.now();
  for (const b of due) {
    try {
      const res = await rpc('arrive_at_shop', { p_token: b.client_token, p_lat: latitude, p_lng: longitude, p_accuracy: Number(accuracy) || null });
      if (res && res.result === 'checked_in') onCheckedIn(b);
    } catch { /* offline or busy: the next position tries again */ }
  }
}

function onError(err) {
  if (err.code === 1) { // permission denied: stop asking
    denied = true;
    stop();
  }
}

function stop() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  current = null;
}
