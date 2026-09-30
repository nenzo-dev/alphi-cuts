// Alarm sounds made with the Web Audio API (no audio files to download).
//
// Browsers keep sound blocked until the visitor has tapped the page once, so armAudioUnlock()
// listens for that first tap. Rings are scheduled up to 30 seconds ahead on the audio clock,
// which keeps them going even when a background tab's timers are slowed down.
let ctx = null;
let master = null;
let ringing = false;
let refillTimer = null;
let nextAt = 0;

const RING_PERIOD = 2.6;  // seconds between the start of one ring and the next
const LOOKAHEAD = 30;     // seconds of ringing scheduled in advance

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

// One ring: two quick bursts of alternating tones, like a phone.
function ringOnce(at, out) {
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 6; i++) tone(i % 2 ? 740 : 988, at + burst * 0.9 + i * 0.11, 0.1, out, 0.35);
  }
}

function refill() {
  if (!ringing || !ctx || !master) return;
  const now = ctx.currentTime;
  if (nextAt < now) nextAt = now + 0.05;
  while (nextAt < now + LOOKAHEAD) {
    ringOnce(nextAt, master);
    nextAt += RING_PERIOD;
  }
  refillTimer = setTimeout(refill, 10000);
}

export function startRing() {
  if (ringing) return;
  const c = audio();
  if (!c) return;
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

// A short two-note chime for heads-ups (not a full ring). `force` is for calls made inside a tap,
// where audio is about to unlock; otherwise a locked context skips it, since a queued chime would
// play late.
export function chime({ force = false } = {}) {
  const c = audio();
  if (!c || (!force && c.state !== 'running')) return;
  const t = c.currentTime + 0.05;
  tone(880, t, 0.16, c.destination, 0.3);
  tone(1320, t + 0.2, 0.3, c.destination, 0.3);
  tone(880, t + 0.8, 0.16, c.destination, 0.3);
  tone(1320, t + 1.0, 0.3, c.destination, 0.3);
}
