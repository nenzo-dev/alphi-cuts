// A short guide through the booking form for people who are slow or new to phones (2.15.0). Instead of hoping
// someone finds the next box, the form shows a row of steps that fills as each one is done, one line saying what to
// do next, a glow on the box to use and, after a few quiet seconds, a finger that taps it. Once someone has done a
// step twice the finger stops showing for that step (the words and the glow stay).
//
// This file only draws. The page works out which step the person is on and says so with update().
import { storageGet, storageSet, esc } from './ui.js';
import { setHTML } from './motion.js';

const IDLE_MS = 3500;     // quiet time before the finger shows
const LEARNED_AT = 2;     // steps done this many times no longer get the finger
const learnedKey = (stage) => `ac_guided_${stage}`;
const learned = (stage) => Number(storageGet(learnedKey(stage)) || 0);

const FINGER = `<svg viewBox="0 0 32 32" focusable="false"><g fill="#fff" stroke="#1a1405" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">
<rect x="8" y="15" width="18.5" height="14" rx="6.5"/><rect x="5.2" y="17" width="4.8" height="8.5" rx="2.4" transform="rotate(-24 7.6 21)"/>
<rect x="21.3" y="12.5" width="4.4" height="9" rx="2.2"/><rect x="16.7" y="11" width="4.6" height="10" rx="2.3"/>
<rect x="11.3" y="2.5" width="5.4" height="17" rx="2.7"/></g><path d="M12 17h4v3h-4z" fill="#fff"/></svg><i></i>`;
const CHECK = '<svg viewBox="0 0 24 24" focusable="false"><path d="m5.5 12.5 4.2 4.2L18.5 8"/></svg>';

export function createGuide({ rail, hint, form }) {
  let stage = null;
  let target = null;
  let finger = null;
  let timer = 0;
  let lastText = '';

  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hideFinger() {
    if (finger) { finger.remove(); finger = null; }
  }

  function showFinger() {
    if (!target || !stage || learned(stage) >= LEARNED_AT) return;
    if (!finger) {
      finger = document.createElement('span');
      finger.className = 'finger';
      finger.setAttribute('aria-hidden', 'true');
      finger.innerHTML = FINGER;
    }
    target.appendChild(finger);
  }

  // Any touch, tap or key in the form means the person is not stuck: the finger goes and the quiet time starts again.
  function rearm() {
    clearTimeout(timer);
    hideFinger();
    if (target) timer = setTimeout(showFinger, IDLE_MS);
  }
  ['input', 'change', 'click', 'keydown', 'focusin', 'pointerdown'].forEach((name) => form.addEventListener(name, rearm, true));

  function setTarget(el, scroll) {
    if (target) target.classList.remove('guide-now');
    target = el || null;
    if (target) {
      target.classList.add('guide-now');
      if (scroll) {
        const box = target.getBoundingClientRect();
        if (box.top < 80 || box.bottom > innerHeight - 24) target.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      }
    }
    rearm();
  }

  function renderRail(labels, at) {
    const last = Math.max(1, labels.length - 1);
    rail.style.setProperty('--p', String(Math.min(1, Math.max(0, at / last))));
    setHTML(rail, labels.map((label, i) => {
      const state = i < at ? 'done' : i === at ? 'now' : 'todo';
      return `<li class="${state}"><span class="dot">${state === 'done' ? CHECK : i + 1}</span><span class="lbl">${esc(label)}</span></li>`;
    }).join(''));
    rail.hidden = false;
  }

  function renderHint(text) {
    if (!text) { hint.hidden = true; lastText = ''; return; }
    hint.hidden = false;
    if (text === lastText) return;
    lastText = text;
    hint.innerHTML = `<span class="chev" aria-hidden="true"><i></i><i></i><i></i></span><span class="guide-text">${esc(text)}</span>`;
    hint.classList.remove('swap');
    void hint.offsetWidth;   // so the line can slide in again
    hint.classList.add('swap');
  }

  function reset() {
    clearTimeout(timer);
    hideFinger();
    if (target) target.classList.remove('guide-now');
    target = null;
    stage = null;
    lastText = '';
    rail.hidden = true;
    hint.hidden = true;
  }

  /**
   * state: { stage, steps: ['Pay', ...], at: index of the step being done, text, target: element or null }.
   * Pass null to hide the guide (nothing to guide).
   */
  return {
    update(state) {
      if (!state || !state.stage) { reset(); return; }
      renderRail(state.steps, state.at);
      renderHint(state.text);
      if (state.stage !== stage) {
        const before = stage;
        stage = state.stage;
        // Moving on from a step is the person having done it: after twice, the finger leaves that step alone.
        if (before) storageSet(learnedKey(before), String(Math.min(learned(before) + 1, 99)));
        setTarget(state.target, !!before);
      } else if (state.target !== target) {
        setTarget(state.target, false);
      }
    },
  };
}
