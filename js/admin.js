import { hasSupabase, rpc, supabase, signInOwner, signOutOwner, currentOwner } from './lib/db.js';
import { fmtTime, todayISO } from './lib/slots.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (!hasSupabase) {
  document.body.innerHTML = '<div class="modal-backdrop"><div class="modal"><h3>Not connected yet</h3><p class="muted small">Open <a href="index.html">the public site</a> first and connect it to your Supabase project — the owner panel shares the same connection.</p></div></div>';
  throw new Error('no supabase');
}

// ---------------------------------------------------------------- login
async function boot() {
  const user = await currentOwner();
  if (user) return showAdmin();
  $('#lg-go').addEventListener('click', doLogin);
  $('#lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}
async function doLogin() {
  const email = $('#lg-email').value.trim();
  const pass = $('#lg-pass').value;
  const msg = $('#lg-msg');
  try {
    await signInOwner(email, pass);
    showAdmin();
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  }
}
function showAdmin() {
  $('#login-screen').style.display = 'none';
  $('#admin-shell').style.display = 'flex';
  wireTabs();
  loadQueueTab();
  loadShopTab();
  $('#logout-link').addEventListener('click', async (e) => { e.preventDefault(); await signOutOwner(); location.reload(); });
}

// ---------------------------------------------------------------- tabs
function wireTabs() {
  document.querySelectorAll('.admin-side a[data-tab]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.admin-side a[data-tab]').forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
      document.querySelectorAll('.admin-main > section').forEach((s) => (s.style.display = 'none'));
      $('#tab-' + a.dataset.tab).style.display = 'block';
      if (a.dataset.tab === 'bookings') loadBookingsTab();
      if (a.dataset.tab === 'feedback') loadFeedbackTab();
      if (a.dataset.tab === 'chat') loadChatTab();
    });
  });
}

// ---------------------------------------------------------------- today's queue
const STATUS_LABEL = { booked: 'Booked', called: 'Called', checked_in: 'Checked in', in_chair: 'In chair', done: 'Done', no_show: 'No-show', cancelled: 'Cancelled' };

async function loadQueueTab() {
  const rows = await rpc('admin_bookings_for_date', { p_date: todayISO() });
  const inChair = rows.filter((r) => r.status === 'in_chair').length;
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const waiting = rows.filter((r) => ['booked', 'called', 'checked_in'].includes(r.status)).length;
  $('#queue-stats').innerHTML = `
    <div class="stat"><div class="n">${doneCount}</div><div class="l">Done today</div></div>
    <div class="stat"><div class="n">${inChair}</div><div class="l">In the chair</div></div>
    <div class="stat"><div class="n">${waiting}</div><div class="l">Waiting</div></div>`;

  $('#queue-table').innerHTML = rows.map((r) => `
    <tr>
      <td>${fmtTime(r.slot_time.slice(0, 5))}</td>
      <td>${esc(r.client_name)}</td>
      <td>${esc(r.client_phone)}</td>
      <td class="small muted">${esc(r.style_choice || '—')}</td>
      <td><span class="status-pill status-${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td>
      <td style="white-space:nowrap">
        ${['booked', 'called', 'checked_in'].includes(r.status) ? `<button class="btn btn-sm btn-gold" data-start="${r.id}">Start cut</button>` : ''}
        ${r.status === 'in_chair' ? `<button class="btn btn-sm btn-gold" data-finish="${r.id}">Done</button>` : ''}
        ${['booked', 'called'].includes(r.status) ? `<button class="btn btn-sm btn-ghost" data-noshow="${r.id}">No-show</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No bookings for today yet.</td></tr>';

  $('#queue-table').querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => act('admin_start_cut', { p_booking_id: b.dataset.start })));
  $('#queue-table').querySelectorAll('[data-finish]').forEach((b) => b.addEventListener('click', () => act('admin_finish_cut', { p_booking_id: b.dataset.finish })));
  $('#queue-table').querySelectorAll('[data-noshow]').forEach((b) => b.addEventListener('click', () => act('admin_mark_no_show', { p_booking_id: b.dataset.noshow })));
}
async function act(fn, args) {
  try { await rpc(fn, args); await loadQueueTab(); } catch (e) { alert(e.message); }
}
$('#wi-add').addEventListener('click', async () => {
  const name = $('#wi-name').value.trim();
  if (!name) return;
  try {
    await rpc('admin_add_walkin', { p_name: name, p_phone: $('#wi-phone').value.trim() });
    $('#wi-name').value = ''; $('#wi-phone').value = '';
    await loadQueueTab();
  } catch (e) { alert(e.message); }
});
setInterval(() => { if ($('#tab-queue').style.display !== 'none') loadQueueTab(); }, 15000);

