// What this browser remembers about its visitor: a device token for the chat thread and style
// requests, and the private tokens of any bookings made here. Whoever holds a booking token can
// see and manage that booking, so they never leave this device except to talk to the database.
import { storageGet, storageSet, storageRemove } from './ui.js';

const DEVICE_KEY = 'ac_device';
const BOOKINGS_KEY = 'ac_bookings';
const LEGACY_KEY = 'ac_client_token'; // v1 kept a single token for both booking and chat
const TOKEN_RE = /^[0-9a-f]{32,64}$/;
const MAX_TOKENS = 10;

function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readList() {
  let list = [];
  try { list = JSON.parse(storageGet(BOOKINGS_KEY) || '[]'); } catch { list = []; }
  return Array.isArray(list) ? list.filter((t) => TOKEN_RE.test(t)) : [];
}

// One-time move from the v1 single token: it keeps the existing chat thread and booking.
function migrateLegacy() {
  const legacy = storageGet(LEGACY_KEY);
  if (!legacy) return;
  if (TOKEN_RE.test(legacy)) {
    if (!TOKEN_RE.test(storageGet(DEVICE_KEY) || '')) storageSet(DEVICE_KEY, legacy);
    const list = readList();
    if (!list.includes(legacy)) storageSet(BOOKINGS_KEY, JSON.stringify([...list, legacy]));
  }
  storageRemove(LEGACY_KEY);
}
migrateLegacy();

export function deviceToken() {
  let t = storageGet(DEVICE_KEY);
  if (!TOKEN_RE.test(t || '')) {
    t = newToken();
    storageSet(DEVICE_KEY, t);
  }
  return t;
}

export function hasDeviceToken() {
  return TOKEN_RE.test(storageGet(DEVICE_KEY) || '');
}

export function bookingTokens() {
  return readList();
}

export function addBookingToken(token) {
  if (!TOKEN_RE.test(token || '')) return;
  const list = readList().filter((t) => t !== token);
  list.push(token);
  storageSet(BOOKINGS_KEY, JSON.stringify(list.slice(-MAX_TOKENS)));
}

export function setBookingTokens(tokens) {
  storageSet(BOOKINGS_KEY, JSON.stringify(tokens.filter((t) => TOKEN_RE.test(t)).slice(-MAX_TOKENS)));
}
