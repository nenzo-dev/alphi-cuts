// Updates for the Android app, shown inside the app only. From app 1.2.0 the app finds a newer version
// itself, installs it when the person taps Update, and says if the phone is blocking the install
// (android/.../Updater.java and InstallBlock.java). Older apps can't install updates themselves, so
// they get the newest version from app/android.json and download it through the phone's browser.
//
// A pop-up says the version on the phone will no longer be supported; "Update now" closes it at once.
// The bar at the top (#app-update) then shows how the update is going, or what's blocking it with an
// "Open settings" button that goes straight to the setting that lifts the block.
import { $, esc, toast } from './ui.js';

const BLOCKED_TEXT = {
  unknown_sources: 'Your phone needs your OK for the app to install updates.',
  policy: 'Your phone is blocking apps from outside the Play Store.',
  security: 'A security check on your phone stopped the update.',
  storage: "There isn't enough space on your phone for the update.",
};

let bridge = null;
let progress = null;   // { stage, pct } while an update is under way
let shownFor = 0;      // the version the pop-up was shown for since the app opened ("Not now" lasts till then)
let fromSite = null;   // the newest version on the website, for apps that can't update themselves
let retry = 0;
let stall = 0;

const status = () => {
  try { return JSON.parse(bridge.info()) || {}; } catch { return {}; }
};
const canSelfUpdate = () => typeof bridge.startUpdate === 'function';
const plain = (v) => String(v || '').replace(/-debug$/, '');

/** The newer version that's ready for this phone, or null. */
function available() {
  const st = status();
  if (st.update) return st.update;
  if (fromSite && Number(fromSite.versionCode) > Number(st.code || 0)) return fromSite;
  return null;
}

/** Inside the app, once: watch for a newer version and keep the pop-up and the bar up to date. */
export function watchAppUpdate(android) {
  if (!android || bridge) return;
  bridge = android;
  window.__alphiUpdate = onProgress;
  window.addEventListener('alphiapp', refresh);
  if (!canSelfUpdate()) {
    fetch('app/android.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => { if (info && info.versionCode) fromSite = info; })
      .catch(() => {})
      .finally(refresh);
  } else {
    refresh();
  }
}

function refresh() {
  paintBar();
  maybeShowPopup();
}

/** The app reports each step of an update (MainActivity.updateProgress). */
function onProgress(stage, pct = 0) {
  clearTimeout(stall);
  if (stage === 'error') {
    progress = null;
    toast("Sorry, the update didn't download. Check your connection and try again.", 'error');
  } else if (['idle', 'none', 'blocked'].includes(stage)) {
    progress = null;
  } else {
    progress = { stage, pct };
    // If nothing more is heard for a while, show Update again rather than a stuck message.
    if (stage !== 'confirm') stall = setTimeout(() => { progress = null; paintBar(); }, 90000);
  }
  paintBar();
}

function progressText(p) {
  if (p.stage === 'downloading') return `Downloading the update... ${p.pct}%`;
  if (p.stage === 'checking') return 'Checking the download...';
  if (p.stage === 'installing') return 'Installing the update...';
  if (p.stage === 'confirm') return 'Tap Update on the screen that opened to finish.';
  return 'Starting the update...';
}

function startUpdate() {
  closePopup();
  if (!available()) return;
  if (canSelfUpdate()) {
    onProgress('starting');
    try { bridge.startUpdate(); } catch { progress = null; paintBar(); }
  } else {
    // An older app: the phone's browser downloads the new version, which then installs over this one.
    location.href = 'app/alphi-cuts.apk';
    toast('Downloading the new version. When it finishes, open it to install the update.');
  }
}

function openSettings() {
  try { bridge.openInstallSettings(); } catch { /* an older app without this */ }
}

function paintBar() {
  const bar = $('#app-update');
  if (!bar) return;
  const u = available();
  const blocked = canSelfUpdate() ? String(status().installBlocked || '') : '';
  let html = '';
  if (progress) {
    html = `<span class="au-spin" aria-hidden="true"></span> ${esc(progressText(progress))}`;
  } else if (u && blocked) {
    const retryable = blocked === 'security' || blocked === 'storage';
    html = `${esc(BLOCKED_TEXT[blocked] || 'Something on your phone is blocking the update.')}
      <button type="button" class="au-btn" data-au="settings">Open settings</button>
      ${retryable ? '<button type="button" class="au-btn au-btn-plain" data-au="update">Try again</button>' : ''}`;
  } else if (u) {
    html = `Version ${esc(u.versionName)} of the app is ready. This version will no longer be supported.
      <button type="button" class="au-btn" data-au="update">Update</button>`;
  }
  if (bar.dataset.html === html) return;
  bar.dataset.html = html;
  bar.innerHTML = html;
  bar.hidden = !html;
  bar.querySelectorAll('[data-au="update"]').forEach((b) => b.addEventListener('click', startUpdate));
  bar.querySelectorAll('[data-au="settings"]').forEach((b) => b.addEventListener('click', openSettings));
}

function maybeShowPopup() {
  const u = available();
  if (!u || progress || shownFor === Number(u.versionCode)) return;
  const root = $('#modal-root');
  if (!root) return;
  // Never on top of another pop-up: try again a little later.
  if (root.innerHTML.trim()) {
    clearTimeout(retry);
    retry = setTimeout(maybeShowPopup, 10000);
    return;
  }
  shownFor = Number(u.versionCode);
  const mine = plain(status().version);
  root.innerHTML = `
    <div class="modal-backdrop" id="au-backdrop">
      <div class="modal app-update-pop" role="dialog" aria-modal="true" aria-labelledby="au-title">
        <h3 id="au-title">Update the app</h3>
        <p>Version ${esc(u.versionName)} of the AlPhi Cuts app is ready. ${mine ? `Version ${esc(mine)}` : 'The version'} on this
          phone will no longer be supported, so please update to keep getting your booking alarms.</p>
        <button type="button" class="btn btn-gold btn-block" id="au-go">Update now</button>
        <button type="button" class="btn btn-ghost btn-block" id="au-later">Not now</button>
      </div>
    </div>`;
  $('#au-go').addEventListener('click', startUpdate);
  $('#au-later').addEventListener('click', closePopup);
  $('#au-backdrop').addEventListener('click', (e) => { if (e.target.id === 'au-backdrop') closePopup(); });
  $('#au-go').focus();
}

function closePopup() {
  const root = $('#modal-root');
  if (root && root.querySelector('.app-update-pop')) root.innerHTML = '';
}
