// Alarm sounds made with the Web Audio API (no audio files to download), or the visitor's own sound.
//
// There are two kinds: the ring for "it's your turn" (repeats until stopped) and the short sound for
// heads-ups and messages. Each visitor picks theirs (Sounds, js/lib/soundui.js); the choice is kept
// on this device, and so is their own sound file (IndexedDB), which is never uploaded.
//
// Browsers keep sound blocked until the visitor has tapped the page once, so armAudioUnlock()
// listens for that first tap. Rings are scheduled up to 30 seconds ahead on the audio clock,
// which keeps them going even when a background tab's timers are slowed down.
import { storageGet, storageSet } from './ui.js';

let ctx = null;
let master = null;
let ringing = false;
let refillTimer = null;
let nextAt = 0;
let previewOut = null;

const LOOKAHEAD = 30;           // seconds of ringing scheduled in advance
const CUSTOM_MAX_SECONDS = 15;  // the longest stretch of someone's own sound played in one go
export const CUSTOM_MAX_BYTES = 3 * 1024 * 1024;

const PREF = { ring: 'ac_tone_ring', alert: 'ac_tone_alert' };
const DEFAULT = { ring: 'phone', alert: 'chime' };

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() {
  const c = audio();
  if (!c) return;
  try {
    // A silent sound played from inside a tap is what unlocks audio on iPhone.
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch { /* ignore */ }
}

export function audioUnlocked() {
  return !!ctx && ctx.state === 'running';
}

export function armAudioUnlock() {
  const events = ['pointerdown', 'keydown', 'touchend'];
  const handler = () => {
    unlockAudio();
    if (audioUnlocked()) events.forEach((e) => window.removeEventListener(e, handler, true));
  };
  events.forEach((e) => window.addEventListener(e, handler, true));
}

// ---------------------------------------------------------------- building blocks
// A note with a flat top (the classic ring and chime).
function tone(freq, at, dur, out, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(out);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.015);
  gain.gain.setValueAtTime(peak, at + dur - 0.03);
  gain.gain.linearRampToValueAtTime(0, at + dur);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

// A struck note that fades away (bell, marimba, soft rise, alarm clock beeps).
function pluck(freq, at, dur, out, peak, { type = 'sine', attack = 0.006 } = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(out);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function bellStrike(base, at, out, peak = 0.3) {
  [[1, 1, 2.4], [2, 0.4, 1.6], [2.76, 0.25, 1.1], [5.4, 0.12, 0.5]].forEach(([mult, level, dur]) => {
    pluck(base * mult, at, dur, out, peak * level, { attack: 0.004 });
  });
}

function marimbaNote(freq, at, out, peak = 0.34) {
  pluck(freq, at, 0.42, out, peak);
  pluck(freq * 4, at, 0.08, out, peak * 0.18);
}

// ---------------------------------------------------------------- the sounds
// ring(at, out) plays one round of the ring, `period` seconds long; short(at, out) is the heads-up.
const SOUNDS = {
  phone: {
    name: 'Phone ring',
    period: 2.6,
    ring(at, out) {
      for (let burst = 0; burst < 2; burst++) {
        for (let i = 0; i < 6; i++) tone(i % 2 ? 740 : 988, at + burst * 0.9 + i * 0.11, 0.1, out, 0.35);
      }
    },
    short(at, out) {
      for (let i = 0; i < 6; i++) tone(i % 2 ? 740 : 988, at + i * 0.11, 0.1, out, 0.3);
    },
  },
  chime: {
    name: 'Two-note chime',
    period: 2.6,
    ring(at, out) { SOUNDS.chime.short(at, out); },
    short(at, out) {
      tone(880, at, 0.16, out, 0.3);
      tone(1320, at + 0.2, 0.3, out, 0.3);
      tone(880, at + 0.8, 0.16, out, 0.3);
      tone(1320, at + 1.0, 0.3, out, 0.3);
    },
  },
  bell: {
    name: 'Bell',
    period: 2.8,
    ring(at, out) { bellStrike(784, at, out); bellStrike(784, at + 1.2, out); },
    short(at, out) { bellStrike(1046.5, at, out, 0.26); bellStrike(784, at + 0.45, out, 0.26); },
  },
  clock: {
    name: 'Alarm clock',
    period: 1.2,
    ring(at, out) {
      for (let i = 0; i < 4; i++) pluck(1760, at + i * 0.14, 0.09, out, 0.13, { type: 'square', attack: 0.003 });
    },
    short(at, out) {
      for (let i = 0; i < 3; i++) pluck(1760, at + i * 0.14, 0.09, out, 0.11, { type: 'square', attack: 0.003 });
    },
  },
  marimba: {
    name: 'Marimba',
    period: 2.2,
    ring(at, out) {
      [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25].forEach((f, i) => marimbaNote(f, at + i * 0.13, out));
    },
    short(at, out) {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => marimbaNote(f, at + i * 0.12, out));
    },
  },
  soft: {
    name: 'Soft rise',
    period: 3.2,
    ring(at, out) {
      [440, 554.37, 659.25, 880].forEach((f, i) => pluck(f, at + i * 0.32, 1.1, out, 0.24, { attack: 0.07 }));
    },
    short(at, out) {
      [554.37, 659.25, 880].forEach((f, i) => pluck(f, at + i * 0.22, 0.9, out, 0.22, { attack: 0.05 }));
    },
  },
  custom: {
    name: 'My own sound',
    get period() { return customBuffer ? Math.min(customBuffer.duration, CUSTOM_MAX_SECONDS) + 0.8 : 2.6; },
    ring(at, out) { playCustom(at, out, CUSTOM_MAX_SECONDS); },
    short(at, out) { playCustom(at, out, 4); },
  },
};

/** The sounds to choose from, in order: [{ id, name }]. */
export const SOUND_CHOICES = ['phone', 'chime', 'bell', 'clock', 'marimba', 'soft', 'custom'].map((id) => ({ id, name: SOUNDS[id].name }));

/** The chosen sound for 'ring' or 'alert'. Their own sound only counts once it has loaded. */
export function chosenSound(kind) {
  const id = storageGet(PREF[kind]);
  if (id === 'custom') return customName ? 'custom' : DEFAULT[kind];
  return SOUNDS[id] && id !== 'custom' ? id : DEFAULT[kind];
}

export function chooseSound(kind, id) {
  if (!SOUNDS[id]) return;
  storageSet(PREF[kind], id);
}

function current(kind) {
  const id = chosenSound(kind);
  return id === 'custom' && !customBuffer ? SOUNDS[DEFAULT[kind]] : SOUNDS[id];
}

// ---------------------------------------------------------------- their own sound
let customBuffer = null;   // decoded, ready to play
let customName = '';       // the file's name, once one is saved
let customData = null;     // the file itself, until it can be decoded
const DB = 'ac-sounds';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no storage')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDo(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Decoding uses an offline context where there is one, so loading a saved sound at start-up doesn't
// make a live audio context before the visitor has tapped the page.
function decoder() {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Offline) {
    try { return new Offline(1, 1, 44100); } catch { /* fall through */ }
  }
  return audio();
}

