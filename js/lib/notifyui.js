// The parts of the page that make notifications easy to find and turn on (2.7.0):
//   - a bell in the header, with a glowing dot while they're off, that opens the notifications panel
//   - the panel: what you get, a big "Turn on notifications" button, and clear steps for iPhone,
//     for a browser that blocked them, and for the Android app
//   - a floating prompt at the bottom of the home page (and again right after booking)
// The wording comes from the owner's editable text (js/lib/content.js, "Notifications" group).
import { $, esc, toast, toastError, storageGet, storageSet } from './ui.js';
import { pushState, turnOnPush, turnOffPush, freeToday, setFreeToday, sendTestPush, deviceInfo } from './push.js';

const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>';
const DOCK_KEY = 'ac_notify_dock_hidden_until';

let text = (k) => k;
let ownerFirst = () => 'the barber';
let onAppAlerts = () => {};
let onChange = () => {};
let state = 'unavailable';

/** Sets up the bell and the prompt. Call once, after the shop's settings have loaded. */
export async function initNotifyUi(opts) {
  ({ text, ownerFirst, onAppAlerts, onChange } = { ...{ text, ownerFirst, onAppAlerts, onChange }, ...opts });
  state = await pushState();
  paintBell();
  onChange(state);
  if (state === 'off' || state === 'ios-install') setTimeout(() => showDock(false), 2500);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const next = await pushState();
    if (next !== state) { state = next; paintBell(); onChange(state); }
  });
}

export const notifyState = () => state;

function paintBell() {
  let bell = $('#notify-bell');
  if (!bell) {
    const slot = $('.site-header .row');
    if (!slot) return;
    bell = document.createElement('button');
    bell.type = 'button';
    bell.id = 'notify-bell';
    bell.className = 'bell-btn';
    bell.innerHTML = `${BELL}<span class="bell-dot" aria-hidden="true"></span>`;
    bell.addEventListener('click', openPanel);
    const cta = slot.querySelector('.header-cta, .nav-toggle');
    slot.insertBefore(bell, cta);
  }
  bell.hidden = state === 'unavailable';
  bell.dataset.state = state;
  bell.setAttribute('aria-label', state === 'on' ? 'Notifications are on' : 'Turn on notifications');
  bell.title = bell.getAttribute('aria-label');
}

// ------------------------------------------------------------------ the floating prompt
/** Shows the prompt at the bottom. `force` shows it even if it was dismissed (right after booking). */
export function showDock(force) {
  if (!['off', 'ios-install'].includes(state)) return;
  if (!force && Number(storageGet(DOCK_KEY) || 0) > Date.now()) return;
  if ($('#notify-dock') || document.querySelector('#modal-root > *')) return;
  const dock = document.createElement('div');
  dock.id = 'notify-dock';
  dock.className = 'notify-dock';
  dock.setAttribute('role', 'dialog');
  dock.setAttribute('aria-label', text('notify_title'));
  dock.innerHTML = `
    <span class="nd-icon">${BELL}</span>
    <p>${esc(force ? text('notify_after_booking') : text('notify_prompt'))}</p>
    <div class="nd-actions">
      <button type="button" class="btn btn-gold btn-sm" id="nd-on">${esc(state === 'ios-install' ? 'Show me how' : text('notify_button'))}</button>
      <button type="button" class="nd-close" id="nd-close" aria-label="Not now">&times;</button>
    </div>`;
  document.body.appendChild(dock);
  requestAnimationFrame(() => dock.classList.add('show'));
  $('#nd-on').addEventListener('click', async () => {
    hideDock();
    if (state === 'ios-install') openPanel();
    else await turnOn($('#nd-on'));
  });
  $('#nd-close').addEventListener('click', () => {
    storageSet(DOCK_KEY, String(Date.now() + 7 * 24 * 3600 * 1000));
    hideDock();
  });
}

function hideDock() {
  const dock = $('#notify-dock');
  if (!dock) return;
  dock.classList.remove('show');
  setTimeout(() => dock.remove(), 300);
}

// ------------------------------------------------------------------ turning on
async function turnOn(btn, { free = null } = {}) {
  if (btn) btn.setAttribute('aria-busy', 'true');
  try {
    const next = await turnOnPush({ free });
    state = next;
    paintBell();
    onChange(state);
    if (next === 'on') {
      toast(free ? `Notifications are on. We'll also tell you when ${ownerFirst()} is free today.` : "Notifications are on. We'll let you know when it's your turn, even with this site closed.");
    } else if (next === 'blocked') {
      openPanel();
    }
    return next;
  } catch (err) {
    toastError(err);
    return state;
  } finally {
    if (btn) btn.removeAttribute('aria-busy');
  }
}

/** For other buttons on the page ("Turn on notifications" in My booking, "Tell me when free"). */
export async function turnOnFromPage(btn, opts) {
  if (state === 'on' && opts && opts.free) {
    try {
      await setFreeToday(true);
      toast(`We'll tell you when ${ownerFirst()} is free today, even with this site closed.`);
    } catch (err) {
      toastError(err);
    }
    return state;
  }
  if (state !== 'off') { openPanel(); return state; }
  return turnOn(btn, opts);
}

