import { CONFIG, VERSION } from './config.js';
import {
  rpc, select, setAccessTokenGetter, uploadFile, removeFiles, publicFileUrl, signedFileUrl, isMissingFunction,
} from './lib/api.js';
import {
  $, $$, esc, showMsg, showError, toast, toastError, withBusy, friendlyError, installGlobalErrorHandlers,
  storageGet, storageSet,
} from './lib/ui.js';
import { fmtTime, todayISO, addDaysISO, daySlots, dayName, toMin } from './lib/slots.js';
import { TEXT_GROUPS, DEFAULT_TEXT, TEXT_LABELS, OPTIONAL_TEXT, SECTIONS, PLACEHOLDERS } from './lib/content.js';
import { LEGAL_DOCS } from './legal-content.js';
import { prepareImage } from './lib/image.js';
import { armAudioUnlock, chime, loadCustomSound } from './lib/ringtone.js';
import { openSounds } from './lib/soundui.js';
import { ownerPushState, ownerTurnOn, ownerTurnOff, sendTestPush } from './lib/push.js';

installGlobalErrorHandlers();
armAudioUnlock();
loadCustomSound(); // the owner's own sound for new bookings, if they saved one

// ---------------------------------------------------------------- auth
// Supabase Auth checks the password (it stores only a hash). This page never keeps the password;
// it keeps the session token, in this tab only unless "Keep me signed in" was ticked.
const KEEP_KEY = 'ac_admin_keep';
const keepSignedIn = () => storageGet(KEEP_KEY) === '1';
const authStorage = {
  getItem(key) {
    try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch { return null; }
  },
  setItem(key, value) {
    try {
      const [keep, drop] = keepSignedIn() ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
      keep.setItem(key, value);
      drop.removeItem(key);
    } catch { /* storage unavailable */ }
  },
  removeItem(key) {
    try { sessionStorage.removeItem(key); localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

const sb = window.supabase && window.supabase.createClient
  ? window.supabase.createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey, {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  : null;

setAccessTokenGetter(async () => {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data && data.session ? data.session.access_token : null;
});

function authMessage(error) {
  const code = String((error && error.code) || '');
  const text = String((error && error.message) || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(text)) return 'Wrong email or password.';
  if (code === 'email_not_confirmed') return 'Please confirm your email address first. Check your inbox for the link.';
  if (code === 'user_already_exists' || code === 'email_exists') return 'An account with this email already exists. Sign in instead.';
  if (code === 'weak_password') return 'Please choose a stronger password.';
  if (code === 'email_address_invalid' || code === 'validation_failed') return 'Please enter a valid email address.';
  if (code === 'signup_disabled') return 'New accounts are switched off for this shop.';
  if ((error && error.status === 429) || /rate.?limit/i.test(code)) return 'Too many attempts. Please wait a minute and try again.';
  return friendlyError(error);
}

function showLogin(message) {
  $('#admin-shell').hidden = true;
  $('#login-screen').hidden = false;
  $('#setup-mode').hidden = true;
  $('#login-mode').hidden = false;
  if (message) showMsg($('#lg-msg'), message, 'error');
}

async function boot() {
  $('#admin-version').textContent = `Version ${VERSION}`;
  if (!sb) {
    showMsg($('#lg-msg'), friendlyError(null), 'error');
    $('#lg-go').disabled = true;
    return;
  }
  wireLogin();
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    await afterAuth();
    return;
  }
  await prepareSetupLink();
}

async function prepareSetupLink() {
  let ownerExists = true;
  try { ownerExists = await rpc('owner_account_exists'); } catch { ownerExists = true; }
  if (!ownerExists) {
    $('#lg-setup-link').innerHTML = 'First time here? <button type="button" class="link-btn" id="lg-to-setup">Set up the owner account</button>';
    $('#su-title').textContent = 'Set up the owner account';
    $('#su-intro').textContent = 'This shop has no owner account yet. The first account created here becomes the owner.';
    $('#su-go').textContent = 'Create owner account';
  } else {
    $('#lg-setup-link').innerHTML = 'New co-owner? <button type="button" class="link-btn" id="lg-to-setup">Create an account</button>';
    $('#su-title').textContent = 'Create an account';
    $('#su-intro').textContent = "Creating an account doesn't make you an owner. Once it's made, ask an existing owner to add your email under Owners.";
    $('#su-go').textContent = 'Create account';
  }
  $('#lg-to-setup').addEventListener('click', () => { $('#login-mode').hidden = true; $('#setup-mode').hidden = false; $('#su-name').focus(); });
}

function wireLogin() {
  $('#login-mode').addEventListener('submit', doLogin);
  $('#setup-mode').addEventListener('submit', doSetup);
  $('#su-back').addEventListener('click', () => { $('#setup-mode').hidden = true; $('#login-mode').hidden = false; });
}

async function doLogin(e) {
  e.preventDefault();
  const msg = $('#lg-msg');
  const email = $('#lg-email').value.trim();
  const password = $('#lg-pass').value;
  showMsg(msg, '');
  if (!email || !password) { showMsg(msg, 'Enter your email and password.', 'error'); return; }
  storageSet(KEEP_KEY, $('#lg-keep').checked ? '1' : '0');
  await withBusy($('#lg-go'), async () => {
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      $('#lg-pass').value = '';
      if (error) { showMsg(msg, authMessage(error), 'error'); return; }
      await afterAuth();
    } catch (err) {
      $('#lg-pass').value = '';
      showMsg(msg, authMessage(err), 'error');
    }
  });
}

async function doSetup(e) {
  e.preventDefault();
  const msg = $('#su-msg');
  const fullName = $('#su-name').value.trim();
  const email = $('#su-email').value.trim();
  const password = $('#su-pass').value;
  showMsg(msg, '');
  if (!fullName || !email) { showMsg(msg, 'Please fill in your name and email.', 'error'); return; }
  if (password.length < 8 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    showMsg(msg, 'Use a password of at least 8 characters, with letters and numbers.', 'error');
    return;
  }
  storageSet(KEEP_KEY, '0');
  await withBusy($('#su-go'), async () => {
    try {
      const { data, error } = await sb.auth.signUp({ email, password });
      $('#su-pass').value = '';
      if (error) { showMsg(msg, authMessage(error), 'error'); return; }
      if (!data.session) {
        showMsg(msg, 'Account created. Check your email to confirm it, then sign in.', 'ok');
        return;
      }
      await afterAuth(fullName);
    } catch (err) {
      $('#su-pass').value = '';
      showMsg(msg, authMessage(err), 'error');
    }
  });
}

// Right after signing in: if the shop has no owner yet, this account claims it (only ever once).
async function afterAuth(fullName = '') {
  try {
    if (!(await rpc('owner_account_exists'))) await rpc('claim_owner_account', { p_full_name: fullName || 'Owner' });
  } catch { /* claimed by someone else in the meantime; checked below */ }
  let isOwner = false;
  try { isOwner = await rpc('am_i_owner'); } catch (err) {
    showLogin(friendlyError(err));
    return;
  }
  if (!isOwner) { showPending(); return; }
  await showAdmin();
}

function showPending() {
  $('#login-screen').innerHTML = `
    <div class="modal">
      <h3>You're signed in</h3>
      <p class="small muted">This account isn't an owner yet. Ask an existing owner to add your email under Owners, then sign in again.</p>
      <button class="btn btn-ghost btn-block" type="button" id="pending-signout">Sign out</button>
    </div>`;
  $('#login-screen').hidden = false;
  $('#pending-signout').addEventListener('click', signOut);
}

async function signOut() {
  try { await sb.auth.signOut(); } catch { /* local session is cleared either way */ }
  authStorage.removeItem(`sb-${new URL(CONFIG.supabase.url).hostname.split('.')[0]}-auth-token`);
  location.replace('admin');
}

function isAuthLoss(err) {
  return !!err && err.userMessage === 'Owner access required.';
}

// One place to show an error from an owner action. A lost session sends the owner back to sign in.
function report(err, el) {
  if (isAuthLoss(err)) {
    stopTimers();
    showLogin('Your session has ended. Please sign in again.');
    return;
  }
  if (el) showError(el, err); else toastError(err);
}

// ---------------------------------------------------------------- shell, tabs, timers
let site = null;       // site_config row
let dbV2 = false;      // has the v2 database update been applied?
let activeTab = 'queue';
const timers = [];
const stopTimers = () => { timers.splice(0).forEach(clearInterval); };

const TABS = {
  queue: () => loadQueueTab(),
  bookings: () => loadBookingsTab(),
  chat: () => loadChatTab(),
  payments: () => loadPaymentsTab(),
  feedback: () => loadFeedbackTab(),
  requests: () => loadRequestsTab(),
  hours: () => loadHoursTab(),
  shop: () => loadShopTab(),
  arrivals: () => loadArrivalTab(),
  page: () => loadPageTab(),
  legal: () => loadLegalTab(),
  styles: () => loadStylesTab(),
  owners: () => loadOwnersTab(),
};

async function loadSite() {
  const rows = await select('site_config', 'id=eq.1&select=*');
  site = rows[0];
  dbV2 = site && Object.prototype.hasOwnProperty.call(site, 'content');
  $('#db-warning').hidden = dbV2;
}

function showTab(name) {
  if (!TABS[name]) name = 'queue';
  activeTab = name;
  $$('.admin-side a[data-tab]').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === name);
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $$('.admin-main > section[data-panel]').forEach((s) => { s.hidden = s.dataset.panel !== name; });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  Promise.resolve().then(TABS[name]).catch((err) => report(err));
}

async function showAdmin() {
  $('#login-screen').hidden = true;
  $('#admin-shell').hidden = false;
  try { await loadSite(); } catch (err) { report(err); }
  renderOwnerNotify().catch(() => {});
  // Clear cancelled and old records (also runs every 10 minutes on the database when it can).
  try { await rpc('admin_run_cleanup'); } catch { /* older database: nothing to run */ }
  purgeOldStyleRequests().catch(() => {});
  wireShell();
  showTab(location.hash.slice(1));
  refreshBadges();
  timers.push(setInterval(() => { if (!document.hidden) refreshBadges(); }, 30000));
  timers.push(setInterval(() => {
    if (document.hidden) return;
    if (activeTab === 'queue') loadQueueTab().catch(() => {});
    if (activeTab === 'chat') loadChatTab().catch(() => {});
  }, 15000));
}

// ---------------------------------------------------------------- the owner's notifications (2.7.0)
const OWNER_NOTIFY_TEXT = {
  on: "Notifications are on for this phone: new bookings, messages, check-ins, cancellations, payment requests and reviews.",
  off: 'Get a notification for new bookings, messages, check-ins, cancellations, payment requests and reviews, even with this panel closed.',
  blocked: "Notifications are blocked for this site. Allow them in the browser's site settings (the lock icon next to the address), then reload this page.",
  'ios-install': 'On iPhone, add this page to your Home Screen (Share, then Add to Home Screen), open it from there and turn notifications on.',
  unsupported: "This browser can't show notifications. Open the owner panel in Chrome, Edge, Firefox or Safari.",
  app: "Open the owner panel in your phone's browser (Chrome) to get notifications there.",
};

let ownerNotifyWired = false;
async function renderOwnerNotify() {
  const card = $('#owner-notify');
  if (!card) return;
  const state = await ownerPushState();
  if (state === 'unavailable') { card.hidden = true; return; }
  card.hidden = false;
  card.dataset.state = state;
  $('#on-text').textContent = OWNER_NOTIFY_TEXT[state] || OWNER_NOTIFY_TEXT.unsupported;
  $('#on-btn').hidden = state !== 'off';
  $('#on-test').hidden = state !== 'on';
  $('#on-off').hidden = state !== 'on';
  if (ownerNotifyWired) return;
  ownerNotifyWired = true;
  $('#on-btn').addEventListener('click', () => withBusy($('#on-btn'), async () => {
    try {
      const next = await ownerTurnOn();
      if (next === 'on') toast("Notifications are on. You'll hear about new bookings and messages.");
    } catch (err) { report(err); }
    await renderOwnerNotify();
  }));
  $('#on-test').addEventListener('click', async () => {
    const btn = $('#on-test');
    btn.disabled = true;
    try { await sendTestPush(); toast('Sent. It should arrive in a few seconds.'); } catch (err) { report(err); }
    setTimeout(() => { btn.disabled = false; }, 60000);
  });
  $('#on-off').addEventListener('click', async () => {
    try { await ownerTurnOff(); } catch (err) { report(err); }
    await renderOwnerNotify();
  });
  // The sound this panel plays for a new booking while it's open (lib/soundui.js).
  $('#on-sounds').addEventListener('click', () => openSounds({
    kinds: ['alert'], labels: { alert: 'New bookings while this panel is open' }, place: 'this panel',
  }));
}

let shellWired = false;
function wireShell() {
  if (shellWired) return;
  shellWired = true;
  const side = $('#admin-side');
  const backdrop = $('#admin-side-backdrop');
  const toggle = $('#admin-nav-toggle');
  const closeNav = () => { side.classList.remove('open'); backdrop.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', () => {
    const open = side.classList.toggle('open');
    backdrop.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  backdrop.addEventListener('click', closeNav);
  $$('.admin-side a[data-tab]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    closeNav();
    showTab(a.dataset.tab);
  }));
  $('#logout-link').addEventListener('click', (e) => { e.preventDefault(); signOut(); });

  $('#walkin-form').addEventListener('submit', addWalkIn);
  $('#queue-table').addEventListener('click', onBookingAction);
  $('#bookings-table').addEventListener('click', onBookingAction);
  $('#bk-date-filter').value = todayISO();
  $('#bk-date-filter').addEventListener('change', () => loadBookingsTab().catch((err) => report(err)));
  $('#bk-prev').addEventListener('click', () => shiftDay(-1));
  $('#bk-next').addEventListener('click', () => shiftDay(1));
  $('#bk-today').addEventListener('click', () => { $('#bk-date-filter').value = todayISO(); loadBookingsTab().catch((err) => report(err)); });
  $('#thread-list').addEventListener('click', (e) => {
    const el = e.target.closest('[data-thread]');
    if (el) openThread(el.dataset.thread).catch((err) => report(err));
  });
  $('#admin-chat-form').addEventListener('submit', sendReply);
  $('#admin-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#admin-chat-form').requestSubmit(); }
  });
  $('#pay-form').addEventListener('submit', savePaymentDetails);
  $('#payments-table').addEventListener('click', onPaymentAction);
  $('#feedback-list').addEventListener('click', onFeedbackAction);
  $('#requests-list').addEventListener('click', onRequestAction);
  $('#hours-form').addEventListener('submit', saveHours);
  $('#hours-form').addEventListener('input', updateHoursPreview);
  $('#shop-form').addEventListener('submit', saveShop);
  $('#arrival-form').addEventListener('submit', saveArrival);
  $('#arrival-form').addEventListener('input', updateArrivalMap);
  $('#ar-here').addEventListener('click', useCurrentLocation);
  $('#page-form').addEventListener('submit', savePage);
  $('#pg-groups').addEventListener('click', onTextReset);
  $('#pg-groups').addEventListener('input', onTextInput);
  $('#legal-form').addEventListener('submit', saveLegal);
  $('#legal-docs').addEventListener('click', onLegalReset);
  $('#style-form').addEventListener('submit', createStyle);
  $('#styles-list').addEventListener('click', onStyleAction);
  $('#styles-list').addEventListener('change', onStyleUpload);
  $('#owner-form').addEventListener('submit', addOwner);
  $('#owners-table').addEventListener('click', onOwnerAction);
}