// ---------------------------------------------------------------- all bookings (any date)
$('#bk-date-filter').value = todayISO();
$('#bk-date-filter').addEventListener('change', loadBookingsTab);
async function loadBookingsTab() {
  const rows = await rpc('admin_bookings_for_date', { p_date: $('#bk-date-filter').value });
  $('#bookings-table').innerHTML = rows.map((r) => `
    <tr><td>${fmtTime(r.slot_time.slice(0, 5))}</td><td>${esc(r.client_name)}</td><td>${esc(r.client_phone)}</td>
    <td><span class="status-pill status-${r.status}">${STATUS_LABEL[r.status] || r.status}</span></td></tr>`
  ).join('') || '<tr><td colspan="4" class="muted">No bookings that day.</td></tr>';
}

// ---------------------------------------------------------------- feedback moderation
async function loadFeedbackTab() {
  const rows = await rpc('admin_list_feedback');
  $('#feedback-list').innerHTML = rows.length ? rows.map((r) => `
    <div class="review">
      <div class="stars-sm">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} <b>${esc(r.client_name || 'Anonymous')}</b>
        <span class="status-pill ${r.is_public ? 'status-in_chair' : 'status-booked'}">${r.is_public ? 'Public' : 'Hidden'}</span></div>
      ${r.comment ? `<p class="small" style="margin:4px 0">${esc(r.comment)}</p>` : ''}
      ${r.reply ? `<div class="reply"><b>Your reply:</b> ${esc(r.reply)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-toggle="${r.id}" data-public="${!r.is_public}">${r.is_public ? 'Hide' : 'Publish'}</button>
        <input placeholder="Write a reply…" data-reply-input="${r.id}" style="flex:1;min-width:140px">
        <button class="btn btn-sm btn-gold" data-reply="${r.id}">Reply</button>
      </div>
    </div>`).join('') : '<p class="muted">No reviews yet.</p>';

  $('#feedback-list').querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    await rpc('admin_set_feedback_public', { p_id: b.dataset.toggle, p_public: b.dataset.public === 'true' });
    loadFeedbackTab();
  }));
  $('#feedback-list').querySelectorAll('[data-reply]').forEach((b) => b.addEventListener('click', async () => {
    const input = document.querySelector(`[data-reply-input="${b.dataset.reply}"]`);
    if (!input.value.trim()) return;
    await rpc('admin_reply_feedback', { p_id: b.dataset.reply, p_reply: input.value.trim() });
    loadFeedbackTab();
  }));
}

// ---------------------------------------------------------------- chat inbox
let activeThread = null;
async function loadChatTab() {
  const threads = await rpc('admin_list_chat_threads');
  $('#thread-list').innerHTML = threads.length ? threads.map((t) => `
    <div class="review" style="cursor:pointer" data-thread="${t.client_token}">
      <div style="display:flex;justify-content:space-between">
        <b>${t.client_token.slice(0, 8)}</b>
        ${t.unread_count > 0 ? `<span class="status-pill status-called">${t.unread_count} new</span>` : ''}
      </div>
      <p class="small muted" style="margin:4px 0 0">${esc(t.last_message).slice(0, 60)}</p>
    </div>`).join('') : '<p class="muted">No messages yet.</p>';
  $('#thread-list').querySelectorAll('[data-thread]').forEach((el) => el.addEventListener('click', () => openThread(el.dataset.thread)));
  if (activeThread) openThread(activeThread);
}
async function openThread(token) {
  activeThread = token;
  const rows = await rpc('get_my_messages', { p_token: token });
  $('#admin-chat-box').innerHTML = rows.map((m) => `<div class="msg ${m.sender === 'owner' ? 'client' : 'owner'}">${esc(m.body)}</div>`).join('');
  $('#admin-chat-box').scrollTop = $('#admin-chat-box').scrollHeight;
}
$('#admin-chat-send').addEventListener('click', async () => {
  const input = $('#admin-chat-input');
  if (!activeThread || !input.value.trim()) return;
  await rpc('admin_reply_message', { p_token: activeThread, p_body: input.value.trim() });
  input.value = '';
  openThread(activeThread);
});
setInterval(() => { if ($('#tab-chat').style.display !== 'none') loadChatTab(); }, 15000);

// ---------------------------------------------------------------- shop details
const SC_FIELDS = ['shop_name', 'tagline', 'owner_name', 'address_line', 'directions_text', 'about_text', 'phone', 'whatsapp', 'facebook', 'instagram', 'price_kwacha', 'rating', 'rating_count', 'open_time', 'close_time'];
async function loadShopTab() {
  const { data } = await supabase.from('site_config').select('*').eq('id', 1).single();
  for (const f of SC_FIELDS) {
    const el = $('#sc-' + f);
    if (el) el.value = f === 'open_time' || f === 'close_time' ? String(data[f]).slice(0, 5) : data[f];
  }
}
$('#sc-save').addEventListener('click', async () => {
  const payload = {};
  for (const f of SC_FIELDS) payload[f] = $('#sc-' + f).value;
  try {
    await rpc('admin_update_site_config', { p: payload });
    $('#sc-msg').innerHTML = '<div class="form-msg ok">Saved.</div>';
  } catch (e) {
    $('#sc-msg').innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  }
});

boot();
