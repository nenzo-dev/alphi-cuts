import { CONFIG, saveBootstrap } from './config.js';
import { hasSupabase, rpc, supabase } from './lib/db.js';
import { getClientToken, setClientToken } from './lib/client.js';
import { daySlots, fmtTime, todayISO, nowMinutesInShopTz, shopDateOptions } from './lib/slots.js';
import { startRing, stopRing } from './lib/ringtone.js';
import { notifyPermission, requestNotifyPermission, notify } from './lib/notify.js';
import { HAIRCUT_STYLES, styleCover, stylePhotos } from './styles-data.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- first-run setup screen
// Mirrors MindCare's bootstrap: if config.js has no Supabase URL/key yet (and none is saved in this
// browser), show a one-time form instead of a broken page, so the site is testable immediately.
if (!hasSupabase) {
  document.body.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h3>Connect AlPhi Cuts to its database</h3>
        <p class="muted small">Paste your Supabase Project URL and "anon public" key (Project Settings &rarr; API). This is saved in this browser only &mdash; for a permanent setup, paste the same values into js/config.js.</p>
        <label>Project URL</label>
        <input id="setup-url" placeholder="https://xxxx.supabase.co">
        <label>Anon public key</label>
        <input id="setup-key" placeholder="eyJ...">
        <button class="btn btn-gold btn-block" style="margin-top:14px" id="setup-go">Connect</button>
        <div id="setup-msg"></div>
      </div>
    </div>`;
  $('#setup-go').addEventListener('click', () => {
    const url = $('#setup-url').value.trim();
    const key = $('#setup-key').value.trim();
    if (!/^https:\/\/[\w.-]+\.supabase\.co$/.test(url) || key.length < 20) {
      $('#setup-msg').innerHTML = '<div class="form-msg error">That doesn\'t look like a valid URL and key yet.</div>';
      return;
    }
    saveBootstrap(url, key);
    location.reload();
  });
  throw new Error('Waiting for Supabase setup.'); // stop the rest of this module from running
}

// ---------------------------------------------------------------- site config (contact info, price, hours)
let siteConfig = null;
async function loadSiteConfig() {
  const { data, error } = await supabase.from('site_config').select('*').eq('id', 1).single();
  if (error) throw error;
  siteConfig = data;
  renderSiteConfig();
}
function renderSiteConfig() {
  const c = siteConfig;
  document.title = `${c.shop_name} — ${c.owner_name}'s Barbershop`;
  for (const id of ['hdr-shop-name', 'hero-shop-name', 'ft-shop-name']) $('#' + id).textContent = c.shop_name;
  $('#ft-owner-name').textContent = c.owner_name;
  $('#hero-tagline').textContent = c.tagline;
  $('#hero-price').textContent = `Any haircut, with or without dye — K${Number(c.price_kwacha).toFixed(0)}`;
  const stars = Math.round(c.rating);
  $('#hero-stars').textContent = '★'.repeat(stars) + '☆'.repeat(5 - stars);
  $('#hero-rating-text').textContent = `${Number(c.rating).toFixed(1)} · ${c.rating_count} review${c.rating_count === 1 ? '' : 's'} · best-rated in Chongwe`;
  $('#ct-address').textContent = c.address_line;
  $('#ct-directions').textContent = c.directions_text;
  const contactRows = [];
  if (c.phone) contactRows.push(`<a href="tel:${esc(c.phone)}">\u{1F4DE} ${esc(c.phone)}</a>`);
  if (c.whatsapp) contactRows.push(`<a href="https://wa.me/${esc(c.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener">\u{1F4F1} WhatsApp</a>`);
  if (c.facebook) contactRows.push(`<a href="${esc(c.facebook)}" target="_blank" rel="noopener">\u{1F4D6} Facebook</a>`);
  if (c.instagram) contactRows.push(`<a href="${esc(c.instagram)}" target="_blank" rel="noopener">\u{1F4F7} Instagram</a>`);
  $('#ct-contacts').innerHTML = contactRows.join('') || '<span class="muted">Contact details coming soon.</span>';

  buildDateOptions();
  buildQrCode();
}

// ---------------------------------------------------------------- live queue (today)
function isShopOpenNow() {
  const nowMin = nowMinutesInShopTz();
  const [oh, om] = siteConfig.open_time.slice(0, 5).split(':').map(Number);
  const [ch, cm] = siteConfig.close_time.slice(0, 5).split(':').map(Number);
  return nowMin >= oh * 60 + om && nowMin < ch * 60 + cm;
}

