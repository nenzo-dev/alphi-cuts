// Time and slot maths. Every "today" / "is this slot past" decision uses the shop's own clock
// (Africa/Lusaka), not whatever timezone the visitor's phone is set to.
import { CONFIG } from '../config.js';

const SHOP_TZ = CONFIG.timeZone;
const pad = (n) => String(n).padStart(2, '0');

export const toMin = (hhmm) => {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
export const fromMin = (t) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;

// "opens 09:00, closes 20:00, 30 minutes each" -> 09:00, 09:30 ... 19:30
export function daySlots(openTime, closeTime, slotMinutes) {
  const out = [];
  const close = toMin(closeTime);
  for (let t = toMin(openTime); t + slotMinutes <= close; t += slotMinutes) out.push(fromMin(t));
  return out;
}

export function fmtTime(hhmm) {
  const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
  const period = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${pad(m)}${period}`;
}

function shopParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHOP_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return p;
}

export function todayISO() {
  const p = shopParts();
  return `${p.year}-${p.month}-${p.day}`;
}

export function nowMinutesInShopTz() {
  const p = shopParts();
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

export function addDaysISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return dt.toISOString().slice(0, 10);
}

export const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const dayName = (n) => DAY_NAMES[n];

export function fmtDate(iso, { withWeekday = true } = {}) {
  const today = todayISO();
  if (iso === today) return 'today';
  if (iso === addDaysISO(today, 1)) return 'tomorrow';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}),
  });
}

// The next `days` dates starting today, for the booking form's day picker.
export function shopDateOptions(days, closedWeekdays = []) {
  const start = todayISO();
  const out = [];
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(start, i);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDate(iso);
    out.push({ iso, label, closed: closedWeekdays.includes(weekdayOf(iso)) });
  }
  return out;
}

// Milliseconds since the epoch for a date + time on the shop's clock.
export function shopTimeToEpoch(iso, hhmm) {
  const [y, mo, d] = iso.split('-').map(Number);
  const [h, mi] = String(hhmm).slice(0, 5).split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = shopParts(new Date(guess));
  const shownAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, Number(p.hour) % 24, +p.minute, +p.second);
  return guess - (shownAsUtc - guess);
}

const ACTIVE = new Set(['booked', 'on_deck', 'called', 'checked_in', 'in_chair', 'done']);

// For each slot, the status of any booking overlapping it. Bookings made before a change to the
// slot length may sit between two slots; they block both.
export function slotStatuses(slots, rows, slotMinutes) {
  const booked = rows.filter((r) => ACTIVE.has(r.status)).map((r) => ({ t: toMin(r.slot_time), status: r.status }));
  const map = new Map();
  for (const s of slots) {
    const t = toMin(s);
    const hits = booked.filter((b) => Math.abs(b.t - t) < slotMinutes);
    if (!hits.length) continue;
    map.set(s, hits.some((h) => h.status === 'in_chair') ? 'in_chair' : hits[0].status);
  }
  return map;
}