function decode(data) {
  const c = decoder();
  if (!c) return Promise.reject(new Error('no audio'));
  // Older Safari only has the callback form.
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(data.slice(0), resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/** Loads their saved sound, if they have one. Called once at start-up; quiet if anything fails. */
export async function loadCustomSound() {
  try {
    const saved = await dbDo('readonly', (store) => store.get('custom'));
    if (!saved || !saved.data) return;
    customName = saved.name || 'My sound';
    customData = saved.data;
    customBuffer = await decode(saved.data);
  } catch {
    /* plays the default instead */
  }
}

/**
 * Checks and saves a sound file chosen by the visitor. Throws an Error with a message for people
 * when the file is too big or can't be played.
 */
export async function saveCustomSound(file) {
  if (!file) throw new Error('Choose a sound file first.');
  if (file.size > CUSTOM_MAX_BYTES) throw new Error('That file is too big. Choose one under 3 MB.');
  const data = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await decode(data);
  } catch {
    throw new Error("That file can't be played here. Try an MP3, M4A or WAV file.");
  }
  if (!buffer || buffer.duration < 0.2) throw new Error('That sound is too short. Choose a longer one.');
  const name = String(file.name || 'My sound').slice(0, 80);
  try {
    await dbDo('readwrite', (store) => store.put({ name, data, savedAt: Date.now() }, 'custom'));
  } catch {
    throw new Error("This browser won't let the site keep a sound file. Try another browser.");
  }
  customBuffer = buffer;
  customName = name;
  customData = data;
  return name;
}

export async function removeCustomSound() {
  try { await dbDo('readwrite', (store) => store.delete('custom')); } catch { /* nothing saved */ }
  customBuffer = null;
  customName = '';
  customData = null;
}

export const customSoundName = () => customName;

function playCustom(at, out, maxSeconds) {
  if (!customBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = customBuffer;
  src.connect(out);
  src.start(at, 0, Math.min(customBuffer.duration, maxSeconds));
}

// A context made before the first tap may not have decoded their file yet.
async function readyCustom() {
  if (customBuffer || !customData) return;
  try { customBuffer = await decode(customData); } catch { /* the default plays */ }
}

// ---------------------------------------------------------------- playing
function refill() {
  if (!ringing || !ctx || !master) return;
  const sound = current('ring');
  const now = ctx.currentTime;
  if (nextAt < now) nextAt = now + 0.05;
  while (nextAt < now + LOOKAHEAD) {
    sound.ring(nextAt, master);
    nextAt += sound.period;
  }
  refillTimer = setTimeout(refill, 10000);
}

export function startRing() {
  if (ringing) return;
  const c = audio();
  if (!c) return;
  stopPreview();
  ringing = true;
  master = c.createGain();
  master.connect(c.destination);
  nextAt = 0;
  refill();
}

export function stopRing() {
  ringing = false;
  clearTimeout(refillTimer);
  if (master) {
    try { master.disconnect(); } catch { /* already gone */ }
    master = null;
  }
}

export function isRinging() {
  return ringing;
}

// The short sound for heads-ups (not a full ring). `force` is for calls made inside a tap, where
// audio is about to unlock; otherwise a locked context skips it, since a queued sound would play late.
export function chime({ force = false } = {}) {
  const c = audio();
  if (!c || (!force && c.state !== 'running')) return;
  current('alert').short(c.currentTime + 0.05, c.destination);
}

/** Plays a sound once so people can hear it before choosing it: one ring, or the short sound. */
export async function previewSound(id, kind) {
  const c = audio();
  if (!c || !SOUNDS[id]) return;
  if (id === 'custom') await readyCustom();
  stopPreview();
  previewOut = c.createGain();
  previewOut.connect(c.destination);
  const at = c.currentTime + 0.05;
  if (kind === 'ring') {
    SOUNDS[id].ring(at, previewOut);
    if (SOUNDS[id].period < 2) SOUNDS[id].ring(at + SOUNDS[id].period, previewOut);
  } else {
    SOUNDS[id].short(at, previewOut);
  }
}

export function stopPreview() {
  if (!previewOut) return;
  try { previewOut.disconnect(); } catch { /* already gone */ }
  previewOut = null;
}