// Sidebar badges, plus a chime when a new booking comes in for today.
let knownToday = null;
async function refreshBadges() {
  try {
    const [threads, pending, today] = await Promise.all([
      rpc('admin_list_chat_threads'),
      rpc('admin_list_pending_payments'),
      rpc('admin_bookings_for_date', { p_date: todayISO() }),
    ]);
    const unread = (threads || []).reduce((n, t) => n + Number(t.unread_count || 0), 0);
    setBadge('#badge-chat', unread);
    setBadge('#badge-pay', (pending || []).filter((p) => p.payment_status === 'requested').length);
    noticeNewBookings(today || []);
  } catch (err) {
    if (isAuthLoss(err)) report(err);
  }
}

function setBadge(sel, n) {
  const b = $(sel);
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = !n;
}

function noticeNewBookings(rows) {
  const ids = new Set(rows.map((r) => r.id));
  if (knownToday) {
    const fresh = rows.filter((r) => !knownToday.has(r.id) && r.status === 'booked');
    if (fresh.length) {
      chime();
      toast(fresh.length === 1 ? `New booking: ${fresh[0].client_name} at ${fmtTime(fresh[0].slot_time)}` : `${fresh.length} new bookings today`);
    }
  }
  knownToday = ids;
}

// ---------------------------------------------------------------- bookings (queue + all bookings)
const STATUS_LABEL = {
  booked: 'Booked', on_deck: 'On deck', called: 'Called', checked_in: 'Checked in', in_chair: 'In chair',
  done: 'Done', no_show: 'No-show', cancelled: 'Cancelled',
};
const PAY_LABEL = { none: '', requested: 'Wants to pay online', approved: 'Approved, awaiting payment', paid: 'Paid' };
const WAITING = ['booked', 'on_deck', 'called', 'checked_in'];
const shopClock = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// Under the booked time: when the cut actually started (makes early cuts obvious).
// Checked in by arriving at the shop (their phone told the site), rather than by tapping "I'm here".
function arrivedTag(r) {
  return r.arrived_auto && ['checked_in', 'in_chair', 'done'].includes(r.status)
    ? ' <span class="arrived-tag" title="Checked in automatically when they arrived">arrived</span>' : '';
}

