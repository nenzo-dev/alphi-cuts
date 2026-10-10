// "Sounds": where people choose their own tones (2.9.0).
//
// In a browser the site makes the sounds itself while it's open, so people pick a tone for "it's your
// turn" and one for heads-ups and messages, or use a sound file of their own (kept on the device).
// With the site closed, notifications use the phone's own sound, which websites can't change, so
// the panel says where to change it. Inside the Android app (1.4.0) each kind of alert (your turn,
// booking updates, messages) has its own list: the phone's usual sound, the same six tones, the
// phone's own sounds or a sound file, all chosen right in the app (AlphiAndroid.setSound).
import { $, esc, toast } from './ui.js';
import {
  SOUND_CHOICES, chosenSound, chooseSound, previewSound, stopPreview, saveCustomSound, removeCustomSound,
  customSoundName, loadCustomSound, unlockAudio,
} from './ringtone.js';

export const SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(navigator.userAgent);
const app = () => window.AlphiAndroid || null;

const APP_CHANNELS = [
  ['alarm', "Your turn", 'Rings when your slot starts or the barber calls you.'],
  ['updates', 'Booking updates', 'The heads-up before your slot and when you are nearly up.'],
  ['messages', 'Messages', 'Replies from the barber.'],
];

function closedNote(place) {
  if (isIOS) return `With ${place} closed, notifications use your iPhone's notification sound. iPhone doesn't let websites change it.`;
  if (isAndroid) return `With ${place} closed, notifications use your phone's sound. To change it, long-press one of our notifications, tap the settings icon, then tap Sound.`;
  return `With ${place} closed, notifications use your computer's notification sound.`;
}

