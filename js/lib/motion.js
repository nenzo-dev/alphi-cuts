// Motion for the pages (2.14.0). Blocks rise into place as their section comes into view, queue numbers count up
// and glow when they change, and a phone that cannot keep up gets the lighter look (class "fx-lite"). Only transform
// and opacity move, every entrance plays once (the class comes off afterwards, so rebuilding a block later does not
// replay it), and nothing here is needed to read a page: the classes are added by this file, so if it fails the
// page is simply shown as it is.
const root = document.documentElement;
const LITE_KEY = 'ac_lite';
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Phones with little memory or few cores start in the lighter look. Other phones are timed for a moment once the
 * page is up, and switch to it (and remember) if they cannot hold about 30 frames a second. Answers true when the
 * page starts light.
 */
export function initMotion() {
  let lite = false;
  try { lite = localStorage.getItem(LITE_KEY) === '1'; } catch { /* storage can be blocked */ }
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) lite = true;
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) lite = true;
  if (lite) { root.classList.add('fx-lite'); return true; }
  if (reduced() || root.classList.contains('fx-soft')) return false;
  let last = 0;
  let frames = 0;
  let slow = 0;
  const tick = (t) => {
    if (document.hidden) return;
    if (last) {
      const dt = t - last;
      if (dt < 250) { frames += 1; if (dt > 34) slow += 1; }
    }
    last = t;
    if (frames < 45) { requestAnimationFrame(tick); return; }
    if (slow > frames * 0.35) {
      root.classList.add('fx-lite');
      try { localStorage.setItem(LITE_KEY, '1'); } catch { /* fine */ }
    }
  };
  setTimeout(() => requestAnimationFrame(tick), 900);
  return false;
}

/** Plays the entrance on one block, once. */
export function enter(el, step = 0) {
  if (!el || reduced() || el.classList.contains('rv')) return;
  el.style.setProperty('--d', String(step));
  el.classList.add('rv');
  setTimeout(() => el.classList.remove('rv'), 2600);
}

/** Runs fn once the block is on the screen (now, if it already is). */
export function whenSeen(el, fn) {
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (!('IntersectionObserver' in window) || (box.top < innerHeight && box.bottom > 0)) { requestAnimationFrame(fn); return; }
  const watch = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    watch.disconnect();
    fn();
  }, { rootMargin: '0px 0px -6% 0px' });
  watch.observe(el);
}

/** The blocks inside a container (slots, tickets, reviews) rise one after another, once, when it is first on the screen. */
export function enterAll(container, selector, { cap = 14 } = {}) {
  if (!container || reduced()) return;
  whenSeen(container, () => [...container.querySelectorAll(selector)].forEach((el, i) => enter(el, Math.min(i, cap))));
}

const BLOCKS = '.section-head, .card, .style-card, .free-banner, .app-card, .team li';
let seenBlocks = null;

/**
 * A section has lit up: each of its blocks (heading, cards, photos) rises into place when it is scrolled to, the
 * ones that arrive together one after another. Blocks that are not on the screen yet wait for their turn.
 */
export function revealSection(section) {
  if (!section || reduced() || !('IntersectionObserver' in window)) return;
  if (!seenBlocks) {
    seenBlocks = new IntersectionObserver((entries) => {
      let n = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        seenBlocks.unobserve(entry.target);
        enter(entry.target, Math.min(n, 8));
        n += 1;
      }
    }, { rootMargin: '0px 0px -8% 0px' });
  }
  for (const el of section.querySelectorAll(BLOCKS)) {
    if (el.dataset.seen || el.closest('.modal')) continue;
    el.dataset.seen = '1';
    seenBlocks.observe(el);
  }
}

/** Counts a number up (from 0, or from `from`) to the figure in data-count, then restores the exact text. */
export function countUp(el, { from = 0, ms = 750, delay = 0 } = {}) {
  const to = Number(el && el.dataset.count);
  if (!el || reduced() || !Number.isFinite(to) || to === from) return;
  const text = el.textContent;
  const prefix = (text.match(/^[^0-9-]*/) || [''])[0];
  const decimals = ((text.split('.')[1] || '').match(/^[0-9]*/) || [''])[0].length;
  let start = 0;
  const step = (t) => {
    if (!start) start = t;
    const p = Math.min(1, Math.max(0, (t - start) / ms));
    const eased = 1 - (1 - p) ** 3;
    el.textContent = p < 1 ? prefix + (from + (to - from) * eased).toFixed(decimals) : text;
    if (p < 1) requestAnimationFrame(step);
  };
  el.textContent = prefix + from.toFixed(decimals);
  setTimeout(() => requestAnimationFrame(step), delay);
}

/** A short glow on something that has just changed: green when it got better, red when it got worse. */
export function flash(el, direction) {
  if (reduced() || !el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // so the glow can start again if it is already showing
  el.classList.add(direction > 0 ? 'flash-up' : 'flash-down');
  setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 1600);
}

/** Sets the contents of a block only when they are different, so nothing is rebuilt (or restarted) for no reason. */
export function setHTML(el, html) {
  if (!el || el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
