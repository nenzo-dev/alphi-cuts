import { CONFIG, VERSION } from './config.js';
import { rpc, rpcOr, rpcShared, select, uploadFile, publicFileUrl, isMissingFunction } from './lib/api.js';
import {
  $, $$, esc, showMsg, showError, toast, toastError, withBusy, friendlyError, installGlobalErrorHandlers, GENERIC_ERROR,
  storageGet, storageSet,
} from './lib/ui.js';
import {
  daySlots, fmtTime, fmtDate, todayISO, nowMinutesInShopTz, shopDateOptions, toMin, slotStatuses, weekdayOf,
  addDaysISO, shopTimeToEpoch,
} from './lib/slots.js';
import { deviceToken, hasDeviceToken, bookingTokens, addBookingToken, setBookingTokens } from './lib/client.js';
import { makeText, applyText, DEFAULT_TEXT } from './lib/content.js';
import { notifyPermission, requestNotifyPermission, notify } from './lib/notify.js';
import { armAudioUnlock, unlockAudio, audioUnlocked, chime, loadCustomSound } from './lib/ringtone.js';
import { openSounds } from './lib/soundui.js';
import { configureAlarms, updateAlarms, startsIn } from './lib/alarm.js';
import { bookingIcs, downloadFile } from './lib/ics.js';
import { prepareImage } from './lib/image.js';
import { readFileInfo, readText, parseProofText, judgeProof, buildProof, accountNumbers, MAX_BYTES } from './lib/proof.js';
import { watchAppUpdate } from './lib/appupdate.js';
import { syncPush } from './lib/push.js';
import { initNotifyUi, notifyState, showDock, openPanel, turnOnFromPage } from './lib/notifyui.js';
import {
  arrivalAvailable, arrivalOn, arrivalDenied, turnArrivalOn, turnArrivalOff, updateArrivalWatch,
} from './lib/arrival.js';
import { HAIRCUT_STYLES, styleThumb, stylePhotos } from './styles-data.js';

installGlobalErrorHandlers();
armAudioUnlock();

const WAITING = ['booked', 'on_deck', 'called', 'checked_in'];
const SECTION_IDS = ['styles', 'queue', 'book', 'reviews', 'chat', 'contact', 'map', 'get-app'];
const DEFAULTS = {
  shop_name: CONFIG.shortName, owner_name: '', tagline: '', price_kwacha: 50, rating: 5, rating_count: 0,
  open_time: '09:00', close_time: '20:00', slot_minutes: 30, booking_days_ahead: 7, reminder_minutes: 10,
  closed_weekdays: [], announcement: '', content: {},
};

let cfg = null;
let t = (key, extra) => (DEFAULT_TEXT[key] ?? '').replace(/\{(\w+)\}/g, (m, k) => (extra && k in extra ? extra[k] : ''));

function normalizeConfig(row) {
  const c = { ...DEFAULTS, ...row };
  c.shop_name = String(c.shop_name || CONFIG.shortName).trim();
  c.owner_name = String(c.owner_name || '').trim();
  c.open_time = String(c.open_time).slice(0, 5);
  c.close_time = String(c.close_time).slice(0, 5);
  c.slot_minutes = Number(c.slot_minutes) || 30;
  c.booking_days_ahead = Number(c.booking_days_ahead) || 7;
  c.reminder_minutes = Number.isFinite(Number(c.reminder_minutes)) ? Number(c.reminder_minutes) : 10;
  c.closed_weekdays = Array.isArray(c.closed_weekdays) ? c.closed_weekdays.map(Number) : [];
  c.content = c.content && typeof c.content === 'object' && !Array.isArray(c.content) ? c.content : {};
  c.hidden = new Set(Array.isArray(c.content.hidden) ? c.content.hidden : []);
  return c;
}

const ownerFirst = () => (cfg && cfg.owner_name.split(/\s+/)[0]) || 'the barber';

// Inside the Android app, window.AlphiAndroid connects to the phone's own alarms, which ring even
// when the app is closed. In a browser the in-page alarm (lib/alarm.js) is used instead.
const android = window.AlphiAndroid && typeof window.AlphiAndroid.syncBookings === 'function' ? window.AlphiAndroid : null;
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function appStatus() {
  if (!android) return null;
  try { return JSON.parse(android.info()); } catch { return null; }
}

// ---------------------------------------------------------------- shop settings and page text
function renderConfig() {
  const c = cfg;
  t = makeText(c);
  document.title = `${c.shop_name} | Book a haircut`;
  applyText(t);

  $$('[data-shop-name]').forEach((el) => { el.textContent = c.shop_name; });
  $('#ft-owner-name').textContent = c.owner_name;
  $('#hero-tagline').textContent = c.tagline;
  $('#hero-tagline').hidden = !c.tagline;

  const rating = Math.max(0, Math.min(5, Number(c.rating) || 0));
  const full = Math.round(rating);
  $('#hero-stars').textContent = '★'.repeat(full) + '☆'.repeat(5 - full);
  const ratingParts = [rating.toFixed(1)];
  if (Number(c.rating_count) > 0) ratingParts.push(`${c.rating_count} review${Number(c.rating_count) === 1 ? '' : 's'}`);
  if (t('hero_badge')) ratingParts.push(t('hero_badge'));
  $('#hero-rating-text').textContent = ratingParts.join(' · ');

  const ann = $('#announcement');
  ann.textContent = c.announcement || '';
  ann.hidden = !c.announcement;
  $('#ft-note').hidden = !$('#ft-note').textContent.trim();
  $('#app-version').textContent = `v${VERSION}`;

  for (const id of SECTION_IDS) {
    const hide = c.hidden.has(id) || (android && id === 'get-app');
    const section = document.getElementById(id);
    if (section) section.hidden = hide;
    $$(`[data-section="${id}"], [data-needs="${id}"]`).forEach((el) => { el.hidden = hide; });
  }

  renderContact();
  buildDateOptions();
  renderPayFirst();
  if (!c.hidden.has('get-app') && !android) buildQrCode();
  configureAlarms({
    text: (k, v) => t(k, v), onCheckIn: doCheckIn, toast,
    slotMinutes: c.slot_minutes, reminderMinutes: c.reminder_minutes, title: document.title,
  });
}

const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z"/></svg>';
const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.8 4.9-1.3A9.8 9.8 0 1 0 12 2.2Zm0 1.8a8 8 0 1 1-4.2 14.8l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 0 1 12 4Z"/><path d="M9.1 7.3c-.2-.4-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.8 2.8 4.4 3.8 2.2.9 2.6.7 3.1.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.4-.3-1.8-.9c-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.3-.4.8-1.3.1-.2 0-.3 0-.4l-.8-2Z"/></svg>';

