import { hasSupabase, rpc, supabase, signInOwner, signOutOwner, currentOwner } from './lib/db.js';
import { fmtTime, todayISO } from './lib/slots.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (!hasSupabase) {
  document.body.innerHTML = '<div class="modal-backdrop"><div class="modal"><h3>Not connected yet</h3><p class="muted small">Open <a href="index.html">the public site</a> first and connect it to your Supabase project — the owner panel shares the same connection.</p></div></div>';
  throw new Error('no supabase');
}

// ---------------------------------------------------------------- login / one-time owner setup
async function boot() {
  const user = await currentOwner();
  if (user) return afterAuth();

  const noOwnerYet = !(await rpc('owner_account_exists').catch(() => true));
  if (noOwnerYet) {
    $('#lg-setup-link').innerHTML = `First time here? <a href="#" id="lg-to-setup">Set up the owner account</a>.`;
    $('#su-title').textContent = 'Set up the owner account';
    $('#su-intro').textContent = 'This shop has no owner account yet. Whoever sets this up first becomes the owner — do this once, as Alfred.';
    $('#su-go').textContent = 'Create owner account';
  } else {
    $('#lg-setup-link').innerHTML = `New team member? <a href="#" id="lg-to-setup">Create an account</a>.`;
    $('#su-title').textContent = 'Create an account';
    $('#su-intro').textContent = "This won't make you an owner by itself — ask an existing owner to add your email under Owners in the panel once you've signed up.";
    $('#su-go').textContent = 'Create account';
  }
  $('#lg-to-setup').addEventListener('click', (e) => { e.preventDefault(); showSetupMode(); });

  $('#lg-go').addEventListener('click', doLogin);
  $('#lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#su-go').addEventListener('click', doSetup);
  $('#su-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetup(); });
  $('#su-back').addEventListener('click', (e) => { e.preventDefault(); showLoginMode(); });
}

function showSetupMode() { $('#login-mode').style.display = 'none'; $('#setup-mode').style.display = 'block'; }
function showLoginMode() { $('#setup-mode').style.display = 'none'; $('#login-mode').style.display = 'block'; }

async function doLogin() {
  const email = $('#lg-email').value.trim();
  const pass = $('#lg-pass').value;
  const msg = $('#lg-msg');
  try {
    await signInOwner(email, pass);
    await afterAuth();
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  }
}

async function doSetup() {
  const fullName = $('#su-name').value.trim();
  const email = $('#su-email').value.trim();
  const pass = $('#su-pass').value;
  const msg = $('#su-msg');
  if (!fullName || !email || pass.length < 8) {
    msg.innerHTML = '<div class="form-msg error">Name, email and a password of at least 8 characters are all required.</div>';
    return;
  }
  try {
    const { data, error } = await supabase.auth.signUp({ email, password: pass });
    if (error) throw error;
    if (!data.session) {
      // This project has email confirmation switched on: there is no session yet to claim
      // ownership with. Claiming happens automatically the moment they sign in after confirming.
      msg.innerHTML = '<div class="form-msg ok">Account created &mdash; check your email to confirm it, then come back and sign in to finish setup.</div>';
      return;
    }
    await afterAuth();
  } catch (e) {
    msg.innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`;
  }
}

// Runs right after any successful sign-in (fresh signup with an immediate session, or a normal
// login). If nobody has claimed ownership yet, this signed-in account becomes the owner —
// exactly once, ever (see claim_owner_account in supabase/schema.sql). Anyone signing up after
// that just gets a plain account, until an existing owner promotes them from the Owners tab.
async function afterAuth() {
  try {
    const alreadyOwner = await rpc('owner_account_exists');
    if (!alreadyOwner) {
      const fullName = $('#su-name') ? $('#su-name').value.trim() : '';
      await rpc('claim_owner_account', { p_full_name: fullName || 'Owner' });
    }
  } catch { /* someone else already claimed it in the meantime -- fall through to the owner check below */ }

  const isOwner = await rpc('am_i_owner').catch(() => false);
  if (!isOwner) { showPendingScreen(); return; }
  showAdmin();
}

function showPendingScreen() {
  $('#admin-shell').style.display = 'none';
  $('#login-screen').style.display = 'flex';
  $('#login-screen').innerHTML = `
    <div class="modal">
      <h3>Account created</h3>
      <p class="small muted">You're signed in, but you're not an owner yet. Ask Alfred (or another owner) to add your email under Owners in the panel, then come back and sign in again.</p>
      <button class="btn btn-ghost btn-block" style="margin-top:14px" id="pending-signout">Sign out</button>
    </div>`;
  $('#pending-signout').addEventListener('click', async () => { await signOutOwner(); location.reload(); });
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
      if (a.dataset.tab === 'styles') loadStylesTab();
      if (a.dataset.tab === 'requests') loadRequestsTab();
      if (a.dataset.tab === 'payments') loadPaymentsTab();
      if (a.dataset.tab === 'owners') loadOwnersTab();
    });
  });
}

// ---------------------------------------------------------------- today's queue
const STATUS_LABEL = { booked: 'Booked', on_deck: 'On deck', called: 'Called', checked_in: 'Checked in', in_chair: 'In chair', done: 'Done', no_show: 'No-show', cancelled: 'Cancelled' };

async function loadQueueTab() {
  const rows = await rpc('admin_bookings_for_date', { p_date: todayISO() });
  const inChair = rows.filter((r) => r.status === 'in_chair').length;
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const waiting = rows.filter((r) => ['booked', 'on_deck', 'called', 'checked_in'].includes(r.status)).length;
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
        ${['booked', 'on_deck', 'called', 'checked_in'].includes(r.status) ? `<button class="btn btn-sm btn-gold" data-start="${r.id}">Start cut</button>` : ''}
        ${r.status === 'in_chair' ? `<button class="btn btn-sm btn-gold" data-finish="${r.id}">Done</button>` : ''}
        ${['booked', 'on_deck', 'called'].includes(r.status) ? `<button class="btn btn-sm btn-ghost" data-noshow="${r.id}">No-show</button>` : ''}
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

// ---------------------------------------------------------------- haircut styles (owner uploads)
function styleImageUrl(storagePath) {
  return supabase.storage.from('haircut-styles').getPublicUrl(storagePath).data.publicUrl;
}
async function loadStylesTab() {
  const rows = await rpc('admin_list_style_photos');
  const byStyle = new Map();
  for (const r of rows) {
    if (!byStyle.has(r.style_id)) byStyle.set(r.style_id, { label: r.label, photos: [] });
    if (r.photo_id) byStyle.get(r.style_id).photos.push({ id: r.photo_id, path: r.storage_path });
  }
  $('#styles-list').innerHTML = [...byStyle.entries()].map(([id, s]) => `
    <div class="review">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b>${esc(s.label)}</b>
        <button class="btn btn-sm btn-ghost" data-del-style="${id}">Delete style</button>
      </div>
      <div class="photo-grid">
        ${s.photos.map((p) => `
          <div class="photo-thumb">
            <img src="${styleImageUrl(p.path)}" alt="${esc(s.label)}">
            <button class="photo-del" data-del-photo="${p.id}" title="Delete photo">&times;</button>
          </div>`).join('')}
      </div>
      <input type="file" accept="image/*" data-upload-for="${id}">
    </div>`).join('') || '<p class="muted">No extra styles yet &mdash; add one above.</p>';

  $('#styles-list').querySelectorAll('[data-del-style]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this whole style and its photos?')) return;
    try { await rpc('admin_delete_style', { p_style_id: b.dataset.delStyle }); await loadStylesTab(); } catch (e) { alert(e.message); }
  }));
  $('#styles-list').querySelectorAll('[data-del-photo]').forEach((b) => b.addEventListener('click', async () => {
    try { await rpc('admin_delete_style_photo', { p_photo_id: b.dataset.delPhoto }); await loadStylesTab(); } catch (e) { alert(e.message); }
  }));
  $('#styles-list').querySelectorAll('[data-upload-for]').forEach((input) => input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const styleId = input.dataset.uploadFor;
    try {
      const path = `${styleId}/${Date.now()}-${file.name}`.replace(/[^\w.\-/]/g, '_');
      const { error: upErr } = await supabase.storage.from('haircut-styles').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      await rpc('admin_add_style_photo', { p_style_id: styleId, p_storage_path: path });
      await loadStylesTab();
    } catch (e) { alert(e.message); }
  }));
}
$('#st-add').addEventListener('click', async () => {
  const label = $('#st-label').value.trim();
  if (!label) return;
  try {
    await rpc('admin_create_style', { p_label: label });
    $('#st-label').value = '';
    $('#st-msg').innerHTML = '<div class="form-msg ok">Style added — upload photos for it below.</div>';
    await loadStylesTab();
  } catch (e) { $('#st-msg').innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`; }
});