let wasBusy = null; // null = not checked yet this session, so the first poll never fires a notification
function renderFreeBanner(isFreeNow) {
  $('#free-banner-slot').innerHTML = isFreeNow
    ? `<div class="free-banner">&#9986;&#65039; Alfred is free right now &mdash; walk in or <a href="#book" style="color:#171512;text-decoration:underline">book instantly</a>!</div>`
    : '';
}

async function loadQueue() {
  const rows = await rpc('public_queue_today');
  const slots = daySlots(siteConfig.open_time.slice(0, 5), siteConfig.close_time.slice(0, 5), siteConfig.slot_minutes);
  const byTime = new Map(rows.map((r) => [r.slot_time.slice(0, 5), r.status]));
  const nowMin = nowMinutesInShopTz();

  let ahead = 0, nextFree = null;
  const grid = slots.map((s) => {
    const [h, m] = s.split(':').map(Number);
    const mins = h * 60 + m;
    const status = byTime.get(s);
    let cls = 'slot';
    if (!status) { cls += ' free'; if (nextFree === null && mins >= nowMin) nextFree = s; }
    else if (['booked', 'on_deck', 'called', 'checked_in'].includes(status)) { cls += ' taken'; if (mins >= nowMin) ahead++; }
    else if (status === 'in_chair') cls += ' now';
    if (mins + siteConfig.slot_minutes <= nowMin) cls += ' past';
    return `<div class="${cls}" title="${status || 'free'}">${fmtTime(s)}</div>`;
  }).join('');
  $('#slot-grid').innerHTML = grid;

  $('#queue-summary').innerHTML = nextFree
    ? `<span class="big">${ahead}</span> <span class="muted">booked slot${ahead === 1 ? '' : 's'} ahead right now &middot; next free slot: <b style="color:var(--gold-soft)">${fmtTime(nextFree)}</b></span>`
    : `<span class="muted">No free slots left today &mdash; try booking for tomorrow.</span>`;

  const openNow = isShopOpenNow();
  const inChairNow = rows.some((r) => r.status === 'in_chair');
  const isFreeNow = openNow && !inChairNow;
  renderFreeBanner(isFreeNow);
  if (wasBusy === true && isFreeNow) {
    notify('AlPhi Cuts is free right now!', 'No one in the chair — walk in or book instantly.');
  }
  wasBusy = inChairNow;

  const nb = $('#notify-free-btn');
  nb.style.display = notifyPermission() === 'default' ? 'block' : 'none';
}
$('#notify-free-btn').addEventListener('click', async () => { await requestNotifyPermission(); $('#notify-free-btn').style.display = 'none'; });

// ---------------------------------------------------------------- style gallery
// Two sources merged into one gallery: the 36 built-in photos (static, from styles-data.js) and
// whatever Alfred has uploaded since (from the "haircut-styles" Supabase Storage bucket, via
// list_haircut_styles()). Both render and open the same way, keyed by a "db:<id>" or "static:<slug>"
// id so the lightbox knows which source to look the style back up in.
let dbStyles = []; // [{ id, label, photos: [publicUrl, ...] }]
let selectedStyle = '';

function dbStyleImageUrl(storagePath) {
  return supabase.storage.from('haircut-styles').getPublicUrl(storagePath).data.publicUrl;
}

async function loadDbStyles() {
  try {
    const rows = await rpc('list_haircut_styles');
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.style_id)) byId.set(r.style_id, { id: r.style_id, label: r.label, photos: [] });
      if (r.storage_path) byId.get(r.style_id).photos.push(dbStyleImageUrl(r.storage_path));
    }
    dbStyles = [...byId.values()].filter((s) => s.photos.length > 0);
  } catch { dbStyles = []; }
}

function renderStyleGallery() {
  const staticCards = HAIRCUT_STYLES.map((s) => ({ key: `static:${s.slug}`, label: s.label, cover: styleCover(s) }));
  const dbCards = dbStyles.map((s) => ({ key: `db:${s.id}`, label: s.label, cover: s.photos[0] }));
  $('#style-gallery').innerHTML = [...staticCards, ...dbCards].map((s) => `
    <div class="slot free" style="cursor:pointer;padding:0;overflow:hidden;aspect-ratio:1/1;position:relative" data-style="${esc(s.key)}">
      <img src="${s.cover}" alt="${esc(s.label)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
      <span style="position:absolute;left:0;right:0;bottom:0;background:rgba(23,21,18,.85);color:var(--gold-soft);padding:5px 6px;font-size:11px;font-weight:800">${esc(s.label)}</span>
    </div>`).join('');
  $('#style-gallery').querySelectorAll('[data-style]').forEach((el) => {
    el.addEventListener('click', () => openStyleLightbox(el.dataset.style));
  });
}