function renderContact() {
  const c = cfg;
  $('#ct-address').textContent = c.address_line || '';
  $('#ct-directions').textContent = c.directions_text || '';
  const about = $('#ct-about');
  about.textContent = c.about_text || '';
  about.hidden = !c.about_text;

  const links = [];
  const tel = String(c.phone || '').replace(/[^\d+]/g, '');
  if (tel) {
    links.push(`<a class="contact-btn ct-call" href="tel:${esc(tel)}"><span class="ct-icon">${PHONE_ICON}</span><span class="ct-text"><b>Call</b><small>${esc(c.phone)}</small></span></a>`);
  }
  const wa = String(c.whatsapp || '').replace(/\D/g, '');
  if (wa) {
    links.push(`<a class="contact-btn ct-wa" href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer"><span class="ct-icon">${WHATSAPP_ICON}</span><span class="ct-text"><b>WhatsApp</b><small>${esc(c.whatsapp)}</small></span></a>`);
  }
  if (/^https:\/\//i.test(c.facebook || '')) links.push(`<a class="btn btn-ghost" href="${esc(c.facebook)}" target="_blank" rel="noopener noreferrer">Facebook</a>`);
  if (/^https:\/\//i.test(c.instagram || '')) links.push(`<a class="btn btn-ghost" href="${esc(c.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`);
  $('#ct-contacts').innerHTML = links.join('') || '<p class="muted">Contact details coming soon.</p>';

  // The picture and the Open button go to the owner's map link (Public page tab), else to the
  // shop's location if it's set, else to a search for the address.
  const link = t('map_link').trim();
  let url = /^https:\/\/\S+$/i.test(link) ? link : '';
  if (!url) {
    const query = c.shop_lat != null && c.shop_lng != null ? `${Number(c.shop_lat)},${Number(c.shop_lng)}` : c.address_line;
    if (query) url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }
  const open = $('#map-open');
  open.hidden = !url;
  if (url) {
    open.href = url;
    $('#map').href = url;
  } else {
    $('#map').removeAttribute('href');
  }
  $('#map').setAttribute('aria-label', `Open the map to ${c.shop_name}`);
}

// ---------------------------------------------------------------- slots for a day (shared, briefly cached)
const dayCache = new Map();

async function fetchDay(iso) {
  const rows = await rpcOr('public_queue', { p_date: iso },
    () => (iso === todayISO() ? rpc('public_queue_today') : []));
  return (rows || []).filter((r) => r.status !== 'cancelled' && r.status !== 'no_show');
}

function getDay(iso) {
  const hit = dayCache.get(iso);
  if (hit && Date.now() - hit.at < 3000) return hit.promise;
  const promise = fetchDay(iso);
  dayCache.set(iso, { at: Date.now(), promise });
  promise.catch(() => dayCache.delete(iso));
  return promise;
}
const invalidateDays = () => dayCache.clear();

// ---------------------------------------------------------------- today's queue
let wasBusy = null;
let lastToday = todayISO();
let todayQueue = null; // { at, rows } from the last successful load of today's queue

function renderFreeBanner(freeNow) {
  const slot = $('#free-banner-slot');
  if (!freeNow || cfg.hidden.has('queue')) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="free-banner"><span class="live-dot" aria-hidden="true"></span><span class="fb-text">${esc(t('queue_free_banner'))}</span>${cfg.hidden.has('book') ? '' : '<a href="#book" class="btn btn-sm btn-gold">Book</a>'}</div>`;
}

function updateNotifyButton(freeNow) {
  const push = notifyState();
  $('#notify-free-btn').hidden = freeNow || !(push === 'on' || push === 'off' || notifyPermission() === 'default');
}

async function loadQueue() {
  if (!cfg) return;
  const today = todayISO();
  if (today !== lastToday) {
    lastToday = today;
    buildDateOptions();
  }
  const summary = $('#queue-summary');
  const grid = $('#slot-grid');

  if (cfg.closed_weekdays.includes(weekdayOf(today))) {
    todayQueue = null;
    summary.innerHTML = `<span class="muted">${esc(t('queue_closed'))}</span>`;
    grid.innerHTML = '';
    renderFreeBanner(false);
    updateNotifyButton(true);
    return;
  }

  let rows;
  try {
    rows = await getDay(today);
  } catch (e) {
    if (!grid.children.length) summary.innerHTML = `<span class="muted">${esc(friendlyError(e))}</span>`;
    return;
  }
  todayQueue = { at: Date.now(), rows };

  const len = cfg.slot_minutes;
  const slots = daySlots(cfg.open_time, cfg.close_time, len);
  const statuses = slotStatuses(slots, rows, len);
  const nowMin = nowMinutesInShopTz();
  let nextFree = null;

  grid.innerHTML = slots.map((s) => {
    const m = toMin(s);
    const st = statuses.get(s);
    let cls = 'slot';
    let label = 'free';
    if (!st) {
      cls += ' free';
      if (nextFree === null && m > nowMin) nextFree = s;
    } else if (st === 'in_chair') {
      cls += ' now';
      label = 'in the chair';
    } else {
      cls += ' taken';
      label = 'booked';
    }
    if (m + len <= nowMin) cls += ' past';
    return `<div class="${cls}" title="${fmtTime(s)}: ${label}">${fmtTime(s)}</div>`;
  }).join('');

  const ahead = rows.filter((r) => WAITING.includes(r.status) && toMin(r.slot_time) + len > nowMin).length;
  summary.innerHTML = nextFree
    ? `<span class="big">${ahead}</span><span class="muted">ahead in the queue &middot; next free slot <b class="gold">${fmtTime(nextFree)}</b></span>`
    : `<span class="muted">${esc(t('queue_full'))}</span>`;

  const open = nowMin >= toMin(cfg.open_time) && nowMin < toMin(cfg.close_time);
  const current = slots.find((s) => toMin(s) <= nowMin && nowMin < toMin(s) + len);
  const busy = rows.some((r) => r.status === 'in_chair')
    || (current && rows.some((r) => WAITING.includes(r.status) && Math.abs(toMin(r.slot_time) - toMin(current)) < len));
  const freeNow = open && !busy;
  renderFreeBanner(freeNow);
  if (wasBusy === true && freeNow) {
    notify(`${cfg.shop_name} is free now`, t('queue_free_banner'), { tag: 'shop-free' });
  }
  wasBusy = !freeNow;
  updateNotifyButton(freeNow);
  checkNextUp();
}

// ---------------------------------------------------------------- style gallery
let dbStyles = [];
let selectedStyle = '';

async function loadDbStyles() {
  const rows = await rpcShared('list_haircut_styles');
  const byId = new Map();
  for (const r of rows || []) {
    if (!byId.has(r.style_id)) byId.set(r.style_id, { id: r.style_id, label: r.label, photos: [] });
    if (r.storage_path) byId.get(r.style_id).photos.push(publicFileUrl('haircut-styles', r.storage_path));
  }
  dbStyles = [...byId.values()].filter((s) => s.photos.length > 0);
}

function renderStyleGallery() {
  const cards = [
    ...HAIRCUT_STYLES.map((s) => ({ key: `static:${s.slug}`, label: s.label, cover: styleThumb(s) })),
    ...dbStyles.map((s) => ({ key: `db:${s.id}`, label: s.label, cover: s.photos[0] })),
  ];
  $('#style-gallery').innerHTML = cards.map((c) => `
    <button type="button" class="style-card" data-style="${esc(c.key)}">
      <img src="${esc(c.cover)}" alt="" loading="lazy" decoding="async" width="160" height="160">
      <span>${esc(c.label)}</span>
    </button>`).join('');
}

function setStyle(label) {
  selectedStyle = label;
  const chip = $('#bk-style-chip');
  chip.hidden = !label;
  chip.innerHTML = label ? `Style: <b>${esc(label)}</b> <button type="button" class="link-btn" id="bk-style-clear">Remove</button>` : '';
}

let lastFocus = null;
function closeModal() {
  $('#modal-root').innerHTML = '';
  document.removeEventListener('keydown', onModalKey);
  if (lastFocus) lastFocus.focus();
}
function onModalKey(e) { if (e.key === 'Escape') closeModal(); }

function openStyle(key) {
  let label;
  let photos;
  if (key.startsWith('static:')) {
    const s = HAIRCUT_STYLES.find((x) => x.slug === key.slice(7));
    if (!s) return;
    label = s.label;
    photos = stylePhotos(s);
  } else {
    const s = dbStyles.find((x) => x.id === key.slice(3));
    if (!s) return;
    label = s.label;
    photos = s.photos;
  }
  lastFocus = document.activeElement;
  const canBook = !cfg || !cfg.hidden.has('book');
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop" id="style-backdrop">
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="style-title">
        <button type="button" class="modal-close" id="style-close" aria-label="Close">&times;</button>
        <h3 id="style-title">${esc(label)}</h3>
        <div class="photo-strip">
          ${photos.map((p) => `<img src="${esc(p)}" alt="${esc(label)}" loading="lazy" decoding="async">`).join('')}
        </div>
        ${canBook ? '<button type="button" class="btn btn-gold btn-block" id="style-pick">Book this style</button>' : ''}
      </div>
    </div>`;
  $('#style-close').addEventListener('click', closeModal);
  $('#style-backdrop').addEventListener('click', (e) => { if (e.target.id === 'style-backdrop') closeModal(); });
  document.addEventListener('keydown', onModalKey);
  const pick = $('#style-pick');
  if (pick) {
    pick.addEventListener('click', () => {
      setStyle(label);
      lastFocus = null;
      closeModal();
      document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
      $('#bk-name').focus({ preventScroll: true });
    });
  }
  $('#style-close').focus();
}

// ---------------------------------------------------------------- "can't find your style"
const UPLOAD_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };

async function submitStyleRequest(e) {
  e.preventDefault();
  const msg = $('#sr-msg');
  showMsg(msg, '');
  const desc = $('#sr-desc').value.trim();
  const file = $('#sr-photo').files[0];
  if (!desc && !file) { showMsg(msg, 'Describe the style or add a photo of it.', 'error'); return; }
  await withBusy($('#sr-submit'), async () => {
    try {
      const token = deviceToken();
      let path = null;
      if (file) {
        const blob = await prepareImage(file);
        const ext = UPLOAD_EXT[blob.type];
        if (!ext) { showMsg(msg, 'Please choose a JPG, PNG or WebP photo.', 'error'); return; }
        path = `${token}/${Date.now()}.${ext}`;
        await uploadFile('style-requests', path, blob);
      }
      await rpc('submit_style_request', { p_token: token, p_description: desc, p_storage_path: path });
      showMsg(msg, t('request_sent'), 'ok');
      $('#sr-form').reset();
    } catch (err) {
      showError(msg, err);
    }
  });
}

// ---------------------------------------------------------------- paying first (get_pay_info)
// While the owner has "pay before booking" on and has saved payment details, the form shows those
// details to everyone, and the day and time only open once a screenshot of the payment has been
// read and checked (lib/proof.js, on this phone). The database checks what it can again when the
// booking is made, and the owner looks at the screenshot and confirms the money himself.
const PAY_KEY = 'ac_pay_info';
let payInfo = null; // { required, instructions, amount_kwacha }, or null when the database has no pay-first yet

function savedPayInfo() {
  try {
    const row = JSON.parse(storageGet(PAY_KEY) || 'null');
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

async function loadPayInfo() {
  let row;
  try {
    row = await rpc('get_pay_info');
  } catch (err) {
    if (!isMissingFunction(err)) return false; // keep what we had
    row = null; // the database has no pay-first yet; asked again next time, so it starts once it has
  }
  row = Array.isArray(row) ? row[0] : row;
  const next = row ? { required: !!row.required, instructions: row.instructions || '', amount_kwacha: Number(row.amount_kwacha), auto: !!row.auto } : null;
  const changed = JSON.stringify(next) !== JSON.stringify(payInfo);
  payInfo = next;
  storageSet(PAY_KEY, JSON.stringify(next));
  return changed;
}

const payRequired = () => !!(payInfo && payInfo.required);
const payAuto = () => !!(payInfo && payInfo.required && payInfo.auto);   // checked against the owner's received messages
const proofOk = () => !!(proof && proof.status === 'approved');
const txnValue = () => $('#bk-txn').value.trim();
const txnOk = () => !!(txnState && txnState.status === 'ok' && txnState.txn.toLowerCase() === txnValue().toLowerCase());
const payVerified = () => (payAuto() ? txnOk() : proofOk());

function renderPayFirst() {
  if (!cfg) return;
  const on = payRequired();
  $('#bk-pay').hidden = !on;
  if (on) {
    $('#bk-pay-amount').textContent = `K${Number(payInfo.amount_kwacha).toFixed(0)}`;
    $('#bk-pay-details').textContent = payInfo.instructions;
    $('#bk-pay-intro').textContent = t(payAuto() ? 'pay_auto_intro' : 'pay_first_intro');
    $('#bk-proof-label').textContent = t(payAuto() ? 'pay_proof_label_auto' : 'pay_proof_label');
  }
  $('#bk-auto').hidden = !(on && payAuto());
  renderProof();
  renderTxn();
  updatePayLock();
}

function updatePayLock() {
  const locked = payRequired() && !payVerified();
  $('#bk-slots').disabled = locked;
  $('#bk-locked').hidden = !locked;
  $('#bk-locked').textContent = t(payAuto() ? 'pay_locked_auto' : 'pay_locked');
}

// ---- automatic checking: the transaction ID is looked for among the messages on the owner's phone
let txnState = null; // null, or { txn, status: 'looking' | 'ok' | 'none' | 'giveup' | 'low' | 'used', note }
let txnRun = 0;

function renderTxn() {
  const box = $('#bk-txn-status');
  if (!payAuto() || !txnState) { box.hidden = true; box.innerHTML = ''; box.className = 'proof-status'; return; }
  const st = txnState.status;
  box.hidden = false;
  const note = txnState.note ? `<p class="small muted">${esc(txnState.note)}</p>` : '';
  if (st === 'ok') {
    box.className = 'proof-status ok';
    box.innerHTML = `<h4>${esc(t('pay_found'))}</h4>${note}<p><b>${esc(t('pay_proof_show'))}</b></p>`;
  } else if (st === 'looking' || st === 'none') {
    box.className = 'proof-status busy';
    box.innerHTML = `<div>${esc(t(st === 'none' ? 'pay_none' : 'pay_checking'))}&hellip;</div><div class="proof-bar"><i style="width:${Math.min(100, Math.round(((txnState.tries || 0) / 30) * 100))}%"></i></div>${note}`;
  } else if (st === 'readfail') {
    box.className = 'proof-status bad';
    box.innerHTML = `<p>${esc(txnState.note)}</p>`;
  } else if (st === 'giveup') {
    box.className = 'proof-status bad';
    box.innerHTML = `<h4>${esc(t('pay_giveup'))}</h4>${note}${callHtml()}`;
  } else {
    box.className = 'proof-status bad';
    box.innerHTML = `<h4>${esc(t(st === 'low' ? 'pay_low' : 'pay_used'))}</h4>${note}${callHtml()}`;
  }
}

async function checkTxn(note = '') {
  const txn = txnValue();
  const run = ++txnRun;
  if (txn.length < 5) { txnState = null; renderTxn(); updatePayLock(); return; }
  txnState = { txn, status: 'looking', tries: 0, note };
  renderTxn();
  updatePayLock();
  // The message can reach the owner's phone a little after the payment, so it keeps looking for about two minutes.
  for (let tries = 0; tries < 30; tries++) {
    let answer;
    try {
      answer = await rpc('check_payment', { p_txn: txn });
    } catch {
      answer = 'none';
    }
    if (run !== txnRun) return;
    if (answer === 'ok' || answer === 'low' || answer === 'used') {
      txnState = { txn, status: answer, note };
      renderTxn();
      updatePayLock();
      return;
    }
    txnState = { txn, status: 'none', tries: tries + 1, note };
    renderTxn();
    await new Promise((r) => setTimeout(r, 4000));
    if (run !== txnRun) return;
  }
  txnState = { txn, status: 'giveup', note };
  renderTxn();
  updatePayLock();
}

// ---- the screenshot: read, checked, shown to the client before they book
let proof = null; // null, or { status: 'busy' | 'approved' | 'rejected' | 'error', ... }
let proofRun = 0;

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: CONFIG.timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not shown');

function callHtml() {
  const tel = String((cfg && cfg.phone) || '').replace(/[^\d+]/g, '');
  const text = esc(t('pay_proof_call'));
  return tel.length >= 9
    ? `<p>${text}</p><a class="btn btn-gold btn-sm proof-call" href="tel:${esc(tel)}">Call ${esc(ownerFirst())}</a>`
    : `<p>${text}</p>`;
}

function factsHtml(p) {
  const { info, parsed } = p;
  const m = info.meta || {};
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const to = parsed.recipient.name_ok ? cfg.owner_name : (parsed.recipient.account_ok ? `Account ${parsed.recipient.account}` : 'Not found');
  const made = [m.software, m.xmp].filter(Boolean).join(', ') || 'No editing app found';
  const cam = [m.make, m.model].filter(Boolean).join(' ') || (m.exposure ? 'Camera settings found' : 'None (a screenshot)');
  return `
    <table class="proof-facts">
      ${row('Paid to', to)}
      ${row('Amount', parsed.amount ? `K${Number(parsed.amount.value).toFixed(Number.isInteger(parsed.amount.value) ? 0 : 2)}` : 'Not found')}
      ${row('Transaction ID', parsed.txn_id || 'Not found')}
      ${row('Date and time', [parsed.date, parsed.time].filter(Boolean).join(' ') || 'Not found')}
      ${row('Paid with', parsed.network || 'Not shown')}
    </table>
    <details>
      <summary>The file and what we checked</summary>
      <table class="proof-facts">
        ${row('File name', info.name || 'Not shown')}
        ${row('Type', info.kind ? info.kind.toUpperCase() : 'Not a picture')}
        ${row('Size', fmtBytes(info.size))}
        ${row('Pixels', info.width ? `${info.width} x ${info.height}` : 'Unknown')}
        ${row('File saved', fmtWhen(info.modified))}
        ${row('Made with', made)}
        ${row('Camera', cam)}
        ${m.taken ? row('Taken', m.taken) : ''}
        ${row('Fingerprint', info.sha256.slice(0, 16))}
      </table>
      <ul class="proof-checks">
        ${p.judged.checks.map((c) => `<li class="${c.ok ? '' : 'no'}">${esc(c.label)}${c.ok || !c.detail ? '' : ` <span class="muted">(${esc(c.detail)})</span>`}</li>`).join('')}
      </ul>
    </details>`;
}

function renderProof() {
  const box = $('#bk-proof-status');
  if (!proof || !payRequired()) { box.hidden = true; box.innerHTML = ''; box.className = 'proof-status'; return; }
  box.hidden = false;
  if (proof.status === 'busy') {
    box.className = 'proof-status busy';
    box.innerHTML = `<div>${esc(proof.label || 'Reading your screenshot')}&hellip;</div><div class="proof-bar"><i style="width:${Math.round((proof.pct || 0) * 100)}%"></i></div><p class="small muted">This runs on your phone and can take up to a minute.</p>`;
  } else if (proof.status === 'error') {
    box.className = 'proof-status bad';
    box.innerHTML = `<h4>${esc(t('pay_proof_bad'))}</h4><p>We couldn't read it just now. Please try again, or use a clearer screenshot.</p>${callHtml()}`;
  } else if (proof.status === 'approved') {
    box.className = 'proof-status ok';
    box.innerHTML = `<h4>${esc(t('pay_proof_ok'))}</h4>${factsHtml(proof)}
      ${proof.judged.warnings.length ? `<p class="small muted">Not clear in the picture: ${esc(proof.judged.warnings.join(' '))}</p>` : ''}
      <p><b>${esc(t('pay_proof_show'))}</b></p>`;
  } else {
    box.className = 'proof-status bad';
    box.innerHTML = `<h4>${esc(t('pay_proof_bad'))}</h4>
      <ul>${proof.judged.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${factsHtml(proof)}${callHtml()}`;
  }
}

async function readIdFromScreenshot(file, run) {
  proof = { status: 'busy', pct: 0.02, label: 'Reading your screenshot' };
  renderProof();
  try {
    const ocr = await readText(file, (pct, label) => {
      if (run !== proofRun) return;
      proof = { status: 'busy', pct, label };
      renderProof();
    });
    if (run !== proofRun) return;
    const parsed = parseProofText(ocr.text, { ownerName: cfg.owner_name, accountNumbers: accountNumbers(payInfo.instructions), today: todayISO() });
    proof = null;
    renderProof();
    if (parsed.txn_id) {
      $('#bk-txn').value = parsed.txn_id;
      checkTxn(t('pay_read_id', { ref: parsed.txn_id })).catch(() => {});
    } else {
      txnState = { txn: txnValue(), status: 'readfail', note: t('pay_read_fail') };
      renderTxn();
      updatePayLock();
    }
  } catch {
    if (run !== proofRun) return;
    proof = null;
    renderProof();
    txnState = { txn: txnValue(), status: 'readfail', note: t('pay_read_fail') };
    renderTxn();
    updatePayLock();
  }
}

async function onProofPicked() {
  const file = $('#bk-proof').files && $('#bk-proof').files[0];
  const run = ++proofRun;
  proof = null;
  if (!file || !cfg || !payInfo) { renderProof(); updatePayLock(); return; }
  if (payAuto()) { await readIdFromScreenshot(file, run); return; }
  proof = { status: 'busy', pct: 0.02, label: 'Checking the file' };
  renderProof();
  updatePayLock();
  try {
    const info = await readFileInfo(file);
    if (run !== proofRun) return;
    let ocr = { text: '', confidence: 0, words: 0 };
    if (info.kind && info.size <= MAX_BYTES) {
      ocr = await readText(file, (pct, label) => {
        if (run !== proofRun) return;
        proof = { status: 'busy', pct, label };
        renderProof();
      });
    }
    if (run !== proofRun) return;
    const ctx = { ownerName: cfg.owner_name, accountNumbers: accountNumbers(payInfo.instructions), today: todayISO() };
    const parsed = parseProofText(ocr.text, ctx);
    const judged = judgeProof({ file: info, ocr, parsed }, { price: payInfo.amount_kwacha, ownerName: cfg.owner_name, today: todayISO() });
    proof = { status: judged.verdict, file, info, ocr, parsed, judged, path: '' };
  } catch {
    if (run !== proofRun) return;
    proof = { status: 'error' };
  }
  renderProof();
  updatePayLock();
}

// Puts the picture in the private bucket (the owner reads it from there) and answers its path.
async function uploadProof(p) {
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp' }[p.info.kind];
  const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[p.info.kind];
  const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const path = `${deviceToken()}/${id}.${ext}`;
  const blob = p.file.type === mime ? p.file : new File([p.file], `proof.${ext}`, { type: mime });
  await uploadFile('payment-proofs', path, blob);
  return path;
}

// ---------------------------------------------------------------- booking form
function buildDateOptions() {
  const sel = $('#bk-date');
  const prev = sel.value;
  const options = shopDateOptions(cfg.booking_days_ahead, cfg.closed_weekdays);
  sel.innerHTML = options.map((o) => `<option value="${o.iso}"${o.closed ? ' disabled' : ''}>${esc(o.label)}${o.closed ? ' (closed)' : ''}</option>`).join('');

  const open = options.filter((o) => !o.closed);
  let pick = open.find((o) => o.iso === prev);
  if (!pick && open.length) {
    // Late in the day, start on the next open day instead of an empty "today".
    const lastStart = toMin(cfg.close_time) - cfg.slot_minutes;
    pick = open[0].iso === todayISO() && nowMinutesInShopTz() >= lastStart && open[1] ? open[1] : open[0];
  }
  sel.value = pick ? pick.iso : '';
  refreshSlotOptions();
}

let slotRequest = 0;
async function refreshSlotOptions() {
  if (!cfg) return;
  const sel = $('#bk-slot');
  const iso = $('#bk-date').value;
  const req = ++slotRequest;
  if (!iso) { sel.innerHTML = '<option value="">No open days</option>'; return; }
  if (cfg.closed_weekdays.includes(weekdayOf(iso))) { sel.innerHTML = '<option value="">Closed that day</option>'; return; }
  sel.disabled = true;
  let rows;
  try {
    rows = await getDay(iso);
  } catch {
    if (req === slotRequest) { sel.innerHTML = '<option value="">Couldn\'t load times</option>'; sel.disabled = false; }
    return;
  }
  if (req !== slotRequest) return;
  const len = cfg.slot_minutes;
  const slots = daySlots(cfg.open_time, cfg.close_time, len);
  const taken = slotStatuses(slots, rows, len);
  const isToday = iso === todayISO();
  const nowMin = nowMinutesInShopTz();
  const free = slots.filter((s) => !taken.has(s) && (!isToday || toMin(s) > nowMin));
  const prev = sel.value;
  sel.innerHTML = free.length
    ? free.map((s) => `<option value="${s}">${fmtTime(s)}</option>`).join('')
    : '<option value="">No free times that day</option>';
  if (free.includes(prev)) sel.value = prev;
  sel.disabled = false;
}

// One booking at a time (the database checks this too, by phone number and by device): while this
// device holds a booking that's still waiting or in the chair, the form says so instead.
function heldBooking() {
  const today = todayISO();
  return myRows.find((r) => (WAITING.includes(r.status) || r.status === 'in_chair') && r.booking_date >= today) || null;
}

function updateBookingLimit() {
  const held = heldBooking();
  const note = $('#bk-held');
  note.hidden = !held;
  if (held) note.querySelector('p').textContent = t('book_one_only', { time: fmtTime(held.slot_time), date: fmtDate(held.booking_date) });
  $('#booking-form').classList.toggle('is-held', !!held);
  $('#bk-submit').disabled = !!held;
}

async function submitBooking(e) {
  e.preventDefault();
  const msg = $('#bk-msg');
  showMsg(msg, '');
  if (!cfg) { showMsg(msg, GENERIC_ERROR, 'error'); return; }
  if (heldBooking()) { updateBookingLimit(); return; }
  const date = $('#bk-date').value;
  const slot = $('#bk-slot').value;
  const name = $('#bk-name').value.trim();
  const phone = $('#bk-phone').value.trim();
  if (payRequired() && !payVerified()) {
    showMsg(msg, t(payAuto() ? 'pay_locked_auto' : 'pay_locked'), 'error');
    (payAuto() ? $('#bk-txn') : $('#bk-proof')).focus();
    return;
  }
  if (!date || !slot) { showMsg(msg, 'Please pick a day and a time.', 'error'); return; }
  if (!name) { showMsg(msg, 'Please enter your name.', 'error'); $('#bk-name').focus(); return; }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) {
    showMsg(msg, 'Please enter a valid phone number.', 'error');
    $('#bk-phone').focus();
    return;
  }

  await withBusy($('#bk-submit'), async () => {
    try {
      const args = { p_date: date, p_slot: slot, p_name: name, p_phone: phone, p_style: selectedStyle || null };
      const paid = payRequired();
      if (paid && payAuto()) {
        args.p_pay_ref = txnState.txn;
      } else if (paid) {
        if (!proof.path) {
          try {
            proof.path = await uploadProof(proof);
          } catch {
            showMsg(msg, 'Your screenshot did not upload. Please check your connection and try again.', 'error');
            return;
          }
        }
        args.p_pay_ref = proof.parsed.txn_id;
        args.p_proof = buildProof({ file: proof.info, ocr: proof.ocr, parsed: proof.parsed, judged: proof.judged, path: proof.path });
      }
      // Older databases don't take p_device yet.
      const token = await rpcOr('book_slot', { ...args, p_device: deviceToken() }, () => rpc('book_slot', args), 'book_slot+device');
      addBookingToken(token);
      showMsg(msg, t(paid ? 'book_done_paid' : 'book_done', { time: fmtTime(slot), date: fmtDate(date) }), 'ok');
      const st = appStatus();
      if (android && st && !st.ready) {
        try { android.requestAlerts(); } catch { /* older app */ }
      }
      $('#bk-name').value = '';
      $('#bk-phone').value = '';
      $('#bk-proof').value = '';
      $('#bk-txn').value = '';
      proofRun++;
      txnRun++;
      proof = null;
      txnState = null;
      renderProof();
      renderTxn();
      updatePayLock();
      setStyle('');
      invalidateDays();
      await Promise.allSettled([loadQueue(), refreshSlotOptions(), refreshMyBookings()]);
      if (!android) showDock(true);
    } catch (err) {
      showError(msg, err);
      invalidateDays();
      refreshSlotOptions();
      loadPayInfo().then((changed) => { if (changed) renderPayFirst(); }).catch(() => {}); // the owner may have changed it
    }
  });
  updateBookingLimit();
}

// ---------------------------------------------------------------- my bookings (held on this device)
const STATUS_LABEL = {
  booked: 'Booked', on_deck: '2 away', called: "You're next", checked_in: 'Checked in',
  in_chair: 'In the chair', done: 'Done', no_show: 'Missed', cancelled: 'Cancelled',
};
let myRows = [];
let myPollTimer = null;
const paymentDetails = new Map(); // token -> get_payment_details() row

function sortBookings(rows) {
  const active = rows.filter((r) => WAITING.includes(r.status) || r.status === 'in_chair')
    .sort((a, b) => (a.booking_date + a.slot_time).localeCompare(b.booking_date + b.slot_time));
  const past = rows.filter((r) => !active.includes(r))
    .sort((a, b) => (b.booking_date + b.slot_time).localeCompare(a.booking_date + a.slot_time));
  return [...active, ...past].slice(0, 4);
}

async function refreshMyBookings() {
  clearTimeout(myPollTimer);
  const tokens = bookingTokens();
  if (!tokens.length) {
    myRows = [];
    renderMyBookings();
    setAlarms([]);
    return;
  }
  try {
    const rows = await rpcOr('get_my_bookings', { p_tokens: tokens },
      async () => (await Promise.all(tokens.map((tk) => rpc('get_my_booking', { p_token: tk })))).flat());
    const cutoff = addDaysISO(todayISO(), -3);
    const keep = (rows || []).filter((r) => r && r.booking_date >= cutoff);
    const keepSet = new Set(keep.map((r) => r.client_token));
    const drop = new Set(tokens.filter((tk) => !keepSet.has(tk)));
    if (drop.size) setBookingTokens(bookingTokens().filter((tk) => !drop.has(tk)));

    const wasRequested = new Set(myRows.filter((r) => r.payment_status === 'requested').map((r) => r.client_token));
    const wasSubmitted = new Set(myRows.filter((r) => r.payment_status === 'submitted' && WAITING.includes(r.status)).map((r) => r.client_token));
    for (const r of keep) {
      let say = '';
      if (wasRequested.has(r.client_token) && r.payment_status === 'none' && r.payment_expired_at) say = t('pay_expired');
      else if (wasSubmitted.has(r.client_token) && r.payment_status === 'paid') say = t('pay_confirmed', { time: fmtTime(r.slot_time) });
      else if (wasSubmitted.has(r.client_token) && r.payment_status === 'rejected') say = t('pay_not_found', { time: fmtTime(r.slot_time) });
      else if (wasSubmitted.has(r.client_token) && r.payment_status === 'submitted' && r.status === 'cancelled') say = t('pay_unconfirmed', { time: fmtTime(r.slot_time) });
      if (!say) continue;
      toast(say);
      if (document.hidden && !android) notify(cfg.shop_name, say, { tag: `pay-${r.client_token}` });
    }
    myRows = sortBookings(keep);
    renderMyBookings();
    setAlarms(keep);
    syncPush();
    if (!android) updateArrivalWatch({ cfg, rows: keep, onCheckedIn: onArrived });
    checkNextUp();
  } finally {
    const active = myRows.some((r) => WAITING.includes(r.status) || r.status === 'in_chair');
    if (bookingTokens().length) myPollTimer = setTimeout(() => refreshMyBookings().catch(() => {}), active ? 15000 : 60000);
  }
}

function setAlarms(rows) {
  if (!android) {
    updateAlarms(rows.filter((r) => WAITING.includes(r.status)));
    return;
  }
  if (!cfg) return;
  const payload = {
    api: { url: CONFIG.supabase.url, key: CONFIG.supabase.anonKey },
    device: hasDeviceToken() ? deviceToken() : '',
    shop: cfg.shop_name,
    ownerFirst: ownerFirst(),
    reminderMinutes: cfg.reminder_minutes,
    slotMinutes: cfg.slot_minutes,
    texts: {
      reminder: t('alert_reminder', { mins: '{mins}' }),
      now: t('alert_now'),
      called: t('alert_called'),
      onDeck: t('alert_on_deck'),
      arrived: t('alert_arrived'),
      nextHere: t('alert_next_here'),
    },
    // The shop's location, when the owner has set it, for checking in on arrival (Arrival.java).
    arrival: arrivalAvailable(cfg)
      ? { lat: Number(cfg.shop_lat), lng: Number(cfg.shop_lng), radius: Number(cfg.arrival_radius_m) || 150 }
      : null,
    tokens: bookingTokens(),
    bookings: rows.filter((r) => WAITING.includes(r.status)).map((r) => {
      const start = shopTimeToEpoch(r.booking_date, r.slot_time);
      return { token: r.client_token, id: r.id, status: r.status, startMs: start, endMs: start + cfg.slot_minutes * 60000, label: fmtTime(r.slot_time), slot: r.slot_time };
    }),
  };
  try { android.syncBookings(JSON.stringify(payload)); } catch { /* an older app without this call */ }
}

function countdown(b) {
  if (!WAITING.includes(b.status)) return '';
  const ms = startsIn(b);
  if (b.status === 'checked_in') return isNextUp(b) ? t('alert_next_here') : "You're checked in. We'll tell you when you're next.";
  if (ms <= 0) return 'Your slot has started. Please go to the chair.';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Starts in ${mins} min`;
  if (mins < 24 * 60) return `Starts in ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `Starts ${fmtDate(b.booking_date)} at ${fmtTime(b.slot_time)}`;
}

function paymentHtml(b) {
  const token = esc(b.client_token);
  const closed = ['no_show', 'cancelled'].includes(b.status);
  switch (b.payment_status) {
    case 'none':
      // A request not approved by the slot time is cleared then, and can't be made after that.
      if (b.payment_expired_at && !closed && b.status !== 'done') return `<p class="small pay-expired">${esc(t('pay_expired'))}</p>`;
      // With pay-first on, everyone pays up front, so there is no "pay online instead".
      return closed || b.status === 'done' || startsIn(b) <= 0 || payRequired() ? '' : `<button type="button" class="link-btn" data-act="pay" data-token="${token}">Pay online instead</button>`;
    case 'submitted':
      if (closed) return `<p class="small pay-expired">${esc(t('pay_unconfirmed', { time: fmtTime(b.slot_time) }))}</p>`;
      return `<p class="small muted">${esc(t('pay_confirming', { ref: b.payment_ref || '', time: fmtTime(b.slot_time) }))}</p>`;
    case 'rejected':
      return `<p class="small pay-expired">${esc(t('pay_not_found', { time: fmtTime(b.slot_time) }))}</p>`;
    case 'requested':
      return `<p class="small muted">${esc(t('pay_waiting', { time: fmtTime(b.slot_time) }))}</p>`;
    case 'approved': {
      const p = paymentDetails.get(b.client_token);
      if (!p) return `<div class="payment-box" data-pay-details="${token}"><span class="muted small">Loading payment details&hellip;</span></div>`;
      return `
        <div class="payment-box">
          <p class="payment-note">Only pay to the details below, for this booking. ${esc(cfg.shop_name)} isn't responsible for money sent anywhere else.</p>
          <p><b>Amount:</b> K${Number(p.amount_kwacha).toFixed(0)}</p>
          <pre>${esc(p.instructions)}</pre>
          <p class="small muted">After paying, let ${esc(ownerFirst())} know in person or in the chat. Your receipt appears here once the payment is confirmed.</p>
        </div>`;
    }
    case 'paid':
      return `<div class="paid-row"><span class="form-msg ok">Payment received. Thank you!</span><button type="button" class="btn btn-ghost btn-sm" data-act="receipt" data-token="${token}">Receipt</button></div>`;
    default:
      return '';
  }
}

function ticketHtml(b) {
  const token = esc(b.client_token);
  const active = WAITING.includes(b.status);
  const isToday = b.booking_date === todayISO();
  const actions = [];
  if (isToday && ['booked', 'on_deck', 'called'].includes(b.status)) {
    actions.push(`<button type="button" class="btn btn-gold btn-sm" data-act="checkin" data-token="${token}">I'm here</button>`);
  }
  if (active && startsIn(b) > 0 && !android) {
    actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="calendar" data-token="${token}">Add to calendar</button>`);
  }
  if (active) actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="cancel" data-token="${token}">Cancel</button>`);
  const note = countdown(b);
  const arrival = isToday && ['booked', 'on_deck', 'called'].includes(b.status) ? arrivalHtml() : '';
  return `
    <div class="ticket${active ? ' active' : ''}">
      <div class="ticket-head">
        <div>
          <div class="ticket-time">${fmtTime(b.slot_time)} <span class="muted">&middot; ${esc(fmtDate(b.booking_date))}</span></div>
          <div class="muted small">${esc(b.client_name)}${b.style_choice ? ` &middot; ${esc(b.style_choice)}` : ''}</div>
        </div>
        <span class="status-pill status-${esc(b.status)}">${esc(STATUS_LABEL[b.status] || b.status)}</span>
      </div>
      ${note ? `<p class="ticket-note">${esc(note)}</p>` : ''}
      ${actions.length ? `<div class="ticket-actions">${actions.join('')}</div>` : ''}
      ${arrival}
      ${paymentHtml(b)}
    </div>`;
}

// ---------------------------------------------------------------- checking in on arrival (lib/arrival.js)
// "Check me in when I arrive" on today's ticket. In the Android app the app does the checking (even
// when it's closed) and reports how it's set up; in a browser it works while the page is open.
function arrivalHtml() {
  if (!arrivalAvailable(cfg)) return '';
  const off = '<button type="button" class="link-btn" data-act="arrival-off">Turn off</button>';
  if (android) {
    if (typeof android.enableArrival !== 'function') return '';
    const a = (appStatus() || {}).arrival || {};
    if (!a.on) return `<div class="arrival-row"><button type="button" class="btn btn-ghost btn-sm" data-act="arrival-on">Check me in when I arrive</button><p class="small muted">Uses your location only on the day of your booking, from two hours before your slot.</p></div>`;
    if (!a.location) return `<div class="arrival-row"><p class="small muted">Allow location so the app can check you in when you arrive.</p><button type="button" class="btn btn-ghost btn-sm" data-act="arrival-on">Allow location</button> ${off}</div>`;
    if (!a.background) return `<div class="arrival-row"><p class="small muted">The app checks you in while it's open. To be checked in with the app closed, allow location all the time.</p><button type="button" class="btn btn-ghost btn-sm" data-act="arrival-on">Allow all the time</button> ${off}</div>`;
    return `<div class="arrival-row"><p class="small ok-text">We'll check you in when you arrive.</p> ${off}</div>`;
  }
  if (!('geolocation' in navigator)) return '';
  if (!arrivalOn()) return `<div class="arrival-row"><button type="button" class="btn btn-ghost btn-sm" data-act="arrival-on">Check me in when I arrive</button><p class="small muted">Uses your location while this page is open, only on the day of your booking.</p></div>`;
  if (arrivalDenied()) return `<div class="arrival-row"><p class="small muted">Location is blocked for this site, so you can't be checked in automatically. Tap "I'm here" when you arrive.</p> ${off}</div>`;
  return `<div class="arrival-row"><p class="small ok-text">We'll check you in when you arrive. Keep this page open.</p> ${off}</div>`;
}

function onArrived() {
  toast(t('alert_arrived'));
  if (document.hidden) notify(cfg.shop_name, t('alert_arrived'), { tag: 'arrived' });
  refreshMyBookings().catch(() => {});
}

// A checked-in client is next when nobody still waiting has an earlier slot today (from the public
// queue, refreshed every 20 seconds while the page is open).
function isNextUp(b) {
  if (b.status !== 'checked_in' || b.booking_date !== todayISO()) return false;
  if (!todayQueue || Date.now() - todayQueue.at > 120000) return false;
  const mine = toMin(b.slot_time);
  if (!todayQueue.rows.some((r) => r.status === 'checked_in' && toMin(r.slot_time) === mine)) return false;
  return !todayQueue.rows.some((r) => WAITING.includes(r.status) && toMin(r.slot_time) < mine);
}

// Says "you're next, please don't leave" once per booking. Inside the app, the app's own notification
// does that, so the page only updates the ticket.
const nextShown = new Set();
function checkNextUp() {
  let changed = false;
  for (const b of myRows) {
    if (!isNextUp(b) || nextShown.has(b.client_token)) continue;
    nextShown.add(b.client_token);
    changed = true;
    const key = `alphi.next.${b.client_token}`;
    if (storageGet(key) === '1') continue; // already told on an earlier visit
    storageSet(key, '1');
    toast(t('alert_next_here'));
    if (!android) {
      chime({ force: true });
      notify(cfg.shop_name, t('alert_next_here'), { tag: `next-${b.client_token}` });
    }
  }
  if (changed) renderMyBookings();
}

async function setArrival(on) {
  if (android) {
    try { if (on) android.enableArrival(); else android.disableArrival(); } catch { /* older app */ }
    renderMyBookings();
    return;
  }
  if (on) turnArrivalOn(() => { renderMyBookings(); refreshMyBookings().catch(() => {}); });
  else turnArrivalOff();
  renderMyBookings();
}

function renderMyBookings() {
  const body = $('#my-booking-body');
  updateBookingLimit();
  if (!myRows.length) {
    body.innerHTML = `<p class="muted">${esc(t('my_empty'))}</p>`;
    return;
  }
  const hasActive = myRows.some((r) => WAITING.includes(r.status));
  body.innerHTML = myRows.map(ticketHtml).join('') + (hasActive ? alertSetupHtml() : '');
  loadPaymentDetails();
}

// Where people choose their own tones (lib/soundui.js).
const SOUNDS_LINK = '<button type="button" class="link-btn small snd-link" data-act="sounds">Choose your sounds</button>';

function alertSetupHtml() {
  if (android) {
    const st = appStatus();
    return `
    <div class="alert-setup">
      <p class="small muted">${esc(t('my_alert_note_app'))}</p>
      ${st && st.ready
        ? '<p class="small ok-text">Alerts are on.</p>'
        : `<button type="button" class="btn btn-gold btn-sm" data-act="alerts">Turn on alerts</button><p class="small muted">Needed so the app can ring when it's closed.</p>`}
      ${SOUNDS_LINK}
    </div>`;
  }
  const push = notifyState();
  if (push === 'on') {
    return `
    <div class="alert-setup">
      <p class="small ok-text">Notifications are on. We'll tell you when it's your turn, even with this site closed.</p>
      <button type="button" class="link-btn small" data-act="notify-panel">Notification settings</button>
      ${SOUNDS_LINK}
    </div>`;
  }
  if (push === 'off') {
    return `
    <div class="alert-setup">
      <p class="small muted">${esc(t('my_alert_note'))}</p>
      <button type="button" class="btn btn-gold btn-sm" data-act="notify-on">${esc(t('notify_button'))}</button>
      ${SOUNDS_LINK}
    </div>`;
  }
  if (push === 'ios-install' || push === 'blocked') {
    return `
    <div class="alert-setup">
      <p class="small muted">${push === 'blocked' ? 'Notifications are blocked for this site, so we can only ring while this page is open.' : esc(t('app_ios_note'))}</p>
      <button type="button" class="btn btn-gold btn-sm" data-act="notify-panel">Show me how</button>
      ${SOUNDS_LINK}
    </div>`;
  }
  // No push notifications in this browser: the page rings while it's open.
  const needsSetup = notifyPermission() === 'default' || !audioUnlocked();
  return `
    <div class="alert-setup">
      <p class="small muted">This page rings when your slot starts. Keep it open, or add the booking to your calendar.</p>
      ${needsSetup ? '<button type="button" class="btn btn-ghost btn-sm" data-act="alerts">Turn on alerts</button>' : ''}
      ${SOUNDS_LINK}
    </div>`;
}

async function loadPaymentDetails() {
  for (const slot of $$('[data-pay-details]')) {
    const token = slot.dataset.payDetails;
    try {
      let p = await rpc('get_payment_details', { p_token: token });
      p = Array.isArray(p) ? p[0] : p;
      if (!p) continue;
      paymentDetails.set(token, p);
    } catch {
      slot.innerHTML = `<span class="muted small">${esc(GENERIC_ERROR)}</span>`;
      continue;
    }
    renderMyBookings();
    return; // renderMyBookings calls this again for any others
  }
}

async function doCheckIn(token) {
  try {
    await rpc('check_in', { p_token: token });
    toast(`Thanks. ${ownerFirst()} knows you're here.`);
    await refreshMyBookings();
  } catch (err) {
    toastError(err);
  }
}

async function enableAlerts() {
  if (android) {
    try { android.requestAlerts(); } catch { /* older app */ }
    return;
  }
  unlockAudio();
  const perm = await requestNotifyPermission();
  chime({ force: true });
  if (perm === 'granted') toast("Alerts are on. We'll ring and send a notification when it's your turn.");
  else if (perm === 'denied') toast('Notifications are blocked in your browser settings, but this page will still ring while it is open.');
  else toast('Sound is on. Keep this page open and it will ring when it is your turn.');
  renderMyBookings();
}

function addToCalendar(b) {
  const ics = bookingIcs({
    uid: b.id,
    startMs: shopTimeToEpoch(b.booking_date, b.slot_time),
    minutes: cfg.slot_minutes,
    title: `Haircut at ${cfg.shop_name}`,
    location: cfg.address_line || cfg.shop_name,
    description: `Your ${fmtTime(b.slot_time)} slot at ${cfg.shop_name}. Please arrive a few minutes early.`,
    reminderMinutes: cfg.reminder_minutes || 10,
  });
  downloadFile(`haircut-${b.booking_date}.ics`, ics, 'text/calendar;charset=utf-8');
}

async function printReceipt(b) {
  let p;
  try {
    p = await rpc('get_payment_details', { p_token: b.client_token });
    p = Array.isArray(p) ? p[0] : p;
  } catch (err) { toastError(err); return; }
  if (!p || p.payment_status !== 'paid') { toast('The receipt is not ready yet.'); return; }
  const paidOn = b.paid_at ? new Date(b.paid_at) : new Date();
  $('#receipt-print').innerHTML = `
    <div class="receipt-doc">
      <img src="icons/logo-512.webp" class="r-logo" alt="">
      <h2>${esc(p.shop_name)}</h2>
      <div class="r-sub">Payment receipt</div>
      <div class="r-stamp">PAID</div>
      <table>
        <tr><td>Client</td><td>${esc(b.client_name)}</td></tr>
        <tr><td>Date</td><td>${esc(b.booking_date)}</td></tr>
        <tr><td>Time</td><td>${fmtTime(b.slot_time)}</td></tr>
        ${b.style_choice ? `<tr><td>Style</td><td>${esc(b.style_choice)}</td></tr>` : ''}
        <tr><td>Paid on</td><td>${esc(paidOn.toLocaleString('en-GB', { timeZone: CONFIG.timeZone }))}</td></tr>
        <tr class="r-total"><td>Total paid</td><td>K${Number(p.amount_kwacha).toFixed(0)}</td></tr>
      </table>
      <div class="r-foot">Booking ref: ${esc(String(b.id).slice(0, 8).toUpperCase())}<br>Thank you for choosing ${esc(p.shop_name)}.</div>
    </div>`;
  document.body.classList.add('printing-receipt');
  const cleanup = () => {
    document.body.classList.remove('printing-receipt');
    window.removeEventListener('afterprint', cleanup);
    window.removeEventListener('alphiapp', cleanup);
  };
  if (android) {
    window.addEventListener('alphiapp', cleanup); // fired when the app comes back from the print screen
    try { android.print(); } catch { cleanup(); }
    return;
  }
  window.addEventListener('afterprint', cleanup);
  window.print();
}

async function onTicketAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const token = btn.dataset.token;
  const b = myRows.find((r) => r.client_token === token);
  switch (btn.dataset.act) {
    case 'alerts':
      await enableAlerts();
      break;
    case 'notify-on':
      unlockAudio();
      chime({ force: true });
      await turnOnFromPage(btn);
      break;
    case 'notify-panel':
      openPanel();
      break;
    case 'sounds':
      openSounds();
      break;
    case 'checkin':
      await withBusy(btn, () => doCheckIn(token));
      break;
    case 'arrival-on':
      await setArrival(true);
      break;
    case 'arrival-off':
      await setArrival(false);
      break;
    case 'calendar':
      if (b) addToCalendar(b);
      break;
    case 'receipt':
      if (b) await withBusy(btn, () => printReceipt(b));
      break;
    case 'cancel':
      if (!window.confirm(b && ['submitted', 'paid'].includes(b.payment_status)
        ? `Cancel this booking? Your payment is not refunded automatically. Talk to ${ownerFirst()} about it.`
        : 'Cancel this booking?')) return;
      await withBusy(btn, async () => {
        try {
          await rpc('cancel_my_booking', { p_token: token });
          toast('Your booking is cancelled.');
          invalidateDays();
          await Promise.allSettled([refreshMyBookings(), loadQueue(), refreshSlotOptions()]);
        } catch (err) { toastError(err); }
      });
      break;
    case 'pay':
      await withBusy(btn, async () => {
        try {
          await rpc('request_online_payment', { p_token: token });
          toast(`Request sent. ${ownerFirst()} will approve it here.`);
          await refreshMyBookings();
        } catch (err) { toastError(err); }
      });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- reviews
async function loadReviews() {
  const list = $('#review-list');
  let rows;
  try {
    // Before the v2 database update the public couldn't read reviews at all; show none then.
    rows = await rpcOr('public_reviews', {}, () => []);
  } catch (e) {
    list.innerHTML = `<p class="muted">${esc(friendlyError(e))}</p>`;
    return;
  }
  if (!rows || !rows.length) { list.innerHTML = `<p class="muted">${esc(t('reviews_empty'))}</p>`; return; }
  list.innerHTML = rows.map((r) => {
    const n = Math.max(1, Math.min(5, Number(r.rating) || 0));
    return `
    <div class="review">
      <div class="stars-sm"><span class="gold" aria-label="${n} out of 5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span> <b>${esc(r.client_name || 'Anonymous')}</b></div>
      ${r.comment ? `<p class="small">${esc(r.comment)}</p>` : ''}
      ${r.reply ? `<div class="reply"><b>${esc(ownerFirst())}:</b> ${esc(r.reply)}</div>` : ''}
    </div>`;
  }).join('');
}

async function submitReview(e) {
  e.preventDefault();
  const msg = $('#rv-msg');
  showMsg(msg, '');
  await withBusy($('#rv-submit'), async () => {
    try {
      await rpc('submit_feedback', {
        p_name: $('#rv-name').value.trim(),
        p_rating: Number($('#rv-rating').value),
        p_comment: $('#rv-comment').value.trim(),
      });
      showMsg(msg, t('review_thanks'), 'ok');
      $('#review-form').reset();
    } catch (err) {
      showError(msg, err);
    }
  });
}

// ---------------------------------------------------------------- chat
let chatActive = false;
let ownerMsgCount = -1;
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit' });

function chatInView() {
  const r = $('#chat').getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}

async function loadChat() {
  const box = $('#chat-box');
  if (!hasDeviceToken()) return;
  const token = deviceToken();
  const rows = (await rpc('get_my_messages', { p_token: token })) || [];
  if (rows.length) chatActive = true;
  const owners = rows.filter((m) => m.sender === 'owner').length;
  if (ownerMsgCount >= 0 && owners > ownerMsgCount && (document.hidden || !chatInView())) {
    toast(`New message from ${ownerFirst()}.`);
    chime();
  }
  ownerMsgCount = owners;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = rows.length
    ? rows.map((m) => `<div class="msg ${m.sender === 'owner' ? 'owner' : 'client'}">${esc(m.body)}<time>${clock.format(new Date(m.created_at))}</time></div>`).join('')
    : `<p class="muted small">${esc(t('chat_empty'))}</p>`;
  if (nearBottom || rows.length < 4) box.scrollTop = box.scrollHeight;
  if (rows.some((m) => m.sender === 'owner' && !m.read_by_client)) {
    rpc('mark_messages_read_by_client', { p_token: token }).catch(() => {});
  }
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body) return;
  const msg = $('#chat-msg');
  await withBusy($('#chat-send'), async () => {
    try {
      await rpc('send_message', { p_token: deviceToken(), p_body: body });
      input.value = '';
      showMsg(msg, '');
      chatActive = true;
      await loadChat();
    } catch (err) {
      showError(msg, err);
    }
  });
}

// ---------------------------------------------------------------- get the app
function buildQrCode() {
  const img = $('#qr-image');
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(`${CONFIG.siteUrl}#get-app`)}`;
  if (img.getAttribute('src') !== src) img.src = src;
}

// Details of the latest Android app build (written by the build pipeline), or null if none yet.
let apkInfoPromise = null;
function apkInfo() {
  if (!apkInfoPromise) {
    apkInfoPromise = fetch('app/android.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => (info && info.versionName ? info : null))
      .catch(() => null);
  }
  return apkInfoPromise;
}

const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#pwa-install-btn').hidden = !$('#apk-ready').hidden;
});

async function setupAppSection() {
  if (android) return;
  if (isIOS) $('#app-ios').parentElement.prepend($('#app-ios'));
  const info = await apkInfo();
  if (!info) return;
  $('#apk-ready').hidden = false;
  $('#apk-missing').hidden = true;
  $('#apk-meta').textContent = `Version ${info.versionName} · ${fmtSize(Number(info.size) || 0)}`;
}

async function installWebApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* dismissed */ }
  installPrompt = null;
  $('#pwa-install-btn').hidden = true;
}

// ---------------------------------------------------------------- navigation
function wireNav() {
  const links = $('#nav-links');
  const toggle = $('#nav-toggle');
  const close = () => { links.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
  document.addEventListener('click', (e) => {
    if (links.classList.contains('open') && !links.contains(e.target) && !toggle.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// ---------------------------------------------------------------- wiring and start-up
function wire() {
  wireNav();
  $('#style-gallery').addEventListener('click', (e) => {
    const card = e.target.closest('[data-style]');
    if (card) openStyle(card.dataset.style);
  });
  $('#bk-style-chip').addEventListener('click', (e) => { if (e.target.id === 'bk-style-clear') setStyle(''); });
  $('#sr-form').addEventListener('submit', submitStyleRequest);
  $('#bk-date').addEventListener('change', refreshSlotOptions);
  $('#bk-proof').addEventListener('change', onProofPicked);
  $('#bk-check').addEventListener('click', () => checkTxn().catch(() => {}));
  $('#bk-txn').addEventListener('input', () => { txnRun++; txnState = null; renderTxn(); updatePayLock(); });
  $('#bk-txn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkTxn().catch(() => {}); } });
  $('#booking-form').addEventListener('submit', submitBooking);
  $('#my-booking-body').addEventListener('click', onTicketAction);
  $('#review-form').addEventListener('submit', submitReview);
  $('#chat-form').addEventListener('submit', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#notify-free-btn').addEventListener('click', async () => {
    const btn = $('#notify-free-btn');
    if (['on', 'off'].includes(notifyState())) {
      const next = await turnOnFromPage(btn, { free: true });
      if (next === 'on') btn.hidden = true;
      return;
    }
    const perm = await requestNotifyPermission();
    btn.hidden = true;
    if (perm === 'granted') toast(`We'll let you know when ${ownerFirst()} is free (while this page is open).`);
  });
  $('#pwa-install-btn').addEventListener('click', installWebApp);
  $('#qr-print-btn').addEventListener('click', () => window.print());
  // The app fires this when it comes back to the front (after a settings screen or printing).
  window.addEventListener('alphiapp', () => { if (myRows.length) renderMyBookings(); });
}

