// Keeps an open page on the newest version of the site, so nobody has to press anything to update.
// When a new version is published, the page reloads itself at a quiet moment: straight away if it's
// in the background, otherwise once nobody has touched it for a few seconds. It never reloads over a
// half-typed message, an open pop-up or a ringing alarm, and it comes back to the same place on the
// page. The Android app shows this same site, so it refreshes the same way.
import { VERSION } from '../config.js';

const CHECK_MS = 60 * 1000;    // how often an open page asks for the latest version
const QUIET_MS = 8 * 1000;     // no taps, keys or scrolling for this long counts as a quiet moment
const RESUME_KEY = 'ac_resume';
const DONE_KEY = 'ac_reloaded_for';

const typed = new Set();       // fields someone has typed in that haven't been sent yet
let lastTouch = Date.now();
let newer = null;
let timer = 0;

export function watchForUpdates() {
  resumeScroll();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    addEventListener(type, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
  }
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('input, textarea, select')) typed.add(e.target);
  }, true);
  document.addEventListener('submit', (e) => {
    if (e.target.querySelectorAll) e.target.querySelectorAll('input, textarea, select').forEach((el) => typed.delete(el));
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
    else if (newer) tryReload();
  });
  addEventListener('pageshow', (e) => { if (e.persisted) check(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', check);
  // Pages in the background check too, so they are already up to date when someone comes back to them.
  setInterval(check, CHECK_MS);
  setTimeout(check, 5000);
}

async function latestVersion() {
  const res = await fetch(new URL('../config.js', import.meta.url), { cache: 'no-store' });
  if (!res.ok) return null;
  const found = (await res.text()).match(/VERSION\s*=\s*'([^']+)'/);
  return found ? found[1] : null;
}

async function check() {
  if (newer) { tryReload(); return; }
  try {
    const v = await latestVersion();
    if (!v || v === VERSION) return;
    // Reload once for each new version; if the page still comes back old, the next visit picks it up.
    let done = null;
    try { done = sessionStorage.getItem(DONE_KEY); } catch { /* not kept on this phone */ }
    if (done === v) return;
    newer = v;
    tryReload();
  } catch {
    /* offline or the check failed: try again next time */
  }
}

function unsaved() {
  for (const el of typed) {
    const empty = el.type === 'checkbox' || el.type === 'radio' ? false : !String(el.value || '').trim();
    if (!el.isConnected || empty) typed.delete(el);
  }
  return typed.size > 0;
}

function busy() {
  const active = document.activeElement;
  if (active && active.matches && active.matches('input, textarea, select, [contenteditable="true"]')) return true;
  if (document.querySelector('#modal-root > *, #alarm-root > *')) return true;
  return unsaved();
}

function tryReload() {
  clearTimeout(timer);
  const quiet = document.visibilityState === 'hidden' || Date.now() - lastTouch > QUIET_MS;
  if (quiet && !busy()) {
    reloadNow();
    return;
  }
  timer = setTimeout(tryReload, 3000);
}

function reloadNow() {
  try {
    sessionStorage.setItem(DONE_KEY, newer);
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({ y: Math.round(scrollY), at: Date.now(), path: location.pathname }));
  } catch { /* the page still reloads, from the top */ }
  location.reload();
}

/** After a reload for an update, go back to where the person was on the page. */
function resumeScroll() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    return;
  }
  if (!saved || !saved.y || saved.path !== location.pathname || Date.now() - saved.at > 60000) return;
  let moved = false;
  const stop = () => { moved = true; };
  for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) addEventListener(type, stop, { once: true, passive: true });
  // The page fills in as its content loads, so go back to the spot a few times while it settles.
  for (const ms of [250, 900, 1800]) setTimeout(() => { if (!moved) scrollTo(0, saved.y); }, ms);
}