function openStyleLightbox(key) {
  let label, photos;
  if (key.startsWith('static:')) {
    const style = HAIRCUT_STYLES.find((s) => s.slug === key.slice(7));
    if (!style) return;
    label = style.label; photos = stylePhotos(style);
  } else {
    const style = dbStyles.find((s) => s.id === key.slice(3));
    if (!style) return;
    label = style.label; photos = style.photos;
  }
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop" id="style-modal-backdrop">
      <div class="modal" style="max-width:600px">
        <button class="modal-close" id="style-modal-close">&times;</button>
        <h3>${esc(label)}</h3>
        <div class="slot-grid" style="grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))">
          ${photos.map((p) => `<img src="${p}" alt="${esc(label)}" style="width:100%;border-radius:8px;aspect-ratio:1/1;object-fit:cover">`).join('')}
        </div>
        <button class="btn btn-gold btn-block" style="margin-top:16px" id="style-pick-btn">Book this style</button>
      </div>
    </div>`;
  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#style-modal-close').addEventListener('click', close);
  $('#style-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'style-modal-backdrop') close(); });
  $('#style-pick-btn').addEventListener('click', () => {
    selectedStyle = label;
    const chip = $('#bk-style-chip');
    chip.style.display = 'block';
    chip.innerHTML = `Style: <b>${esc(label)}</b> &middot; <a href="#" id="bk-style-clear">change</a>`;
    $('#bk-style-clear').addEventListener('click', (e) => { e.preventDefault(); selectedStyle = ''; chip.style.display = 'none'; });
    close();
    document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------------------------------------------------------------- "can't find your style"
async function submitStyleRequest() {
  const desc = $('#sr-desc').value.trim();
  const file = $('#sr-photo').files[0];
  const msg = $('#sr-msg');
  msg.innerHTML = '';
  if (!desc && !file) { msg.innerHTML = '<div class="form-msg error">Describe the style, or upload a photo of it (or both).</div>'; return; }
  const btn = $('#sr-submit');
  btn.disabled = true;
  try {
    let token = getClientToken();
    if (!token) { token = crypto.randomUUID().replace(/-/g, ''); setClientToken(token); }
    let storagePath = null;
    if (file) {
      const path = `${token}/${Date.now()}-${file.name}`.replace(/[^\w.\-/]/g, '_');
      const { error: upErr } = await supabase.storage.from('style-requests').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      storagePath = path;
    }
    await rpc('submit_style_request', { p_token: token, p_description: desc, p_storage_path: storagePath });
    msg.innerHTML = '<div class="form-msg ok">Thanks! Alfred will take a look — you can also mention it in Chat.</div>';
    $('#sr-desc').value = ''; $('#sr-photo').value = '';
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- booking form
function buildDateOptions() {
  const sel = $('#bk-date');
  sel.innerHTML = '';
  for (const { iso, isToday, isTomorrow, date } of shopDateOptions(7)) {
    const label = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    sel.insertAdjacentHTML('beforeend', `<option value="${iso}">${label}</option>`);
  }
  sel.addEventListener('change', refreshSlotOptions);
  refreshSlotOptions();
}
async function refreshSlotOptions() {
  const date = $('#bk-date').value || todayISO();
  const slots = daySlots(siteConfig.open_time.slice(0, 5), siteConfig.close_time.slice(0, 5), siteConfig.slot_minutes);
  let taken = new Set();
  try {
    const rows = date === todayISO() ? await rpc('public_queue_today') : [];
    taken = new Set(rows.filter((r) => r.status !== 'cancelled').map((r) => r.slot_time.slice(0, 5)));
  } catch { /* if this fails we just show every slot as selectable */ }
  const isToday = date === todayISO();
  const nowMin = nowMinutesInShopTz();
  const free = slots.filter((s) => {
    if (taken.has(s)) return false;
    if (!isToday) return true;
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m > nowMin;
  });
  const sel = $('#bk-slot');
  sel.innerHTML = free.length
    ? free.map((s) => `<option value="${s}">${fmtTime(s)}</option>`).join('')
    : '<option value="">No free slots this day</option>';
}

async function submitBooking() {
  const date = $('#bk-date').value;
  const slot = $('#bk-slot').value;
  const name = $('#bk-name').value.trim();
  const phone = $('#bk-phone').value.trim();
  const msg = $('#bk-msg');
  msg.innerHTML = '';
  if (!slot) { msg.innerHTML = '<div class="form-msg error">Please pick a time.</div>'; return; }
  if (!name || !phone) { msg.innerHTML = '<div class="form-msg error">Please enter your name and phone number.</div>'; return; }
  const btn = $('#bk-submit');
  btn.disabled = true;
  try {
    const token = await rpc('book_slot', { p_date: date, p_slot: slot, p_name: name, p_phone: phone, p_style: selectedStyle || null });
    setClientToken(token);
    msg.innerHTML = `<div class="form-msg ok">Booked! Your slot is ${fmtTime(slot)}. Please arrive on time — if you're not there when it's your turn, the slot may be given to someone else.</div>`;
    $('#bk-name').value = ''; $('#bk-phone').value = '';
    selectedStyle = ''; $('#bk-style-chip').style.display = 'none';
    await loadQueue();
    await refreshSlotOptions();
    await renderMyBooking();
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- my booking (this device's ticket)
// Ringing/notifying starts at "on_deck" (two people away) so there's time to head over, and keeps
// going through "called" (next up) until the client checks in or their cut starts.
let myBookingTimer = null;
let lastNotifiedStatus = null;
const STATUS_LABEL_MB = {
  booked: 'Booked',
  on_deck: "Almost up — 2 away, stick around!",
  called: "You're up next!",
  checked_in: 'Checked in',
  in_chair: 'In the chair',
  done: 'Done — thank you!',
  no_show: 'Missed (no-show)',
  cancelled: 'Cancelled',
};
async function renderMyBooking() {
  const token = getClientToken();
  const el = $('#my-booking-body');
  if (!token) { el.innerHTML = `You don't have an active booking on this device yet.`; stopRing(); lastNotifiedStatus = null; return; }
  let b;
  try { b = (await rpc('get_my_booking', { p_token: token }))[0]; } catch { b = null; }
  if (!b) { el.innerHTML = `You don't have an active booking on this device yet.`; stopRing(); lastNotifiedStatus = null; return; }

  const ringingStatuses = ['on_deck', 'called'];
  const label = STATUS_LABEL_MB[b.status] || b.status;
  const notifyBtn = notifyPermission() === 'default'
    ? `<button class="btn btn-ghost btn-sm" id="mb-notify">&#128276; Enable alerts</button>` : '';
  el.innerHTML = `
    <div class="ticket">
      <div>
        <div style="font-size:18px;font-weight:800">${fmtTime(b.slot_time.slice(0, 5))} &middot; ${b.booking_date}</div>
        <div class="muted small">${esc(b.client_name)}${b.style_choice ? ` &middot; ${esc(b.style_choice)}` : ''}</div>
      </div>
      <span class="status-pill status-${b.status}">${label}</span>
    </div>
    <div class="row" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      ${['on_deck', 'called'].includes(b.status) ? `<button class="btn btn-gold btn-sm" id="mb-checkin">I'm here</button>` : ''}
      ${['booked', 'on_deck', 'called'].includes(b.status) ? `<button class="btn btn-ghost btn-sm" id="mb-cancel">Cancel booking</button>` : ''}
      ${notifyBtn}
    </div>
    <div id="mb-payment"></div>`;

  if (ringingStatuses.includes(b.status)) startRing(); else stopRing();

  if (ringingStatuses.includes(b.status) && b.status !== lastNotifiedStatus) {
    notify(
      b.status === 'on_deck' ? "You're 2 away at AlPhi Cuts" : "You're up next at AlPhi Cuts!",
      b.status === 'on_deck' ? 'Two more people and it\'s your turn — head over now if you\'re not already there.' : 'Please be at the shop now, or your slot may go to someone else.'
    );
  }
  lastNotifiedStatus = ringingStatuses.includes(b.status) ? b.status : null;

  const ci = $('#mb-checkin');
  if (ci) ci.addEventListener('click', async () => { try { await rpc('check_in', { p_token: token }); await renderMyBooking(); } catch (e) { alert(e.message); } });
  const cx = $('#mb-cancel');
  if (cx) cx.addEventListener('click', async () => {
    if (!confirm('Cancel this booking?')) return;
    try { await rpc('cancel_my_booking', { p_token: token }); await renderMyBooking(); await loadQueue(); await refreshSlotOptions(); } catch (e) { alert(e.message); }
  });
  const nb = $('#mb-notify');
  if (nb) nb.addEventListener('click', async () => { await requestNotifyPermission(); await renderMyBooking(); });

  await renderPaymentSection(token);

  clearTimeout(myBookingTimer);
  myBookingTimer = setTimeout(renderMyBooking, 15000); // poll for status changes while this booking is active
}

// ---------------------------------------------------------------- online payment (manual, owner-gated)
// No payment gateway: Alfred's own mobile money / bank details, only ever shown for a booking he has
// personally approved, and only marked paid once he says so after receiving the money himself.
async function renderPaymentSection(token) {
  const box = $('#mb-payment');
  if (!box) return;
  let p;
  try { p = await rpc('get_payment_details', { p_token: token }); p = Array.isArray(p) ? p[0] : p; } catch { box.innerHTML = ''; return; }
  if (!p) { box.innerHTML = ''; return; }

  if (p.payment_status === 'none') {
    box.innerHTML = `<div class="payment-box"><button class="btn btn-ghost btn-sm" id="mb-pay-request">Ask to pay online</button></div>`;
    $('#mb-pay-request').addEventListener('click', async () => {
      try { await rpc('request_online_payment', { p_token: token }); await renderMyBooking(); } catch (e) { alert(e.message); }
    });
  } else if (p.payment_status === 'requested') {
    box.innerHTML = `<div class="payment-box muted small">Waiting for Alfred to approve online payment for this booking&hellip;</div>`;
  } else if (p.payment_status === 'approved') {
    box.innerHTML = `
      <div class="payment-box">
        <div class="payment-disclaimer">&#9888;&#65039; Always confirm with Alfred before paying online. Only send money using the details below for <b>this booking</b>, after he has approved it here &mdash; AlPhi Cuts is not responsible for payments made outside this confirmation.</div>
        <div><b>Amount due:</b> K${Number(p.amount_kwacha).toFixed(0)}</div>
        <pre>${esc(p.instructions)}</pre>
        <p class="small muted" style="margin:0">Once you've paid, let Alfred know (in person or via Chat) &mdash; he'll mark this as paid and your receipt will appear here.</p>
      </div>`;
  } else if (p.payment_status === 'paid') {
    box.innerHTML = `
      <div class="payment-box">
        <div class="form-msg ok">&#9989; Payment received &mdash; thank you!</div>
        <button class="btn btn-gold btn-sm" style="margin-top:10px" id="mb-receipt">Download receipt</button>
      </div>`;
    $('#mb-receipt').addEventListener('click', () => printReceipt(token));
  }
}

async function printReceipt(token) {
  let b, p;
  try {
    b = (await rpc('get_my_booking', { p_token: token }))[0];
    p = await rpc('get_payment_details', { p_token: token });
    p = Array.isArray(p) ? p[0] : p;
  } catch (e) { alert(e.message); return; }
  if (!b || !p || p.payment_status !== 'paid') { alert('Receipt not available yet.'); return; }
  const paidDate = b.paid_at ? new Date(b.paid_at) : new Date();
  $('#receipt-print').innerHTML = `
    <div class="receipt-doc">
      <img src="icons/logo.webp" class="r-logo" alt="">
      <h2>${esc(p.shop_name)}</h2>
      <div class="r-sub">Payment receipt</div>
      <div class="r-stamp">PAID</div>
      <table>
        <tr><td>Client</td><td>${esc(b.client_name)}</td></tr>
        <tr><td>Date</td><td>${b.booking_date}</td></tr>
        <tr><td>Time</td><td>${fmtTime(b.slot_time.slice(0, 5))}</td></tr>
        ${b.style_choice ? `<tr><td>Style</td><td>${esc(b.style_choice)}</td></tr>` : ''}
        <tr><td>Paid on</td><td>${paidDate.toLocaleString()}</td></tr>
        <tr class="r-total"><td>Total paid</td><td>K${Number(p.amount_kwacha).toFixed(0)}</td></tr>
      </table>
      <div class="r-foot">Booking ref: ${esc(token.slice(0, 10))}&hellip;<br>Thank you for choosing ${esc(p.shop_name)}.</div>
    </div>`;
  document.body.classList.add('printing-receipt');
  const cleanup = () => { document.body.classList.remove('printing-receipt'); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

// ---------------------------------------------------------------- reviews
async function loadReviews() {
  const { data, error } = await supabase
    .from('feedback').select('*').eq('is_public', true).order('created_at', { ascending: false }).limit(20);
  const list = $('#review-list');
  if (error || !data || !data.length) { list.innerHTML = '<p class="muted">No reviews yet — be the first!</p>'; return; }
  list.innerHTML = data.map((r) => `
    <div class="review">
      <div class="stars-sm">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} <b>${esc(r.client_name || 'Anonymous')}</b></div>
      ${r.comment ? `<p class="small" style="margin:4px 0 0">${esc(r.comment)}</p>` : ''}
      ${r.reply ? `<div class="reply"><b>Alfred:</b> ${esc(r.reply)}</div>` : ''}
    </div>`).join('');
}
async function submitReview() {
  const name = $('#rv-name').value.trim();
  const rating = Number($('#rv-rating').value);
  const comment = $('#rv-comment').value.trim();
  const msg = $('#rv-msg');
  try {
    await rpc('submit_feedback', { p_name: name, p_rating: rating, p_comment: comment });
    msg.innerHTML = '<div class="form-msg ok">Thanks! Your review will appear once approved.</div>';
    $('#rv-name').value = ''; $('#rv-comment').value = '';
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- chat
async function loadChat() {
  const token = getClientToken();
  const box = $('#chat-box');
  if (!token) { box.innerHTML = '<p class="muted small">Book a slot or send a message to start a chat.</p>'; return; }
  let rows = [];
  try { rows = await rpc('get_my_messages', { p_token: token }); } catch { /* no thread yet */ }
  box.innerHTML = rows.length
    ? rows.map((m) => `<div class="msg ${m.sender}">${esc(m.body)}</div>`).join('')
    : '<p class="muted small">No messages yet.</p>';
  box.scrollTop = box.scrollHeight;
  try { await rpc('mark_messages_read_by_client', { p_token: token }); } catch { /* not critical */ }
}
async function sendChat() {
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body) return;
  let token = getClientToken();
  if (!token) {
    // No booking yet: a chat-only visitor still needs a token to have a thread at all.
    token = crypto.randomUUID().replace(/-/g, '');
    setClientToken(token);
  }
  try {
    await rpc('send_message', { p_token: token, p_body: body });
    input.value = '';
    await loadChat();
  } catch (e) { alert(e.message); }
}

// ---------------------------------------------------------------- QR code / get the app
function buildQrCode() {
  const url = encodeURIComponent(CONFIG.siteUrl + '#get-app');
  $('#qr-image').src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=8&data=${url}`;
}
$('#get-app-btn').addEventListener('click', async () => {
  if (window.deferredInstallPrompt) {
    window.deferredInstallPrompt.prompt();
    await window.deferredInstallPrompt.userChoice;
    window.deferredInstallPrompt = null;
  } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    alert('On iPhone/iPad: tap the Share button, then "Add to Home Screen".');
  } else {
    alert('Open this page in Chrome and use the browser menu → "Install app".');
  }
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.deferredInstallPrompt = e; });
$('#qr-print-btn').addEventListener('click', () => window.print());

// ---------------------------------------------------------------- mobile nav
const navLinks = $('#nav-links');
const navToggle = $('#nav-toggle');
function closeNav() { navLinks.classList.remove('open'); navToggle.setAttribute('aria-expanded', 'false'); }
navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
});
navLinks.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeNav));
document.addEventListener('click', (e) => {
  if (navLinks.classList.contains('open') && !navLinks.contains(e.target) && !navToggle.contains(e.target)) closeNav();
});

// ---------------------------------------------------------------- wire up + boot
$('#bk-submit').addEventListener('click', submitBooking);
$('#rv-submit').addEventListener('click', submitReview);
$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
$('#sr-submit').addEventListener('click', submitStyleRequest);

(async function boot() {
  await loadDbStyles();
  renderStyleGallery();
  await loadSiteConfig();
  await Promise.all([loadQueue(), loadReviews(), loadChat(), renderMyBooking()]);
  setInterval(loadQueue, 20000);
  setInterval(loadChat, 15000);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