function showStartupError(err) {
  const text = friendlyError(err);
  $('#queue-summary').innerHTML = `<span class="muted">${esc(text)}</span>`;
  $('#review-list').innerHTML = `<p class="muted">${esc(text)}</p>`;
  $('#bk-slot').innerHTML = '<option value="">Unavailable</option>';
  showMsg($('#bk-msg'), text, 'error');
}

const CONFIG_KEY = 'ac_site_config';

function savedConfig() {
  try {
    const row = JSON.parse(storageGet(CONFIG_KEY) || 'null');
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

/** Fetches the shop's settings and keeps a copy for the next visit. Answers whether they changed. */
async function loadConfig() {
  const rows = await select('site_config', 'id=eq.1&select=*');
  if (!rows || !rows[0]) throw new Error('site settings missing');
  const text = JSON.stringify(rows[0]);
  const changed = text !== storageGet(CONFIG_KEY);
  if (changed) storageSet(CONFIG_KEY, text);
  cfg = normalizeConfig(rows[0]);
  return changed;
}

function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    invalidateDays();
    loadQueue().catch(() => {});
    loadPayInfo().then((changed) => { if (changed) renderPayFirst(); }).catch(() => {});
  }, 20000);
  setInterval(() => { if (!document.hidden && chatActive) loadChat().catch(() => {}); }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    invalidateDays();
    loadQueue().catch(() => {});
    refreshMyBookings().catch(() => {});
    if (chatActive) loadChat().catch(() => {});
  });
}

