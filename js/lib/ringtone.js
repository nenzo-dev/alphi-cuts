// A ringing alert with no audio file at all -- two tones from the Web Audio API, repeating until
// stopped. Used for "you're up next, please be at the shop" on the client's own booking page.
let ctx = null;
let timer = null;
let ringing = false;

function beep(freq, startAt, durationMs, gainPeak) {
  const g = ctx.createGain();
  const o = ctx.createOscillator();
  o.frequency.value = freq;
  o.connect(g);
  g.connect(ctx.destination);
  const t0 = ctx.currentTime + startAt / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
  g.gain.linearRampToValueAtTime(0, t0 + durationMs / 1000);
  o.start(t0);
  o.stop(t0 + durationMs / 1000 + 0.02);
}

export function startRing() {
  if (ringing) return;
  ringing = true;
  try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch { ringing = false; return; }
  const cycle = () => {
    if (!ringing) return;
    beep(600, 0, 260, 0.15);
    beep(760, 320, 260, 0.15);
    timer = setTimeout(cycle, 1400);
  };
  cycle();
}

export function stopRing() {
  ringing = false;
  clearTimeout(timer);
}

export function isRinging() {
  return ringing;
}
