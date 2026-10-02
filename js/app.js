import { CONFIG, VERSION } from './config.js';
import { rpc, rpcOr, select, uploadFile, publicFileUrl } from './lib/api.js';
import {
  $, $$, esc, showMsg, showError, toast, toastError, withBusy, friendlyError, installGlobalErrorHandlers, GENERIC_ERROR,
} from './lib/ui.js';
import {
  daySlots, fmtTime, fmtDate, todayISO, nowMinutesInShopTz, shopDateOptions, toMin, slotStatuses, weekdayOf,
  addDaysISO, shopTimeToEpoch,
} from './lib/slots.js';
import { deviceToken, hasDeviceToken, bookingTokens, addBookingToken, setBookingTokens } from './lib/client.js';
import { makeText, applyText, DEFAULT_TEXT } from './lib/content.js';
import { notifyPermission, requestNotifyPermission, notify } from './lib/notify.js';
import { armAudioUnlock, unlockAudio, audioUnlocked, chime } from './lib/ringtone.js';
import { configureAlarms, updateAlarms, startsIn } from './lib/alarm.js';
import { bookingIcs, downloadFile } from './lib/ics.js';
import { prepareImage } from './lib/image.js';
import { watchAppUpdate } from './lib/appupdate.js';
import { HAIRCUT_STYLES, styleThumb, stylePhotos } from './styles-data.js';

installGlobalErrorHandlers();
armAudioUnlock();

const WAITING = ['booked', 'on_deck', 'called', 'checked_in'];
const SECTION_IDS = ['styles', 'queue', 'book', 'reviews', 'chat', 'contact', 'get-app'];
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
  if (!c.hidden.has('get-app') && !android) buildQrCode();
  configureAlarms({
    text: (k, v) => t(k, v), onCheckIn: doCheckIn, toast,
    slotMinutes: c.slot_minutes, reminderMinutes: c.reminder_minutes, title: document.title,
  });
}

function renderContact() {
  const c = cfg;
  $('#ct-address').textContent = c.address_line || '';
  $('#ct-directions').textContent = c.directions_text || '';
  const about = $('#ct-about');
  about.textContent = c.about_text || '';
  about.hidden = !c.about_text;

  const links = [];
  const tel = String(c.phone || '').replace(/[^\d+]/g, '');
  if (tel) links.push(`<a class="btn btn-ghost" href="tel:${esc(tel)}">Call ${esc(c.phone)}</a>`);
  const wa = String(c.whatsapp || '').replace(/\D/g, '');
  if (wa) links.push(`<a class="btn btn-ghost" href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
  if (/^https:\/\//i.test(c.facebook || '')) links.push(`<a class="btn btn-ghost" href="${esc(c.facebook)}" target="_blank" rel="noopener noreferrer">Facebook</a>`);
  if (/^https:\/\//i.test(c.instagram || '')) links.push(`<a class="btn btn-ghost" href="${esc(c.instagram)}" target="_blank" rel="noopener noreferrer">Instagram</a>`);
  if (c.address_line) {
    links.push(`<a class="btn btn-ghost" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(c.address_line)}" target="_blank" rel="noopener noreferrer">Open in Maps</a>`);
  }
  $('#ct-contacts').innerHTML = links.join('') || '<p class="muted">Contact details coming soon.</p>';
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

