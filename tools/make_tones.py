"""Renders the website's six tones (js/lib/ringtone.js) to WAV files for the Android app.

    python tools/make_tones.py

The website makes its sounds live with the Web Audio API; the app's notifications need sound files,
so this plays the same notes, with the same envelopes, into android/app/src/main/res/raw/:

    tone_<id>_ring.wav   one round of the "your turn" ring, made to loop seamlessly (the alarm repeats it)
    tone_<id>_short.wav  the heads-up and message sound

Run it again after changing a tone in ringtone.js so the app and the site keep sounding the same.
"""
import os
import wave

import numpy as np

RATE = 22050
OUT = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res', 'raw')


def osc(kind, freq, t):
    """Band-limited oscillators, like Web Audio's (no harmonics above half the sample rate)."""
    if kind == 'sine':
        return np.sin(2 * np.pi * freq * t)
    out = np.zeros_like(t)
    n = 1
    while n * freq < RATE / 2:
        if kind == 'square':
            out += np.sin(2 * np.pi * n * freq * t) / n
        elif kind == 'triangle':
            out += ((-1) ** ((n - 1) // 2)) * np.sin(2 * np.pi * n * freq * t) / (n * n)
        n += 2
    return out * (4 / np.pi if kind == 'square' else 8 / np.pi ** 2)


class Track:
    def __init__(self, seconds):
        self.buf = np.zeros(int(seconds * RATE) + 1)

    def _add(self, at, wave_, env):
        i = int(at * RATE)
        n = min(len(wave_), len(self.buf) - i)
        if n > 0:
            self.buf[i:i + n] += wave_[:n] * env[:n]

    def tone(self, freq, at, dur, peak):
        """ringtone.js tone(): triangle, 15 ms rise, flat, 30 ms fall."""
        t = np.arange(int((dur + 0.02) * RATE)) / RATE
        env = np.interp(t, [0, 0.015, dur - 0.03, dur, dur + 0.02], [0, peak, peak, 0, 0])
        self._add(at, osc('triangle', freq, t), env)

    def pluck(self, freq, at, dur, peak, kind='sine', attack=0.006):
        """ringtone.js pluck(): exponential rise from silence, then an exponential fade."""
        t = np.arange(int((dur + 0.05) * RATE)) / RATE
        lo = 0.0001
        rise = lo * (peak / lo) ** np.clip(t / attack, 0, 1)
        fall = peak * (lo / peak) ** np.clip((t - attack) / (dur - attack), 0, 1)
        env = np.where(t < attack, rise, fall)
        env[t > dur] = 0
        self._add(at, osc(kind, freq, t), env)


def bell_strike(tr, base, at, peak=0.3):
    for mult, level, dur in [(1, 1, 2.4), (2, 0.4, 1.6), (2.76, 0.25, 1.1), (5.4, 0.12, 0.5)]:
        tr.pluck(base * mult, at, dur, peak * level, attack=0.004)


def marimba_note(tr, freq, at, peak=0.34):
    tr.pluck(freq, at, 0.42, peak)
    tr.pluck(freq * 4, at, 0.08, peak * 0.18)


# The same sounds as SOUNDS in js/lib/ringtone.js: (period, ring(track, at), short(track, at)).
def phone_ring(tr, at):
    for burst in range(2):
        for i in range(6):
            tr.tone(740 if i % 2 else 988, at + burst * 0.9 + i * 0.11, 0.1, 0.35)


def phone_short(tr, at):
    for i in range(6):
        tr.tone(740 if i % 2 else 988, at + i * 0.11, 0.1, 0.3)


def chime_short(tr, at):
    tr.tone(880, at, 0.16, 0.3)
    tr.tone(1320, at + 0.2, 0.3, 0.3)
    tr.tone(880, at + 0.8, 0.16, 0.3)
    tr.tone(1320, at + 1.0, 0.3, 0.3)


def bell_ring(tr, at):
    bell_strike(tr, 784, at)
    bell_strike(tr, 784, at + 1.2)


def bell_short(tr, at):
    bell_strike(tr, 1046.5, at, 0.26)
    bell_strike(tr, 784, at + 0.45, 0.26)


def clock_ring(tr, at):
    for i in range(4):
        tr.pluck(1760, at + i * 0.14, 0.09, 0.13, 'square', 0.003)


def clock_short(tr, at):
    for i in range(3):
        tr.pluck(1760, at + i * 0.14, 0.09, 0.11, 'square', 0.003)


def marimba_ring(tr, at):
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5, 783.99, 659.25]):
        marimba_note(tr, f, at + i * 0.13)


def marimba_short(tr, at):
    for i, f in enumerate([523.25, 659.25, 783.99, 1046.5]):
        marimba_note(tr, f, at + i * 0.12)


def soft_ring(tr, at):
    for i, f in enumerate([440, 554.37, 659.25, 880]):
        tr.pluck(f, at + i * 0.32, 1.1, 0.24, attack=0.07)


def soft_short(tr, at):
    for i, f in enumerate([554.37, 659.25, 880]):
        tr.pluck(f, at + i * 0.22, 0.9, 0.22, attack=0.05)


SOUNDS = {
    'phone': (2.6, phone_ring, phone_short),
    'chime': (2.6, chime_short, chime_short),
    'bell': (2.8, bell_ring, bell_short),
    'clock': (1.2, clock_ring, clock_short),
    'marimba': (2.2, marimba_ring, marimba_short),
    'soft': (3.2, soft_ring, soft_short),
}


def write(name, samples):
    peak = np.max(np.abs(samples)) or 1
    pcm = np.int16(np.clip(samples / peak * 0.89, -1, 1) * 32767)
    path = os.path.join(OUT, name)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return path, len(pcm) / RATE


def trim(samples, floor=0.002):
    loud = np.nonzero(np.abs(samples) > floor * np.max(np.abs(samples)))[0]
    end = (loud[-1] if len(loud) else len(samples)) + int(0.05 * RATE)
    return samples[:end]


def main():
    os.makedirs(OUT, exist_ok=True)
    for sid, (period, ring, short) in SOUNDS.items():
        # The ring: play three rounds and keep the middle one, so the tail of each round is already
        # under the start of the next and the file loops without a click or a gap.
        tr = Track(period * 3 + 3)
        for k in range(3):
            ring(tr, k * period)
        a, b = int(period * RATE), int(period * 2 * RATE)
        print(*write(f'tone_{sid}_ring.wav', tr.buf[a:b]))
        tr = Track(4)
        short(tr, 0.02)
        print(*write(f'tone_{sid}_short.wav', trim(tr.buf)))


if __name__ == '__main__':
    main()
