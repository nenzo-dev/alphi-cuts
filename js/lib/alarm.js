// Booking alerts for the bookings held on this device.
//
//   reminder  a few minutes before the slot (the owner sets how many): chime + notification
//   on_deck   the barber has started the cut two places ahead: chime + notification
//   called    the barber has called this booking next: ringing + full-screen alert
//   due       the slot's start time has arrived: ringing + full-screen alert
//
// Each alert fires once per booking. Stopping it is remembered, so a reload doesn't ring again.
// Ringing stops by itself after three minutes; the on-screen alert stays until it's dismissed.
import { startRing, stopRing, chime, audioUnlocked, unlockAudio } from './ringtone.js';
import { notify } from './notify.js';
import { shopTimeToEpoch, fmtTime } from './slots.js';
import { esc, storageGet, storageSet } from './ui.js';

const DONE_KEY = 'ac_alerts_done';
const RING_LIMIT_MS = 3 * 60 * 1000;
const WAITING = new Set(['booked', 'on_deck', 'called']);

let bookings = [];
let settings = { slotMinutes: 30, reminderMinutes: 10 };
let text = (k) => k;
let onCheckIn = async () => {};
let showToast = () => {};
let tickTimer = null;
let ringStartedAt = 0;
let current = null;       // { key, token, phase } of the alert on screen
let baseTitle = document.title;
let titleTimer = null;

function doneSet() {
  try { return new Set(JSON.parse(storageGet(DONE_KEY) || '[]')); } catch { return new Set(); }
}
function markDone(key) {
  const s = doneSet();
  s.add(key);
  storageSet(DONE_KEY, JSON.stringify([...s].slice(-60)));
}

function phaseFor(b, now) {
  if (!WAITING.has(b.status)) return null;
  const start = shopTimeToEpoch(b.booking_date, b.slot_time);
  const end = start + settings.slotMinutes * 60000;
  if (now >= end) return null;
  if (now >= start) return 'due';
  if (b.status === 'called') return 'called';
  if (b.status === 'on_deck') return 'on_deck';
  if (settings.reminderMinutes > 0 && now >= start - settings.reminderMinutes * 60000) return 'reminder';
  return null;
}

function messageFor(phase, b) {
  const minsLeft = Math.max(1, Math.round((shopTimeToEpoch(b.booking_date, b.slot_time) - Date.now()) / 60000));
  const vars = { time: fmtTime(b.slot_time), mins: String(minsLeft) };
  if (phase === 'due') return text('alert_now', vars);
  if (phase === 'called') return text('alert_called', vars);
  if (phase === 'on_deck') return text('alert_on_deck', vars);
  const reminder = text('alert_reminder', vars);
  return minsLeft === 1 ? reminder.replace('1 minutes', '1 minute') : reminder;
}

function flashTitle(on) {
  clearInterval(titleTimer);
  if (!on) { document.title = baseTitle; return; }
  let flip = false;
  titleTimer = setInterval(() => {
    flip = !flip;
    document.title = flip ? "⏰ It's your turn" : baseTitle;
  }, 1000);
}

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not allowed yet */ }
}

function closeOverlay() {
  const root = document.getElementById('alarm-root');
  if (root) root.innerHTML = '';
  stopRing();
  flashTitle(false);
  if (current) markDone(current.key);
  current = null;
}

function showOverlay(b, phase, key) {
  const root = document.getElementById('alarm-root');
  if (!root) return;
  const canCheckIn = WAITING.has(b.status);
  root.innerHTML = `
    <div class="alarm" role="alertdialog" aria-modal="true" aria-labelledby="alarm-title">
      <div class="alarm-card">
        <div class="alarm-bell" aria-hidden="true"></div>
        <h2 id="alarm-title">${phase === 'due' ? "It's your turn" : "You're next"}</h2>
        <p class="alarm-time">${esc(fmtTime(b.slot_time))}</p>
        <p>${esc(messageFor(phase, b))}</p>
        <p class="small muted alarm-sound-hint" ${audioUnlocked() ? 'hidden' : ''}>Tap anywhere to hear the alarm.</p>
        <div class="alarm-actions">
          ${canCheckIn ? '<button class="btn btn-gold" data-alarm="here">I\'m here</button>' : ''}
          <button class="btn btn-ghost" data-alarm="stop">Stop alarm</button>
        </div>
      </div>
    </div>`;
  current = { key, token: b.client_token, phase };
  root.querySelector('.alarm').addEventListener('pointerdown', () => {
    unlockAudio();
    const hint = root.querySelector('.alarm-sound-hint');
    if (hint) hint.hidden = true;
  });
  root.querySelector('[data-alarm="stop"]').addEventListener('click', closeOverlay);
  const here = root.querySelector('[data-alarm="here"]');
  if (here) {
    here.addEventListener('click', async () => {
      here.disabled = true;
      const token = current && current.token;
      closeOverlay();
      if (token) await onCheckIn(token);
    });
  }
  root.querySelector('[data-alarm="stop"]').focus();
}

function fire(b, phase, key) {
  const msg = messageFor(phase, b);
  if (phase === 'due' || phase === 'called') {
    if (current && current.key === key) return;
    startRing();
    ringStartedAt = Date.now();
    vibrate([600, 250, 600, 250, 1200]);
    flashTitle(true);
    showOverlay(b, phase, key);
    notify(phase === 'due' ? "It's your turn" : "You're next", msg, { tag: `booking-${b.client_token}`, urgent: true });
  } else {
    markDone(key);
    chime();
    vibrate([200, 100, 200]);
    notify(phase === 'on_deck' ? 'Almost your turn' : 'Your cut is coming up', msg, { tag: `booking-${b.client_token}` });
    showToast(msg);
  }
}

function tick() {
  const now = Date.now();
  const done = doneSet();

  // The booking on screen changed (checked in, started, cancelled): take the alert down.
  if (current) {
    const b = bookings.find((x) => x.client_token === current.token);
    const stillValid = b && phaseFor(b, now);
    if (!stillValid) {
      const root = document.getElementById('alarm-root');
      if (root) root.innerHTML = '';
      stopRing();
      flashTitle(false);
      current = null;
    } else if (Date.now() - ringStartedAt > RING_LIMIT_MS) {
      stopRing();
    } else {
      vibrate([600, 250, 600]);
    }
  }

  for (const b of bookings) {
    const phase = phaseFor(b, now);
    if (!phase) continue;
    const key = `${b.client_token}:${phase}`;
    if (done.has(key)) continue;
    // Being called and the slot starting are the same moment for the client: one alarm, not two.
    if (phase === 'due' && done.has(`${b.client_token}:called`)) { markDone(key); continue; }
    if (current && current.token === b.client_token && current.phase === phase) continue;
    fire(b, phase, key);
    break; // one new alert per tick
  }
}

export function configureAlarms(opts) {
  if (opts.text) text = opts.text;
  if (opts.onCheckIn) onCheckIn = opts.onCheckIn;
  if (opts.toast) showToast = opts.toast;
  if (opts.slotMinutes) settings.slotMinutes = opts.slotMinutes;
  if (typeof opts.reminderMinutes === 'number') settings.reminderMinutes = opts.reminderMinutes;
  if (opts.title) baseTitle = opts.title;
}

export function updateAlarms(rows) {
  bookings = rows.slice();
  if (!tickTimer) tickTimer = setInterval(tick, 5000);
  tick();
}

// How long until this booking's slot starts, for the ticket's countdown line.
export function startsIn(b) {
  return shopTimeToEpoch(b.booking_date, b.slot_time) - Date.now();
}