function startedNote(r) {
  if (!r.started_at || !['in_chair', 'done'].includes(r.status)) return '';
  return `<div class="small muted">started ${fmtTime(shopClock.format(new Date(r.started_at)))}</div>`;
}

const phoneLink = (p) => {
  const tel = String(p || '').replace(/[^\d+]/g, '');
  return tel.length >= 9 ? `<a href="tel:${esc(tel)}">${esc(p)}</a>` : esc(p);
};

function bookingActions(r, { full }) {
  const out = [];
  if (full && WAITING.includes(r.status)) out.push(`<button class="btn btn-sm btn-gold" data-act="start" data-id="${esc(r.id)}">Start cut</button>`);
  if (full && r.status === 'in_chair') out.push(`<button class="btn btn-sm btn-gold" data-act="finish" data-id="${esc(r.id)}">Done</button>`);
  if (full && ['booked', 'on_deck', 'called'].includes(r.status)) out.push(`<button class="btn btn-sm btn-ghost" data-act="noshow" data-id="${esc(r.id)}">No-show</button>`);
  if (dbV2 && WAITING.includes(r.status)) out.push(`<button class="btn btn-sm btn-ghost" data-act="cancel" data-id="${esc(r.id)}">Cancel</button>`);
  return out.join('');
}

async function loadQueueTab() {
  const rows = await rpc('admin_bookings_for_date', { p_date: todayISO() });
  noticeNewBookings(rows);
  const count = (fn) => rows.filter(fn).length;
  $('#queue-stats').innerHTML = `
    <div class="stat"><div class="n">${count((r) => WAITING.includes(r.status))}</div><div class="l">Waiting</div></div>
    <div class="stat"><div class="n">${count((r) => r.status === 'in_chair')}</div><div class="l">In the chair</div></div>
    <div class="stat"><div class="n">${count((r) => r.status === 'done')}</div><div class="l">Done today</div></div>
    <div class="stat"><div class="n">${count((r) => r.status === 'no_show')}</div><div class="l">No-shows</div></div>`;
  const visible = rows.filter((r) => r.status !== 'cancelled');
  $('#queue-table').innerHTML = visible.map((r) => `
    <tr>
      <td data-label="Time"><b>${fmtTime(r.slot_time)}</b>${startedNote(r)}</td>
      <td data-label="Name">${esc(r.client_name)}${arrivedTag(r)}</td>
      <td data-label="Phone">${phoneLink(r.client_phone)}</td>
      <td data-label="Style" class="small muted">${esc(r.style_choice || '')}</td>
      <td data-label="Status"><span class="status-pill status-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
      <td class="actions">${bookingActions(r, { full: true })}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No bookings for today yet.</td></tr>';
}

async function loadBookingsTab() {
  const day = $('#bk-date-filter').value || todayISO();
  const rows = await rpc('admin_bookings_for_date', { p_date: day });
  const isToday = day === todayISO();
  $('#bookings-table').innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Time"><b>${fmtTime(r.slot_time)}</b>${startedNote(r)}</td>
      <td data-label="Name">${esc(r.client_name)}${arrivedTag(r)}</td>
      <td data-label="Phone">${phoneLink(r.client_phone)}</td>
      <td data-label="Style" class="small muted">${esc(r.style_choice || '')}</td>
      <td data-label="Status"><span class="status-pill status-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
      <td data-label="Payment" class="small muted">${esc(PAY_LABEL[r.payment_status] || '')}</td>
      <td class="actions">${bookingActions(r, { full: isToday })}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No bookings that day.</td></tr>';
}

function shiftDay(delta) {
  const input = $('#bk-date-filter');
  input.value = addDaysISO(input.value || todayISO(), delta);
  loadBookingsTab().catch((err) => report(err));
}

const BOOKING_ACTIONS = {
  start: ['admin_start_cut', null],
  finish: ['admin_finish_cut', null],
  noshow: ['admin_mark_no_show', 'Mark this client as a no-show? Their slot becomes free again.'],
  cancel: ['admin_cancel_booking', 'Cancel this booking? It will be deleted and the slot becomes free again.'],
};

async function onBookingAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || !BOOKING_ACTIONS[btn.dataset.act]) return;
  const [fn, question] = BOOKING_ACTIONS[btn.dataset.act];
  if (question && !window.confirm(question)) return;
  await withBusy(btn, async () => {
    try {
      await rpc(fn, { p_booking_id: btn.dataset.id });
    } catch (err) {
      report(err);
    }
    await Promise.allSettled([activeTab === 'bookings' ? loadBookingsTab() : loadQueueTab()]);
  });
}

async function addWalkIn(e) {
  e.preventDefault();
  const name = $('#wi-name').value.trim();
  if (!name) { $('#wi-name').focus(); return; }
  await withBusy($('#wi-add'), async () => {
    try {
      const slot = await rpc('admin_add_walkin', { p_name: name, p_phone: $('#wi-phone').value.trim() });
      $('#walkin-form').reset();
      toast(slot ? `${name} added at ${fmtTime(slot)}.` : `${name} added.`);
      await loadQueueTab();
    } catch (err) {
      report(err);
    }
  });
}

// ---------------------------------------------------------------- messages
let activeThread = null;
let threadNames = new Map();

async function loadChatTab() {
  const threads = (await rpc('admin_list_chat_threads')) || [];
  threadNames = new Map(threads.map((t) => [t.client_token, t.client_name || `Visitor ${t.client_token.slice(0, 4).toUpperCase()}`]));
  $('#thread-list').innerHTML = threads.length ? threads.map((t) => `
    <div class="thread${t.client_token === activeThread ? ' active' : ''}" data-thread="${esc(t.client_token)}" role="button" tabindex="0">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <b>${esc(threadNames.get(t.client_token))}</b>
        ${Number(t.unread_count) > 0 ? `<span class="badge">${Number(t.unread_count)}</span>` : ''}
      </div>
      <p class="small muted" style="margin:4px 0 0">${esc(String(t.last_message || '').slice(0, 70))}</p>
    </div>`).join('') : '<p class="muted">No messages yet.</p>';
  if (activeThread) await openThread(activeThread, { quiet: true });
}

async function openThread(token, { quiet = false } = {}) {
  const switching = token !== activeThread;
  activeThread = token;
  const rows = (await rpc('get_my_messages', { p_token: token })) || [];
  $('#thread-title').textContent = threadNames.get(token) || 'Conversation';
  const box = $('#admin-chat-box');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = rows.map((m) => `<div class="msg ${m.sender === 'owner' ? 'client' : 'owner'}">${esc(m.body)}<time>${clock.format(new Date(m.created_at))}</time></div>`).join('');
  if (switching || nearBottom) box.scrollTop = box.scrollHeight;
  $$('#thread-list .thread').forEach((el) => el.classList.toggle('active', el.dataset.thread === token));
  if (rows.some((m) => m.sender === 'client' && !m.read_by_owner)) {
    try {
      await rpc('admin_mark_thread_read', { p_token: token });
      if (!quiet) { refreshBadges(); loadChatTab().catch(() => {}); }
    } catch (err) {
      if (!isMissingFunction(err)) throw err;
    }
  }
}

async function sendReply(e) {
  e.preventDefault();
  const input = $('#admin-chat-input');
  const body = input.value.trim();
  if (!activeThread) { toast('Pick a conversation first.'); return; }
  if (!body) return;
  await withBusy($('#admin-chat-send'), async () => {
    try {
      await rpc('admin_reply_message', { p_token: activeThread, p_body: body });
      input.value = '';
      await loadChatTab();
      refreshBadges();
    } catch (err) {
      report(err);
    }
  });
}

// ---------------------------------------------------------------- payments
async function loadPaymentsTab() {
  const [details, rows] = await Promise.all([rpc('admin_get_payment_details'), rpc('admin_list_pending_payments')]);
  $('#pc-instructions').value = details || '';
  $('#payments-table').innerHTML = (rows || []).map((r) => `
    <tr>
      <td data-label="Date">${esc(r.booking_date)}</td>
      <td data-label="Time">${fmtTime(r.slot_time)}</td>
      <td data-label="Name">${esc(r.client_name)}</td>
      <td data-label="Status"><span class="status-pill ${r.payment_status === 'requested' ? 'status-called' : 'status-checked_in'}">${esc(PAY_LABEL[r.payment_status] || r.payment_status)}</span></td>
      <td class="actions">
        ${r.payment_status === 'requested' ? `<button class="btn btn-sm btn-gold" data-pay="approve" data-id="${esc(r.id)}">Approve</button>` : ''}
        ${r.payment_status === 'approved' ? `<button class="btn btn-sm btn-gold" data-pay="paid" data-id="${esc(r.id)}">Mark paid</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing needs your attention.</td></tr>';
}

async function savePaymentDetails(e) {
  e.preventDefault();
  const msg = $('#pc-msg');
  await withBusy($('#pc-save'), async () => {
    try {
      await rpc('admin_set_payment_details', { p_instructions: $('#pc-instructions').value.trim() });
      showMsg(msg, 'Saved.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

async function onPaymentAction(e) {
  const btn = e.target.closest('[data-pay]');
  if (!btn) return;
  const paid = btn.dataset.pay === 'paid';
  if (paid && !window.confirm('Have you checked that this money is in your account?')) return;
  await withBusy(btn, async () => {
    try {
      await rpc(paid ? 'admin_mark_paid' : 'admin_approve_payment', { p_booking_id: btn.dataset.id });
      await loadPaymentsTab();
      refreshBadges();
    } catch (err) {
      report(err);
    }
  });
}

// ---------------------------------------------------------------- reviews
async function loadFeedbackTab() {
  const rows = (await rpc('admin_list_feedback')) || [];
  $('#feedback-list').innerHTML = rows.length ? rows.map((r) => `
    <div class="review">
      <div class="stars-sm"><span class="gold">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> <b>${esc(r.client_name || 'Anonymous')}</b>
        <span class="status-pill ${r.is_public ? 'status-in_chair' : 'status-booked'}">${r.is_public ? 'Published' : 'Hidden'}</span>
        <span class="small muted">${esc(new Date(r.created_at).toLocaleDateString('en-GB', { timeZone: CONFIG.timeZone }))}</span></div>
      ${r.comment ? `<p class="small">${esc(r.comment)}</p>` : ''}
      ${r.reply ? `<div class="reply"><b>Your reply:</b> ${esc(r.reply)}</div>` : ''}
      <div class="inline-form" style="margin:10px 0 0">
        <button class="btn btn-sm" data-fb="toggle" data-id="${esc(r.id)}" data-public="${!r.is_public}">${r.is_public ? 'Hide' : 'Publish'}</button>
        <input placeholder="Write a reply" data-reply-input="${esc(r.id)}" maxlength="1000">
        <button class="btn btn-sm btn-gold" data-fb="reply" data-id="${esc(r.id)}">Reply</button>
        ${dbV2 ? `<button class="btn btn-sm btn-ghost" data-fb="delete" data-id="${esc(r.id)}">Delete</button>` : ''}
      </div>
    </div>`).join('') : '<p class="muted">No reviews yet.</p>';
}

async function onFeedbackAction(e) {
  const btn = e.target.closest('[data-fb]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.fb;
  if (action === 'delete' && !window.confirm('Delete this review for good?')) return;
  await withBusy(btn, async () => {
    try {
      if (action === 'toggle') await rpc('admin_set_feedback_public', { p_id: id, p_public: btn.dataset.public === 'true' });
      if (action === 'delete') await rpc('admin_delete_feedback', { p_id: id });
      if (action === 'reply') {
        const input = document.querySelector(`[data-reply-input="${CSS.escape(id)}"]`);
        if (!input || !input.value.trim()) { input && input.focus(); return; }
        await rpc('admin_reply_feedback', { p_id: id, p_reply: input.value.trim() });
      }
      await loadFeedbackTab();
    } catch (err) {
      report(err);
    }
  });
}

// ---------------------------------------------------------------- style requests
// Requests older than keep_days that have a photo: the database can't remove the photo itself
// (files go through the Storage API), so the panel does it here, photo first, then the request.
async function purgeOldStyleRequests() {
  let due;
  try { due = (await rpc('admin_expired_style_requests')) || []; } catch { return; } // older database
  if (!due.length) return;
  const paths = due.map((r) => r.storage_path).filter(Boolean);
  try {
    if (paths.length) await removeFiles('style-requests', paths);
  } catch {
    return; // keep the requests so the photos are tried again next time
  }
  for (const r of due) {
    try { await rpc('admin_delete_style_request', { p_id: r.id }); } catch { /* tried again next time */ }
  }
}

let requestRows = [];
async function loadRequestsTab() {
  requestRows = (await rpc('admin_list_style_requests')) || [];
  const list = $('#requests-list');
  if (!requestRows.length) { list.innerHTML = '<p class="muted">No style requests yet.</p>'; return; }
  list.innerHTML = requestRows.map((r) => `
    <div class="review">
      <div class="small muted">${esc(new Date(r.created_at).toLocaleString('en-GB', { timeZone: CONFIG.timeZone }))}</div>
      ${r.description ? `<p>${esc(r.description)}</p>` : ''}
      ${r.storage_path ? `<div class="photo-grid" style="max-width:220px"><div class="photo-thumb" data-photo-slot="${esc(r.id)}"><span class="muted small">Loading photo&hellip;</span></div></div>` : ''}
      <button class="btn btn-sm btn-ghost" data-del-request="${esc(r.id)}">Delete</button>
    </div>`).join('');
  await Promise.all(requestRows.filter((r) => r.storage_path).map(async (r) => {
    const slot = document.querySelector(`[data-photo-slot="${CSS.escape(r.id)}"]`);
    if (!slot) return;
    try {
      const url = await signedFileUrl('style-requests', r.storage_path, 600);
      slot.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Requested style"></a>`;
    } catch {
      slot.innerHTML = '<span class="muted small">Photo unavailable</span>';
    }
  }));
}