// ------------------------------------------------------------------ the panel
const BLOCKED_STEPS = deviceInfo.isIOS
  ? 'Open your iPhone\'s Settings, tap Notifications, find this site and turn on Allow Notifications. Then come back here.'
  : 'Tap the lock or settings icon next to the web address, open Permissions or Site settings, and set Notifications to Allow. Then come back here.';

function panelBody(free) {
  const list = `
    <ul class="np-list">
      <li>A heads-up before your slot</li>
      <li>When you're 2 away and when you're next</li>
      <li>When it's your turn</li>
      <li>Replies from ${esc(ownerFirst())}</li>
    </ul>`;
  if (state === 'on') {
    return `
      <p class="np-status on"><span class="np-dot"></span>${esc(text('notify_on'))}</p>
      ${list}
      <label class="check-inline np-free"><input type="checkbox" id="np-free" ${free ? 'checked' : ''}> ${esc(text('notify_free'))}</label>
      <div class="np-actions">
        <button type="button" class="btn btn-ghost" id="np-test">Send a test notification</button>
        <button type="button" class="link-btn small" id="np-off">Turn off on this device</button>
      </div>`;
  }
  if (state === 'off') {
    return `
      <p>${esc(text('notify_intro'))}</p>
      ${list}
      <button type="button" class="btn btn-gold btn-block btn-lg" id="np-on">${esc(text('notify_button'))}</button>
      <p class="small muted np-note">Your browser will ask. Tap Allow.</p>`;
  }
  if (state === 'blocked') {
    return `
      <p class="np-status blocked"><span class="np-dot"></span>Notifications are blocked for this site.</p>
      <p>${esc(BLOCKED_STEPS)}</p>
      <button type="button" class="btn btn-ghost btn-block" id="np-recheck">I've allowed them</button>`;
  }
  if (state === 'ios-install') {
    return `
      <p>On iPhone and iPad, notifications work once this site is on your Home Screen:</p>
      <ol class="np-steps">
        <li>In Safari, tap the <b>Share</b> button (the square with an arrow).</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open it from your Home Screen, tap the bell at the top and choose <b>Turn on notifications</b>.</li>
      </ol>
      <p class="small muted">Until then, keep this page open on the day of your booking and it will ring when it's your turn.</p>`;
  }
  if (state === 'app') {
    return `
      <p class="np-status on"><span class="np-dot"></span>The app rings for your booking, even when it's closed.</p>
      <button type="button" class="btn btn-gold btn-block" id="np-app">Check the app's alerts</button>`;
  }
  return `
    <p>This browser can't show notifications. Open this site in Chrome, Edge, Firefox or Safari, or get the Android app.</p>
    <a class="btn btn-gold btn-block" href="#get-app" id="np-getapp">Get the app</a>`;
}

export async function openPanel() {
  hideDock();
  const root = $('#modal-root');
  if (!root) return;
  state = await pushState();
  paintBell();
  const free = state === 'on' ? await freeToday() : false;
  const last = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop" id="np-backdrop">
      <div class="modal notify-panel" role="dialog" aria-modal="true" aria-labelledby="np-title">
        <button type="button" class="modal-close" id="np-close" aria-label="Close">&times;</button>
        <div class="np-head"><span class="np-bell">${BELL}</span><h3 id="np-title">${esc(text('notify_title'))}</h3></div>
        ${panelBody(free)}
      </div>
    </div>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    if (last && last.focus) last.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#np-close').addEventListener('click', close);
  $('#np-backdrop').addEventListener('click', (e) => { if (e.target.id === 'np-backdrop') close(); });

  const on = $('#np-on');
  if (on) on.addEventListener('click', async () => { const next = await turnOn(on); if (next === 'on' || next === 'blocked') openPanel(); });
  const test = $('#np-test');
  if (test) {
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        await sendTestPush();
        toast('Sent. It should arrive in a few seconds.');
      } catch (err) {
        toastError(err);
      } finally {
        setTimeout(() => { test.disabled = false; }, 60000);
      }
    });
  }
  const off = $('#np-off');
  if (off) off.addEventListener('click', async () => { await turnOffPush(); state = await pushState(); paintBell(); onChange(state); openPanel(); });
  const freeBox = $('#np-free');
  if (freeBox) {
    freeBox.addEventListener('change', async () => {
      try {
        await setFreeToday(freeBox.checked);
        toast(freeBox.checked ? `We'll tell you when ${ownerFirst()} is free today.` : 'Okay, no "free now" notification today.');
      } catch (err) {
        freeBox.checked = !freeBox.checked;
        toastError(err);
      }
    });
  }
  const recheck = $('#np-recheck');
  if (recheck) recheck.addEventListener('click', async () => { state = await pushState(); paintBell(); onChange(state); if (state === 'blocked') toast('They still look blocked. Check the site settings again.', 'error'); openPanel(); });
  const app = $('#np-app');
  if (app) app.addEventListener('click', () => { close(); onAppAlerts(); });
  const getApp = $('#np-getapp');
  if (getApp) getApp.addEventListener('click', close);
  const first = root.querySelector('#np-on, #np-test, #np-recheck, #np-app, #np-getapp, #np-close');
  if (first) first.focus();
}