// ---------------------------------------------------------------- style requests (from clients)
async function loadRequestsTab() {
  const rows = await rpc('admin_list_style_requests');
  if (!rows.length) { $('#requests-list').innerHTML = '<p class="muted">No style requests yet.</p>'; return; }
  $('#requests-list').innerHTML = rows.map((r) => `
    <div class="review">
      <div class="small muted">${new Date(r.created_at).toLocaleString()}</div>
      ${r.description ? `<p style="margin:6px 0">${esc(r.description)}</p>` : ''}
      ${r.storage_path ? `<div class="photo-grid" style="max-width:160px"><div class="photo-thumb" data-photo-slot="${esc(r.id)}"><span class="muted small">Loading photo&hellip;</span></div></div>` : ''}
      <button class="btn btn-sm btn-ghost" style="margin-top:8px" data-del-request="${r.id}">Delete</button>
    </div>`).join('');

  for (const r of rows) {
    if (!r.storage_path) continue;
    const slot = document.querySelector(`[data-photo-slot="${r.id}"]`);
    if (!slot) continue;
    const { data, error } = await supabase.storage.from('style-requests').createSignedUrl(r.storage_path, 300);
    if (!error && data) slot.innerHTML = `<img src="${data.signedUrl}" alt="Requested style">`;
    else slot.innerHTML = '<span class="muted small">Photo unavailable</span>';
  }

  $('#requests-list').querySelectorAll('[data-del-request]').forEach((b) => b.addEventListener('click', async () => {
    try { await rpc('admin_delete_style_request', { p_id: b.dataset.delRequest }); await loadRequestsTab(); } catch (e) { alert(e.message); }
  }));
}