function optionsHtml(kind) {
  const chosen = chosenSound(kind);
  const own = customSoundName();
  return SOUND_CHOICES.map(({ id, name }) => {
    const label = id === 'custom' && !own ? 'My own sound (choose a file)' : name;
    return `<option value="${id}"${id === chosen ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function browserBody({ kinds, labels, place }) {
  const own = customSoundName();
  const rows = kinds.map((kind) => `
    <div class="snd-row">
      <label for="snd-${kind}">${esc(labels[kind])}</label>
      <div class="snd-pick">
        <select id="snd-${kind}" data-kind="${kind}">${optionsHtml(kind)}</select>
        <button type="button" class="btn btn-ghost btn-sm snd-play" data-kind="${kind}" aria-label="Play: ${esc(labels[kind])}" title="Play">${PLAY}</button>
      </div>
    </div>`).join('');
  return `
    <p class="small muted">Choose the sounds this site plays on this device. Tap Play to hear one.</p>
    ${rows}
    <div class="snd-own">
      <p class="snd-own-title">My own sound</p>
      <p class="small muted" id="snd-own-name">${own ? `<b>${esc(own)}</b> is saved on this device.` : 'Use any sound or song clip from your phone.'}</p>
      <div class="snd-own-actions">
        <label class="btn btn-ghost btn-sm snd-file">${own ? 'Choose another file' : 'Choose a sound file'}<input type="file" accept="audio/*" id="snd-file"></label>
        ${own ? '<button type="button" class="link-btn small" id="snd-remove">Remove it</button>' : ''}
      </div>
      <p class="small muted">MP3, M4A or WAV, up to 3 MB. It stays on this device and is never uploaded.</p>
    </div>
    <p class="snd-note small">${esc(closedNote(place))}</p>`;
}

// The app (1.4.0 and later) plays its alerts itself, so it gets the same six tones (bundled in the app),
// the phone's own sounds (Android's picker, opened in the app) and a sound file of the client's own.
const APP_TONES = SOUND_CHOICES.filter((c) => c.id !== 'custom');

function appSounds() {
  try { return JSON.parse(app().sounds()) || {}; } catch { return {}; }
}

function appBody() {
  const a = app();
  if (!a || typeof a.setSound !== 'function') {
    return `
      <p>Update the app to choose its sounds here.</p>
      <p class="snd-note small">Until then: open your phone's Settings, then Apps, AlPhi Cuts, Notifications. Tap <b>Your turn</b> and choose a sound.</p>`;
  }
  const now = appSounds();
  const rows = APP_CHANNELS.map(([kind, name, what]) => {
    const cur = now[kind] || { choice: 'default', label: '' };
    const picked = cur.choice === 'phone' || cur.choice === 'file';
    const options = [
      ...(picked ? [['keep', `${cur.label || 'Chosen sound'} (${cur.choice === 'phone' ? "phone's sound" : 'your file'})`]] : []),
      ['default', "The phone's usual sound"],
      ...APP_TONES.map((t) => [t.id, t.name]),
      ['phone', "Choose from the phone's sounds…"],
      ...(now.ownFile ? [['file', 'My own sound file…']] : []),
    ];
    const selected = picked ? 'keep' : cur.choice;
    return `
      <div class="snd-row">
        <label for="snd-app-${kind}">${esc(name)}</label>
        <p class="small muted snd-what">${esc(what)}</p>
        <div class="snd-pick">
          <select id="snd-app-${kind}" data-app-kind="${kind}">${options.map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <button type="button" class="btn btn-ghost btn-sm snd-play" data-app-play="${kind}" aria-label="Play: ${esc(name)}" title="Play">${PLAY}</button>
        </div>
      </div>`;
  }).join('');
  return `
    <p class="small muted">Choose the sound for each kind of alert. Tap Play to hear it.</p>
    ${rows}
    <p class="snd-note small">The phone's sounds and your own file open right here in the app. Vibration and the rest: <button type="button" class="link-btn small" data-channel="alarm">more sound settings</button>.</p>`;
}

/**
 * Opens the Sounds panel. `kinds` are 'ring' and/or 'alert', `labels` what each is for, and `place`
 * how to refer to the site when it's closed ("this site", "this panel").
 */
export async function openSounds({
  kinds = ['ring', 'alert'],
  labels = { ring: "When it's your turn", alert: 'Heads-ups and messages' },
  place = 'this site',
} = {}) {
  const root = $('#modal-root');
  if (!root) return;
  await loadCustomSound();
  const inApp = !!app();
  const last = document.activeElement;
  let pendingKinds = null; // set when "My own sound" was picked before a file was chosen

  const render = () => {
    root.innerHTML = `
      <div class="modal-backdrop" id="snd-backdrop">
        <div class="modal notify-panel sounds-panel" role="dialog" aria-modal="true" aria-labelledby="snd-title">
          <button type="button" class="modal-close" id="snd-close" aria-label="Close">&times;</button>
          <div class="np-head"><span class="np-bell">${SPEAKER}</span><h3 id="snd-title">Sounds</h3></div>
          ${inApp ? appBody() : browserBody({ kinds, labels, place })}
          <button type="button" class="btn btn-gold btn-block" id="snd-done">Done</button>
        </div>
      </div>`;
    wire();
  };

  // The app says when a sound changed (after its picker, or with a problem to show).
  const onAppSounds = (e) => {
    if (!root.querySelector('.sounds-panel')) return;
    const problem = e && e.detail;
    render();
    toast(problem || 'Your sound is set.', problem ? 'error' : 'ok');
  };
  const close = () => {
    stopPreview();
    try { if (app() && app().stopSound) app().stopSound(); } catch { /* older app */ }
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('alphisounds', onAppSounds);
    if (last && last.focus) last.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const useOwn = async (file) => {
    try {
      const name = await saveCustomSound(file);
      const targets = pendingKinds || kinds;
      targets.forEach((k) => chooseSound(k, 'custom'));
      render();
      toast(targets.length > 1 ? `"${name}" is now your sound. You can change either one above.` : `"${name}" is now your sound.`);
    } catch (err) {
      toast(err && err.message ? err.message : "That file can't be used.", 'error');
    } finally {
      pendingKinds = null;
    }
  };

  function wire() {
    $('#snd-close').addEventListener('click', close);
    $('#snd-done').addEventListener('click', close);
    $('#snd-backdrop').addEventListener('click', (e) => { if (e.target.id === 'snd-backdrop') close(); });

    root.querySelectorAll('select[data-kind]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const kind = sel.dataset.kind;
        if (sel.value === 'custom' && !customSoundName()) {
          sel.value = chosenSound(kind);
          pendingKinds = [kind];
          $('#snd-file').click();
          return;
        }
        chooseSound(kind, sel.value);
        unlockAudio();
        previewSound(sel.value, kind);
      });
    });
    root.querySelectorAll('.snd-play[data-kind]').forEach((btn) => { // the website's own sounds (not the app's)
      btn.addEventListener('click', () => {
        unlockAudio();
        const kind = btn.dataset.kind;
        previewSound($(`#snd-${kind}`).value, kind);
      });
    });
    const file = $('#snd-file');
    if (file) file.addEventListener('change', () => { if (file.files[0]) useOwn(file.files[0]); file.value = ''; });
    const remove = $('#snd-remove');
    if (remove) {
      remove.addEventListener('click', async () => {
        await removeCustomSound();
        render();
        toast('Your own sound is removed. The usual sounds play again.');
      });
    }
    root.querySelectorAll('select[data-app-kind]').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (sel.value === 'keep') return;
        try { app().setSound(sel.dataset.appKind, sel.value); } catch { toast("Couldn't change the sound.", 'error'); }
      });
    });
    root.querySelectorAll('[data-app-play]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try { app().playSound(btn.dataset.appPlay); } catch { /* older app */ }
      });
    });
    root.querySelectorAll('[data-channel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try { app().openSoundSettings(btn.dataset.channel); } catch { toast("Couldn't open the phone's settings.", 'error'); }
      });
    });
    const first = root.querySelector('select, [data-channel], #snd-done');
    if (first) first.focus();
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('alphisounds', onAppSounds);
  render();
}
