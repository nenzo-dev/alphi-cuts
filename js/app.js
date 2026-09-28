import { CONFIG, saveBootstrap } from './config.js';
import { hasSupabase, rpc, supabase } from './lib/db.js';
import { getClientToken, setClientToken } from './lib/client.js';
import { daySlots, fmtTime, todayISO } from './lib/slots.js';
import { startRing, stopRing } from './lib/ringtone.js';
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
async function loadQueue() {
  const rows = await rpc('public_queue_today');
  const slots = daySlots(siteConfig.open_time.slice(0, 5), siteConfig.close_time.slice(0, 5), siteConfig.slot_minutes);
  const byTime = new Map(rows.map((r) => [r.slot_time.slice(0, 5), r.status]));
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let ahead = 0, nextFree = null;
  const grid = slots.map((s) => {
    const [h, m] = s.split(':').map(Number);
    const mins = h * 60 + m;
    const status = byTime.get(s);
    let cls = 'slot';
    if (!status) { cls += ' free'; if (nextFree === null && mins >= nowMin) nextFree = s; }
    else if (['booked', 'called', 'checked_in'].includes(status)) { cls += ' taken'; if (mins >= nowMin) ahead++; }
    else if (status === 'in_chair') cls += ' now';
    if (mins + siteConfig.slot_minutes <= nowMin) cls += ' past';
    return `<div class="${cls}" title="${status || 'free'}">${fmtTime(s)}</div>`;
  }).join('');
  $('#slot-grid').innerHTML = grid;

  $('#queue-summary').innerHTML = nextFree
    ? `<span class="big">${ahead}</span> <span class="muted">booked slot${ahead === 1 ? '' : 's'} ahead right now &middot; next free slot: <b style="color:var(--gold-soft)">${fmtTime(nextFree)}</b></span>`
    : `<span class="muted">No free slots left today &mdash; try booking for tomorrow.</span>`;
}

// ---------------------------------------------------------------- style gallery
let selectedStyle = '';

function renderStyleGallery() {
  $('#style-gallery').innerHTML = HAIRCUT_STYLES.map((s) => `
    <div class="slot free" style="cursor:pointer;padding:0;overflow:hidden;aspect-ratio:1/1;position:relative" data-style="${esc(s.slug)}">
      <img src="${styleCover(s)}" alt="${esc(s.label)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">
      <span style="position:absolute;left:0;right:0;bottom:0;background:rgba(23,21,18,.85);color:var(--gold-soft);padding:5px 6px;font-size:11px;font-weight:800">${esc(s.label)}</span>
    </div>`).join('');
  $('#style-gallery').querySelectorAll('[data-style]').forEach((el) => {
    el.addEventListener('click', () => openStyleLightbox(el.dataset.style));
  });
}

function openStyleLightbox(slug) {
  const style = HAIRCUT_STYLES.find((s) => s.slug === slug);
  if (!style) return;
  const photos = stylePhotos(style);
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop" id="style-modal-backdrop">
      <div class="modal" style="max-width:600px">
        <button class="modal-close" id="style-modal-close">&times;</button>
        <h3>${esc(style.label)}</h3>
        <div class="slot-grid" style="grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))">
          ${photos.map((p) => `<img src="${p}" alt="${esc(style.label)}" style="width:100%;border-radius:8px;aspect-ratio:1/1;object-fit:cover">`).join('')}
        </div>
        <button class="btn btn-gold btn-block" style="margin-top:16px" id="style-pick-btn">Book this style</button>
      </div>
    </div>`;
  const close = () => { $('#modal-root').innerHTML = ''; };
  $('#style-modal-close').addEventListener('click', close);
  $('#style-modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'style-modal-backdrop') close(); });
  $('#style-pick-btn').addEventListener('click', () => {
    selectedStyle = style.label;
    const chip = $('#bk-style-chip');
    chip.style.display = 'block';
    chip.innerHTML = `Style: <b>${esc(style.label)}</b> &middot; <a href="#" id="bk-style-clear">change</a>`;
    $('#bk-style-clear').addEventListener('click', (e) => { e.preventDefault(); selectedStyle = ''; chip.style.display = 'none'; });
    close();
    document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------------------------------------------------------------- booking form
function buildDateOptions() {
  const sel = $('#bk-date');
  sel.innerHTML = '';
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
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
  const now = new Date();
  const isToday = date === todayISO();
  const nowMin = now.getHours() * 60 + now.getMinutes();
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
let myBookingTimer = null;
async function renderMyBooking() {
  const token = getClientToken();
  const el = $('#my-booking-body');
  if (!token) { el.innerHTML = `You don't have an active booking on this device yet.`; stopRing(); return; }
  let b;
  try { b = await rpc('get_my_booking', { p_token: token }); } catch { b = null; }
  if (!b) { el.innerHTML = `You don't have an active booking on this device yet.`; stopRing(); return; }

  const label = { booked: 'Booked', called: "You're up next!", checked_in: 'Checked in', in_chair: 'In the chair', done: 'Done — thank you!', no_show: 'Missed (no-show)', cancelled: 'Cancelled' }[b.status] || b.status;
  el.innerHTML = `
    <div class="ticket">
      <div>
        <div style="font-size:18px;font-weight:800">${fmtTime(b.slot_time.slice(0, 5))} &middot; ${b.booking_date}</div>
        <div class="muted small">${esc(b.client_name)}${b.style_choice ? ` &middot; ${esc(b.style_choice)}` : ''}</div>
      </div>
      <span class="status-pill status-${b.status}">${label}</span>
    </div>
    <div class="row" style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      ${b.status === 'called' ? `<button class="btn btn-gold btn-sm" id="mb-checkin">I'm here</button>` : ''}
      ${['booked', 'called'].includes(b.status) ? `<button class="btn btn-ghost btn-sm" id="mb-cancel">Cancel booking</button>` : ''}
    </div>`;

  if (b.status === 'called') startRing(); else stopRing();

  const ci = $('#mb-checkin');
  if (ci) ci.addEventListener('click', async () => { try { await rpc('check_in', { p_token: token }); await renderMyBooking(); } catch (e) { alert(e.message); } });
  const cx = $('#mb-cancel');
  if (cx) cx.addEventListener('click', async () => {
    if (!confirm('Cancel this booking?')) return;
    try { await rpc('cancel_my_booking', { p_token: token }); await renderMyBooking(); await loadQueue(); await refreshSlotOptions(); } catch (e) { alert(e.message); }
  });

  clearTimeout(myBookingTimer);
  myBookingTimer = setTimeout(renderMyBooking, 15000); // poll for status changes while this booking is active
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

// ---------------------------------------------------------------- wire up + boot
$('#bk-submit').addEventListener('click', submitBooking);
$('#rv-submit').addEventListener('click', submitReview);
$('#chat-send').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

(async function boot() {
  renderStyleGallery();
  await loadSiteConfig();
  await Promise.all([loadQueue(), loadReviews(), loadChat(), renderMyBooking()]);
  setInterval(loadQueue, 20000);
  setInterval(loadChat, 15000);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