// ---------------------------------------------------------------- payments (manual, owner-gated)
const PAY_LABEL = { none: 'No request', requested: 'Wants to pay online', approved: 'Approved — awaiting payment', paid: 'Paid' };
const PAY_PILL = { none: 'status-booked', requested: 'status-called', approved: 'status-checked_in', paid: 'status-done' };
async function loadPaymentsTab() {
  const current = await rpc('admin_get_payment_details').catch(() => '');
  $('#pc-instructions').value = current || '';

  const rows = await rpc('admin_list_pending_payments');
  $('#payments-table').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.booking_date}</td>
      <td>${fmtTime(r.slot_time.slice(0, 5))}</td>
      <td>${esc(r.client_name)}</td>
      <td><span class="status-pill ${PAY_PILL[r.payment_status] || 'status-booked'}">${PAY_LABEL[r.payment_status] || r.payment_status}</span></td>
      <td style="white-space:nowrap">
        ${r.payment_status === 'requested' ? `<button class="btn btn-sm btn-gold" data-approve-pay="${r.id}">Approve</button>` : ''}
        ${r.payment_status === 'approved' ? `<button class="btn btn-sm btn-gold" data-mark-paid="${r.id}">Mark paid</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing needs payment action right now.</td></tr>';

  $('#payments-table').querySelectorAll('[data-approve-pay]').forEach((b) => b.addEventListener('click', async () => {
    try { await rpc('admin_approve_payment', { p_booking_id: b.dataset.approvePay }); await loadPaymentsTab(); } catch (e) { alert(e.message); }
  }));
  $('#payments-table').querySelectorAll('[data-mark-paid]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm("Confirm you've personally received this payment?")) return;
    try { await rpc('admin_mark_paid', { p_booking_id: b.dataset.markPaid }); await loadPaymentsTab(); } catch (e) { alert(e.message); }
  }));
}
$('#pc-save').addEventListener('click', async () => {
  try {
    await rpc('admin_set_payment_details', { p_instructions: $('#pc-instructions').value.trim() });
    $('#pc-msg').innerHTML = '<div class="form-msg ok">Saved.</div>';
  } catch (e) { $('#pc-msg').innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`; }
});

// ---------------------------------------------------------------- owners
async function loadOwnersTab() {
  const rows = await rpc('admin_list_owners');
  $('#owners-table').innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(r.full_name)}</td>
      <td>${esc(r.email)}</td>
      <td class="small muted">${new Date(r.created_at).toLocaleDateString()}</td>
      <td>${rows.length > 1 ? `<button class="btn btn-sm btn-ghost" data-remove-owner="${r.id}">Remove</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No owners yet.</td></tr>';
  $('#owners-table').querySelectorAll('[data-remove-owner]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm("Remove this person's owner access?")) return;
    try { await rpc('admin_remove_owner', { p_id: b.dataset.removeOwner }); await loadOwnersTab(); } catch (e) { alert(e.message); }
  }));
}
$('#ow-add').addEventListener('click', async () => {
  const email = $('#ow-email').value.trim();
  if (!email) return;
  try {
    await rpc('admin_add_owner_by_email', { p_email: email });
    $('#ow-email').value = '';
    $('#ow-msg').innerHTML = '<div class="form-msg ok">Added.</div>';
    await loadOwnersTab();
  } catch (e) { $('#ow-msg').innerHTML = `<div class="form-msg error">${esc(e.message)}</div>`; }
});

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
