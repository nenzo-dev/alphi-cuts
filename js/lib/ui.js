// DOM helpers and the one place that decides what an error looks like to a visitor.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const GENERIC_ERROR = "Sorry, we ran into an error. It's not you, it's us.";
const OFFLINE_ERROR = 'You seem to be offline. Check your connection and try again.';

// Only messages we wrote ourselves ever reach the screen. Database, network and code errors all
// become the same friendly line, so nothing about the system leaks out.
export function friendlyError(err) {
  if (err && typeof err.userMessage === 'string' && err.userMessage) return err.userMessage;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return OFFLINE_ERROR;
  return GENERIC_ERROR;
}

export function showMsg(el, text, kind = 'ok') {
  if (!el) return;
  el.textContent = '';
  if (!text) return;
  const d = document.createElement('div');
  d.className = `form-msg ${kind}`;
  d.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  d.textContent = text;
  el.appendChild(d);
}
export const showError = (el, err) => showMsg(el, friendlyError(err), 'error');

let toastTimer = null;
export function toast(text, kind = 'ok') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}
export const toastError = (err) => toast(friendlyError(err), 'error');

// Anything that slips past a try/catch still ends up as the friendly message, never a raw error.
export function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); toastError(e.reason); });
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window) return; // a failed image or script load, not a code error
    e.preventDefault();
    toast(GENERIC_ERROR, 'error');
  });
}

// Disables a button while its action runs, so a double tap can't submit twice.
export async function withBusy(btn, fn) {
  if (btn.disabled) return undefined;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode or storage full */ }
}
export function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
