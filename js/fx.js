// The look and feel shared by every page (2.6.0): the ring of haircut photos turning behind the page,
// a soft light that follows the mouse (or glows where a finger taps), cards and buttons that light up
// under the pointer, sections that light up as they come into view, and the self-update that keeps
// an open page on the newest version. Nothing here is needed to use the site; if this script can't
// run, the page works and looks the same apart from the movement.
import { mountShowcase } from './lib/showcase.js';
import { watchForUpdates } from './lib/autoupdate.js';

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mouse = matchMedia('(hover: hover) and (pointer: fine)').matches;
// Phones with very little memory or very few cores get a lighter version: fewer photos, no blur.
const lite = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);

root.classList.add('fx');
if (lite) root.classList.add('fx-lite');

mountShowcase({ count: lite ? 8 : 12, quiet: !document.querySelector('.hero'), still: reduceMotion });
watchForUpdates();

if (!reduceMotion) {
  if (mouse) followTheMouse();
  glowWhereTapped();
  lightUpSections();
}
lightUpUnderPointer();

function make(className) {
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  return el;
}

/** A wide soft light at the mouse, and a small glowing ring that trails it and opens up over things you can press. */
function followTheMouse() {
  const glow = make('cursor-glow');
  const ring = make('cursor-ring');
  let x = innerWidth / 2;
  let y = innerHeight / 3;
  let rx = x;
  let ry = y;
  let raf = 0;
  const step = () => {
    raf = 0;
    rx += (x - rx) * 0.24;
    ry += (y - ry) * 0.24;
    glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
    if (Math.abs(x - rx) > 0.4 || Math.abs(y - ry) > 0.4) raf = requestAnimationFrame(step);
  };
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    x = e.clientX;
    y = e.clientY;
    root.classList.add('fx-pointer');
    const target = e.target && e.target.closest ? e.target.closest('a, button, select, summary, label, input, textarea, .style-card, [role="button"]') : null;
    ring.classList.toggle('over', !!target);
    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });
  document.addEventListener('mouseleave', () => root.classList.remove('fx-pointer'));
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') ring.classList.add('press'); }, { passive: true });
  addEventListener('pointerup', () => ring.classList.remove('press'), { passive: true });
}

/** On a touch screen, a short golden glow where the finger lands. */
function glowWhereTapped() {
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const spot = document.createElement('span');
    spot.className = 'tap-glow';
    spot.setAttribute('aria-hidden', 'true');
    spot.style.left = `${e.clientX}px`;
    spot.style.top = `${e.clientY}px`;
    document.body.appendChild(spot);
    setTimeout(() => spot.remove(), 700);
  }, { passive: true });
}

/** Cards and buttons light up where the pointer is; style photos lean towards it in 3D. */
function lightUpUnderPointer() {
  const LIT = '.card, .style-card, .btn, .ticket, .stat, .slot, .team li';
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return; // the light only shows on hover; a finger would just cost work
    const el = e.target && e.target.closest ? e.target.closest(LIT) : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    if (!reduceMotion && el.classList.contains('style-card')) {
      el.style.setProperty('--rx', `${((0.5 - py) * 16).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${((px - 0.5) * 18).toFixed(2)}deg`);
    }
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.style-card') : null;
    if (el && !el.contains(e.relatedTarget)) {
      el.style.removeProperty('--rx');
      el.style.removeProperty('--ry');
    }
  }, { passive: true });
}

/** Each section fades up and its heading line lights as it scrolls into view. */
function lightUpSections() {
  if (!('IntersectionObserver' in window)) return;
  const items = document.querySelectorAll('main section:not(.hero), .doc-main .doc');
  if (!items.length) return;
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('lit');
        seen.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  items.forEach((el) => { el.classList.add('reveal'); seen.observe(el); });
  // Anything already on screen (or jumped to with a link) lights straight away.
  requestAnimationFrame(() => items.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0) el.classList.add('lit');
  }));
}