async function boot() {
  if (android) document.documentElement.classList.add('in-app');
  loadCustomSound(); // their own sound, if they saved one (lib/ringtone.js)
  renderStyleGallery();
  wire();
  loadDbStyles().then(() => { if (dbStyles.length) renderStyleGallery(); }).catch(() => {});
  setupAppSection().catch(() => {});
  watchAppUpdate(android); // inside the Android app: the update pop-up and bar (lib/appupdate.js)

  // The shop's settings from the last visit show the page straight away; the latest ones replace
  // them as soon as they arrive (and the page is drawn again only if something changed).
  payInfo = savedPayInfo();
  const saved = savedConfig();
  if (saved) {
    cfg = normalizeConfig(saved);
    loadConfig().then((changed) => { if (changed) { renderConfig(); loadQueue().catch(() => {}); } }).catch(() => {});
  }
  for (let attempt = 0; !cfg; attempt++) {
    try {
      await loadConfig();
    } catch (err) {
      if (attempt === 0) showStartupError(err);
      await new Promise((r) => setTimeout(r, Math.min(30000, 5000 * (attempt + 1))));
    }
  }
  showMsg($('#bk-msg'), '');
  loadPayInfo().then((changed) => { if (changed) renderPayFirst(); }).catch(() => {});
  renderConfig();
  initNotifyUi({
    text: (key, extra) => t(key, extra),
    ownerFirst,
    onAppAlerts: () => enableAlerts(),
    onChange: () => { if (myRows.length) renderMyBookings(); },
  }).catch(() => {});
  await Promise.allSettled([
    loadQueue(),
    loadReviews(),
    refreshMyBookings(),
    hasDeviceToken() ? loadChat() : Promise.resolve(),
  ]);
  startPolling();
}

boot();
// The service worker (sw.js) is registered by js/lib/autoupdate.js, on every page.