async function onRequestAction(e) {
  const btn = e.target.closest('[data-del-request]');
  if (!btn || !window.confirm('Delete this request?')) return;
  const row = requestRows.find((r) => r.id === btn.dataset.delRequest);
  await withBusy(btn, async () => {
    try {
      await rpc('admin_delete_style_request', { p_id: btn.dataset.delRequest });
      if (row && row.storage_path) removeFiles('style-requests', [row.storage_path]).catch(() => {});
      await loadRequestsTab();
    } catch (err) {
      report(err);
    }
  });
}

// ---------------------------------------------------------------- hours & slots
const SLOT_CHOICES = [10, 15, 20, 25, 30, 40, 45, 60, 75, 90, 120];
const hasKeepDays = () => !!site && Object.prototype.hasOwnProperty.call(site, 'keep_days'); // database update 10

async function loadHoursTab() {
  await loadSite();
  const current = Number(site.slot_minutes) || 30;
  const choices = [...new Set([...SLOT_CHOICES, current])].sort((a, b) => a - b);
  $('#hr-slot').innerHTML = choices.map((m) => `<option value="${m}">${m} minutes</option>`).join('');
  $('#hr-slot').value = String(current);
  $('#hr-open').value = String(site.open_time).slice(0, 5);
  $('#hr-close').value = String(site.close_time).slice(0, 5);
  $('#hr-days').value = site.booking_days_ahead ?? 7;
  $('#hr-reminder').value = site.reminder_minutes ?? 10;
  $('#hr-keep').value = site.keep_days ?? 90;
  $('#hr-keep').disabled = !hasKeepDays();
  const closed = new Set(site.closed_weekdays || []);
  $('#hr-closed').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => `
    <label><input type="checkbox" value="${d}"${closed.has(d) ? ' checked' : ''}> ${dayName(d)}</label>`).join('');
  for (const id of ['#hr-slot', '#hr-days', '#hr-reminder']) $(id).disabled = !dbV2;
  $$('#hr-closed input').forEach((i) => { i.disabled = !dbV2; });
  showMsg($('#hr-msg'), '');
  updateHoursPreview();
}