function renderFreeBanner(freeNow) {
  const slot = $('#free-banner-slot');
  if (!freeNow || cfg.hidden.has('queue')) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="free-banner"><span>${esc(t('queue_free_banner'))}</span>${cfg.hidden.has('book') ? '' : '<a href="#book" class="btn btn-sm btn-dark">Book</a>'}</div>`;
}

function updateNotifyButton(freeNow) {
  $('#notify-free-btn').hidden = freeNow || notifyPermission() !== 'default';
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
}

// ---------------------------------------------------------------- style gallery
let dbStyles = [];
let selectedStyle = '';

async function loadDbStyles() {
  const rows = await rpc('list_haircut_styles');
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

async function submitBooking(e) {
  e.preventDefault();
  const msg = $('#bk-msg');
  showMsg(msg, '');
  if (!cfg) { showMsg(msg, GENERIC_ERROR, 'error'); return; }
  const date = $('#bk-date').value;
  const slot = $('#bk-slot').value;
  const name = $('#bk-name').value.trim();
  const phone = $('#bk-phone').value.trim();
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
      // Older databases don't take p_device yet.
      const token = await rpcOr('book_slot', { ...args, p_device: deviceToken() }, () => rpc('book_slot', args), 'book_slot+device');
      addBookingToken(token);
      showMsg(msg, t('book_done', { time: fmtTime(slot), date: fmtDate(date) }), 'ok');
      const st = appStatus();
      if (android && st && !st.ready) {
        try { android.requestAlerts(); } catch { /* older app */ }
      }
      $('#bk-name').value = '';
      $('#bk-phone').value = '';
      setStyle('');
      invalidateDays();
      await Promise.allSettled([loadQueue(), refreshSlotOptions(), refreshMyBookings()]);
    } catch (err) {
      showError(msg, err);
      invalidateDays();
      refreshSlotOptions();
    }
  });
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

    myRows = sortBookings(keep);
    renderMyBookings();
    setAlarms(keep);
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
    },
    tokens: bookingTokens(),
    bookings: rows.filter((r) => ['booked', 'on_deck', 'called'].includes(r.status)).map((r) => {
      const start = shopTimeToEpoch(r.booking_date, r.slot_time);
      return { token: r.client_token, id: r.id, status: r.status, startMs: start, endMs: start + cfg.slot_minutes * 60000, label: fmtTime(r.slot_time) };
    }),
  };
  try { android.syncBookings(JSON.stringify(payload)); } catch { /* an older app without this call */ }
}

function countdown(b) {
  if (!WAITING.includes(b.status)) return '';
  const ms = startsIn(b);
  if (ms <= 0) return b.status === 'checked_in' ? "You're checked in. You'll be called soon." : 'Your slot has started. Please go to the chair.';
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
      return closed || b.status === 'done' ? '' : `<button type="button" class="link-btn" data-act="pay" data-token="${token}">Pay online instead</button>`;
    case 'requested':
      return `<p class="small muted">Waiting for ${esc(ownerFirst())} to approve online payment.</p>`;
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
      ${paymentHtml(b)}
    </div>`;
}

function renderMyBookings() {
  const body = $('#my-booking-body');
  if (!myRows.length) {
    body.innerHTML = `<p class="muted">${esc(t('my_empty'))}</p>`;
    return;
  }
  const hasActive = myRows.some((r) => WAITING.includes(r.status));
  body.innerHTML = myRows.map(ticketHtml).join('') + (hasActive ? alertSetupHtml() : '');
  loadPaymentDetails();
}

function alertSetupHtml() {
  if (android) {
    const st = appStatus();
    return `
    <div class="alert-setup">
      <p class="small muted">${esc(t('my_alert_note_app'))}</p>
      ${st && st.ready
        ? '<p class="small ok-text">Alerts are on.</p>'
        : `<button type="button" class="btn btn-gold btn-sm" data-act="alerts">Turn on alerts</button><p class="small muted">Needed so the app can ring when it's closed.</p>`}
    </div>`;
  }
  const needsSetup = notifyPermission() === 'default' || !audioUnlocked();
  return `
    <div class="alert-setup">
      <p class="small muted">${esc(t(isIOS ? 'app_ios_note' : 'my_alert_note'))}</p>
      ${needsSetup ? '<button type="button" class="btn btn-ghost btn-sm" data-act="alerts">Turn on alerts</button>' : ''}
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
    case 'checkin':
      await withBusy(btn, () => doCheckIn(token));
      break;
    case 'calendar':
      if (b) addToCalendar(b);
      break;
    case 'receipt':
      if (b) await withBusy(btn, () => printReceipt(b));
      break;
    case 'cancel':
      if (!window.confirm('Cancel this booking?')) return;
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
  $('#booking-form').addEventListener('submit', submitBooking);
  $('#my-booking-body').addEventListener('click', onTicketAction);
  $('#review-form').addEventListener('submit', submitReview);
  $('#chat-form').addEventListener('submit', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#notify-free-btn').addEventListener('click', async () => {
    const perm = await requestNotifyPermission();
    $('#notify-free-btn').hidden = true;
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

async function loadConfig() {
  const rows = await select('site_config', 'id=eq.1&select=*');
  if (!rows || !rows[0]) throw new Error('site settings missing');
  cfg = normalizeConfig(rows[0]);
}

function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    invalidateDays();
    loadQueue().catch(() => {});
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
  renderStyleGallery();
  wire();
  loadDbStyles().then(() => { if (dbStyles.length) renderStyleGallery(); }).catch(() => {});
  setupAppSection().catch(() => {});
  watchAppUpdate(android); // inside the Android app: the update pop-up and bar (lib/appupdate.js)

  for (let attempt = 0; !cfg; attempt++) {
    try {
      await loadConfig();
    } catch (err) {
      if (attempt === 0) showStartupError(err);
      await new Promise((r) => setTimeout(r, Math.min(30000, 5000 * (attempt + 1))));
    }
  }
  showMsg($('#bk-msg'), '');
  renderConfig();
  await Promise.allSettled([
    loadQueue(),
    loadReviews(),
    refreshMyBookings(),
    hasDeviceToken() ? loadChat() : Promise.resolve(),
  ]);
  startPolling();
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