function updateHoursPreview() {
  const open = $('#hr-open').value;
  const close = $('#hr-close').value;
  const len = Number($('#hr-slot').value);
  const box = $('#hr-preview');
  if (!open || !close || !len || toMin(close) <= toMin(open)) {
    box.innerHTML = '<b>Closing time must be after opening time.</b>';
    return;
  }
  const slots = daySlots(open, close, len);
  if (!slots.length) { box.innerHTML = '<b>The opening hours are shorter than one slot.</b>'; return; }
  const shown = slots.length > 8 ? [...slots.slice(0, 4).map(fmtTime), '…', ...slots.slice(-2).map(fmtTime)] : slots.map(fmtTime);
  box.innerHTML = `<b>${slots.length} slots a day:</b> ${esc(shown.join(', '))}. The last cut starts at ${fmtTime(slots[slots.length - 1])}.`;
}

async function saveHours(e) {
  e.preventDefault();
  const msg = $('#hr-msg');
  const open = $('#hr-open').value;
  const close = $('#hr-close').value;
  if (!open || !close || toMin(close) <= toMin(open)) { showMsg(msg, 'Closing time must be after opening time.', 'error'); return; }
  const payload = { open_time: open, close_time: close };
  if (dbV2) {
    const days = Number($('#hr-days').value);
    const reminder = Number($('#hr-reminder').value);
    const closed = $$('#hr-closed input:checked').map((i) => Number(i.value));
    if (!Number.isInteger(days) || days < 1 || days > 60) { showMsg(msg, 'Days ahead must be a whole number from 1 to 60.', 'error'); return; }
    if (!Number.isInteger(reminder) || reminder < 0 || reminder > 120) { showMsg(msg, 'The heads-up must be a whole number from 0 to 120.', 'error'); return; }
    if (closed.length >= 7) { showMsg(msg, 'The shop needs at least one open day.', 'error'); return; }
    if (daySlots(open, close, Number($('#hr-slot').value)).length === 0) { showMsg(msg, 'The opening hours are shorter than one slot.', 'error'); return; }
    Object.assign(payload, { slot_minutes: Number($('#hr-slot').value), booking_days_ahead: days, reminder_minutes: reminder, closed_weekdays: closed });
  }
  if (hasKeepDays()) {
    const keep = Number($('#hr-keep').value);
    if (!Number.isInteger(keep) || keep < 7 || keep > 365) { showMsg(msg, 'Keep records for a whole number of days from 7 to 365.', 'error'); return; }
    payload.keep_days = keep;
  }
  await withBusy($('#hr-save'), async () => {
    try {
      await rpc('admin_update_site_config', { p: payload });
      await loadSite();
      showMsg(msg, 'Saved. The public page uses the new hours straight away.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

// ---------------------------------------------------------------- shop details
const SHOP_FIELDS = ['shop_name', 'tagline', 'owner_name', 'address_line', 'directions_text', 'about_text', 'phone', 'whatsapp', 'facebook', 'instagram', 'price_kwacha', 'rating', 'rating_count'];

async function loadShopTab() {
  await loadSite();
  for (const f of SHOP_FIELDS) $(`#sc-${f}`).value = site[f] ?? '';
  showMsg($('#sc-msg'), '');
}

async function saveShop(e) {
  e.preventDefault();
  const msg = $('#sc-msg');
  const payload = {};
  for (const f of SHOP_FIELDS) payload[f] = $(`#sc-${f}`).value.trim();
  if (!payload.shop_name) { showMsg(msg, 'Please enter the shop name.', 'error'); return; }
  if (!payload.owner_name) { showMsg(msg, "Please enter the owner's name.", 'error'); return; }
  for (const f of ['facebook', 'instagram']) {
    if (payload[f] && !/^https:\/\/\S+$/i.test(payload[f])) { showMsg(msg, 'Facebook and Instagram links must start with https://', 'error'); return; }
  }
  const rating = Number(payload.rating);
  if (payload.rating !== '' && (Number.isNaN(rating) || rating < 0 || rating > 5)) { showMsg(msg, 'The rating must be between 0 and 5.', 'error'); return; }
  if (payload.price_kwacha !== '' && (Number.isNaN(Number(payload.price_kwacha)) || Number(payload.price_kwacha) < 0)) { showMsg(msg, 'Please enter a valid price.', 'error'); return; }
  await withBusy($('#sc-save'), async () => {
    try {
      await rpc('admin_update_site_config', { p: payload });
      await loadShopTab();
      showMsg(msg, 'Saved.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

// ---------------------------------------------------------------- arrivals (check-in on arrival, automatic start)
async function loadArrivalTab() {
  await loadSite();
  const has = Object.prototype.hasOwnProperty.call(site, 'shop_lat');
  $('#ar-save').disabled = !has;
  showMsg($('#ar-msg'), has ? '' : 'The database needs the 2.5.0 update (supabase/migrations/12_arrival_checkin.sql) before these can be saved.', has ? 'ok' : 'error');
  showMsg($('#ar-here-msg'), '');
  $('#ar-lat').value = site.shop_lat ?? '';
  $('#ar-lng').value = site.shop_lng ?? '';
  $('#ar-radius').value = site.arrival_radius_m ?? 150;
  $('#ar-auto-checkin').checked = site.auto_checkin !== false;
  $('#ar-auto-start').checked = site.auto_start !== false;
  updateArrivalMap();
}

function arrivalInputs() {
  const lat = $('#ar-lat').value.trim();
  const lng = $('#ar-lng').value.trim();
  return { lat: lat === '' ? null : Number(lat), lng: lng === '' ? null : Number(lng) };
}

function updateArrivalMap() {
  const { lat, lng } = arrivalInputs();
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const link = $('#ar-map');
  link.hidden = !ok;
  if (ok) link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;
}

function useCurrentLocation() {
  const msg = $('#ar-here-msg');
  if (!('geolocation' in navigator)) { showMsg(msg, "This browser can't share its location. Type the latitude and longitude instead.", 'error'); return; }
  const btn = $('#ar-here');
  btn.disabled = true;
  showMsg(msg, 'Finding your location...');
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    $('#ar-lat').value = pos.coords.latitude.toFixed(6);
    $('#ar-lng').value = pos.coords.longitude.toFixed(6);
    updateArrivalMap();
    const acc = Math.round(pos.coords.accuracy || 0);
    showMsg(msg, `Found, accurate to about ${acc} m. Check it on the map, then save.`, acc > 100 ? 'error' : 'ok');
  }, (err) => {
    btn.disabled = false;
    showMsg(msg, err.code === 1
      ? 'Location is blocked for this site. Allow it in your browser settings, or type the latitude and longitude.'
      : "Couldn't find your location. Try again near a window, or type the latitude and longitude.", 'error');
  }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

async function saveArrival(e) {
  e.preventDefault();
  const msg = $('#ar-msg');
  const { lat, lng } = arrivalInputs();
  if ((lat === null) !== (lng === null)) { showMsg(msg, 'Enter both the latitude and the longitude, or leave both empty.', 'error'); return; }
  if (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
    showMsg(msg, "That location isn't valid. Check the latitude and longitude.", 'error');
    return;
  }
  const radius = Number($('#ar-radius').value || 150);
  if (!Number.isInteger(radius) || radius < 30 || radius > 1000) { showMsg(msg, 'The arrival distance must be between 30 and 1000 metres.', 'error'); return; }
  await withBusy($('#ar-save'), async () => {
    try {
      await rpc('admin_set_arrival', {
        p_lat: lat, p_lng: lng, p_radius: radius,
        p_auto_checkin: $('#ar-auto-checkin').checked, p_auto_start: $('#ar-auto-start').checked,
      });
      await loadArrivalTab();
      showMsg(msg, lat === null ? 'Saved. Set the shop\'s location to start checking clients in on arrival.' : 'Saved.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

// ---------------------------------------------------------------- public page wording + sections
function currentTexts() {
  return (site && site.content && site.content.text) || {};
}

async function loadPageTab() {
  await loadSite();
  const hidden = new Set((site.content && site.content.hidden) || []);
  $('#pg-announcement').value = site.announcement || '';
  $('#pg-sections').innerHTML = SECTIONS.map((s) => `
    <label><input type="checkbox" value="${esc(s.id)}"${hidden.has(s.id) ? '' : ' checked'}> ${esc(s.label)}</label>`).join('');
  $('#pg-placeholders').innerHTML = Object.entries(PLACEHOLDERS).map(([k, v]) => `<code>${esc(k)}</code> ${esc(v)}`).join(' &middot; ');
  const texts = currentTexts();
  $('#pg-groups').innerHTML = TEXT_GROUPS.map((g, i) => `
    <details class="text-group"${i === 0 ? ' open' : ''}>
      <summary>${esc(g.title)}</summary>
      <div class="group-body">
        ${Object.keys(g.keys).map((key) => textFieldHtml(key, texts[key])).join('')}
      </div>
    </details>`).join('');
  const locked = !dbV2;
  $$('#page-form input, #page-form textarea').forEach((el) => { el.disabled = locked; });
  $('#pg-save').disabled = locked;
  showMsg($('#pg-msg'), '');
}

function textFieldHtml(key, override) {
  const def = DEFAULT_TEXT[key];
  const value = typeof override === 'string' ? override : def;
  const changed = value !== def;
  const long = def.length > 70;
  const id = `tx-${key}`;
  const input = long
    ? `<textarea id="${id}" data-text-key="${key}" maxlength="400" rows="3">${esc(value)}</textarea>`
    : `<input id="${id}" data-text-key="${key}" maxlength="200" value="${esc(value)}">`;
  return `
    <div class="text-field${changed ? ' changed' : ''}">
      <div class="field-head"><label for="${id}">${esc(TEXT_LABELS[key])}</label>
        <button type="button" class="link-btn small" data-reset-text="${key}"${changed ? '' : ' hidden'}>Reset</button></div>
      ${input}
      ${changed && def ? `<p class="hint">Default: ${esc(def)}</p>` : ''}
    </div>`;
}

function onTextReset(e) {
  const btn = e.target.closest('[data-reset-text]');
  if (!btn) return;
  const key = btn.dataset.resetText;
  const field = btn.closest('.text-field');
  field.outerHTML = textFieldHtml(key, DEFAULT_TEXT[key]);
}

function onTextInput(e) {
  const el = e.target.closest('[data-text-key]');
  if (!el) return;
  const changed = el.value !== DEFAULT_TEXT[el.dataset.textKey];
  const field = el.closest('.text-field');
  field.classList.toggle('changed', changed);
  field.querySelector('[data-reset-text]').hidden = !changed;
}

async function savePage(e) {
  e.preventDefault();
  const msg = $('#pg-msg');
  const text = {};
  for (const el of $$('[data-text-key]')) {
    const key = el.dataset.textKey;
    const value = el.value.trim();
    if (value === DEFAULT_TEXT[key]) continue;
    if (!value && !OPTIONAL_TEXT.has(key)) continue; // empty means "use the default"
    text[key] = value;
  }
  const hidden = $$('#pg-sections input').filter((i) => !i.checked).map((i) => i.value);
  await withBusy($('#pg-save'), async () => {
    try {
      await rpc('admin_update_site_config', { p: { announcement: $('#pg-announcement').value.trim(), content: { text, hidden } } });
      await loadPageTab();
      showMsg(msg, 'Saved. Reload the public page to see it.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

// ---------------------------------------------------------------- legal pages
async function loadLegalTab() {
  await loadSite();
  const saved = (site.content && site.content.legal) || {};
  $('#legal-docs').innerHTML = Object.entries(LEGAL_DOCS).map(([key, doc]) => `
    <div class="card">
      <div class="field-head" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">${esc(doc.title)}</h3>
        <span class="small"><a href="${key}" target="_blank" rel="noopener">View page</a> &middot;
          <button type="button" class="link-btn" data-reset-legal="${key}">Reset to default</button></span>
      </div>
      <label class="sr-only" for="legal-${key}">${esc(doc.title)}</label>
      <textarea id="legal-${key}" data-legal="${key}" maxlength="20000">${esc(typeof saved[key] === 'string' && saved[key].trim() ? saved[key] : doc.text)}</textarea>
    </div>`).join('');
  const locked = !dbV2;
  $$('#legal-form textarea').forEach((el) => { el.disabled = locked; });
  $('#lg-save').disabled = locked;
  showMsg($('#legal-msg'), '');
}

function onLegalReset(e) {
  const btn = e.target.closest('[data-reset-legal]');
  if (!btn) return;
  const key = btn.dataset.resetLegal;
  if (!window.confirm(`Replace the ${LEGAL_DOCS[key].title.toLowerCase()} with the default text? You still need to save.`)) return;
  $(`#legal-${key}`).value = LEGAL_DOCS[key].text;
}

async function saveLegal(e) {
  e.preventDefault();
  const msg = $('#legal-msg');
  const legal = {};
  for (const el of $$('[data-legal]')) {
    const value = el.value.trim();
    if (value && value !== LEGAL_DOCS[el.dataset.legal].text.trim()) legal[el.dataset.legal] = value;
  }
  await withBusy($('#lg-save'), async () => {
    try {
      await rpc('admin_update_site_config', { p: { content: { legal } } });
      await loadLegalTab();
      showMsg(msg, 'Saved.', 'ok');
    } catch (err) {
      report(err, msg);
    }
  });
}

// ---------------------------------------------------------------- haircut styles
let styleGroups = new Map();

async function loadStylesTab() {
  const rows = (await rpc('admin_list_style_photos')) || [];
  styleGroups = new Map();
  for (const r of rows) {
    if (!styleGroups.has(r.style_id)) styleGroups.set(r.style_id, { label: r.label, photos: [] });
    if (r.photo_id) styleGroups.get(r.style_id).photos.push({ id: r.photo_id, path: r.storage_path });
  }
  $('#styles-list').innerHTML = [...styleGroups.entries()].map(([id, s]) => `
    <div class="review">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b>${esc(s.label)}</b>
        <button class="btn btn-sm btn-ghost" data-del-style="${esc(id)}">Delete style</button>
      </div>
      <div class="photo-grid">
        ${s.photos.map((p) => `
          <div class="photo-thumb">
            <img src="${esc(publicFileUrl('haircut-styles', p.path))}" alt="${esc(s.label)}" loading="lazy">
            <button class="photo-del" data-del-photo="${esc(p.id)}" data-style="${esc(id)}" aria-label="Delete photo">&times;</button>
          </div>`).join('')}
      </div>
      <label class="small" for="up-${esc(id)}">Add a photo</label>
      <input id="up-${esc(id)}" type="file" accept="image/*" data-upload-for="${esc(id)}">
    </div>`).join('') || '<p class="muted">No extra styles yet. Add one above.</p>';
}

async function createStyle(e) {
  e.preventDefault();
  const label = $('#st-label').value.trim();
  const msg = $('#st-msg');
  if (!label) { $('#st-label').focus(); return; }
  await withBusy($('#st-add'), async () => {
    try {
      await rpc('admin_create_style', { p_label: label });
      $('#style-form').reset();
      showMsg(msg, 'Style added. Upload a photo for it below; it shows on the site once it has one.', 'ok');
      await loadStylesTab();
    } catch (err) {
      report(err, msg);
    }
  });
}

async function onStyleAction(e) {
  const delStyle = e.target.closest('[data-del-style]');
  const delPhoto = e.target.closest('[data-del-photo]');
  if (delStyle) {
    if (!window.confirm('Delete this style and all its photos?')) return;
    const group = styleGroups.get(delStyle.dataset.delStyle);
    await withBusy(delStyle, async () => {
      try {
        await rpc('admin_delete_style', { p_style_id: delStyle.dataset.delStyle });
        if (group) removeFiles('haircut-styles', group.photos.map((p) => p.path)).catch(() => {});
        await loadStylesTab();
      } catch (err) { report(err); }
    });
  } else if (delPhoto) {
    const group = styleGroups.get(delPhoto.dataset.style);
    const photo = group && group.photos.find((p) => p.id === delPhoto.dataset.delPhoto);
    await withBusy(delPhoto, async () => {
      try {
        await rpc('admin_delete_style_photo', { p_photo_id: delPhoto.dataset.delPhoto });
        if (photo) removeFiles('haircut-styles', [photo.path]).catch(() => {});
        await loadStylesTab();
      } catch (err) { report(err); }
    });
  }
}

async function onStyleUpload(e) {
  const input = e.target.closest('[data-upload-for]');
  if (!input || !input.files[0]) return;
  const styleId = input.dataset.uploadFor;
  input.disabled = true;
  try {
    const blob = await prepareImage(input.files[0]);
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[blob.type] || 'jpg';
    const path = `${styleId}/${Date.now()}.${ext}`;
    await uploadFile('haircut-styles', path, blob);
    await rpc('admin_add_style_photo', { p_style_id: styleId, p_storage_path: path });
    toast('Photo added.');
    await loadStylesTab();
  } catch (err) {
    report(err);
    input.disabled = false;
    input.value = '';
  }
}

// ---------------------------------------------------------------- owners
async function loadOwnersTab() {
  const rows = (await rpc('admin_list_owners')) || [];
  $('#owners-table').innerHTML = rows.map((r) => `
    <tr>
      <td data-label="Name">${esc(r.full_name)}</td>
      <td data-label="Email">${esc(r.email)}</td>
      <td data-label="Added" class="small muted">${esc(new Date(r.created_at).toLocaleDateString('en-GB', { timeZone: CONFIG.timeZone }))}</td>
      <td class="actions">${rows.length > 1 ? `<button class="btn btn-sm btn-ghost" data-remove-owner="${esc(r.id)}">Remove</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No owners yet.</td></tr>';
}

async function addOwner(e) {
  e.preventDefault();
  const email = $('#ow-email').value.trim();
  const msg = $('#ow-msg');
  if (!/^\S+@\S+\.\S+$/.test(email)) { showMsg(msg, 'Please enter a valid email address.', 'error'); return; }
  await withBusy($('#ow-add'), async () => {
    try {
      await rpc('admin_add_owner_by_email', { p_email: email });
      $('#owner-form').reset();
      showMsg(msg, 'Owner added.', 'ok');
      await loadOwnersTab();
    } catch (err) {
      report(err, msg);
    }
  });
}

async function onOwnerAction(e) {
  const btn = e.target.closest('[data-remove-owner]');
  if (!btn || !window.confirm("Remove this person's owner access?")) return;
  await withBusy(btn, async () => {
    try {
      await rpc('admin_remove_owner', { p_id: btn.dataset.removeOwner });
      await loadOwnersTab();
    } catch (err) {
      report(err);
    }
  });
}

boot().catch((err) => showLogin(friendlyError(err)));
