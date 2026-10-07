// The ring of haircut photos that turns slowly in 3D behind every page. It shows the cuts the owner
// uploaded in the owner panel first, then the built-in styles, and leans a little towards the mouse.
// On the home page it is bright behind the top of the page and dims as you scroll down; on the other
// pages it stays dim so the text is easy to read.
import { rpcShared, publicFileUrl } from './api.js';
import { storageGet, storageSet } from './ui.js';
import { HAIRCUT_STYLES, styleThumb } from '../styles-data.js';

const SITE = new URL('../../', import.meta.url);

/** Builds the ring once, behind everything else on the page. */
export function mountShowcase({ count = 12, quiet = false, still = false } = {}) {
  if (document.getElementById('cuts-3d')) return;
  const stage = document.createElement('div');
  stage.id = 'cuts-3d';
  stage.className = `cuts-3d${quiet ? ' cuts-quiet' : ''}`;
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = '<div class="orb orb-a"></div><div class="orb orb-b"></div><div class="cuts-tilt"><div class="cuts-ring"></div></div>';
  document.body.prepend(stage);

  const ring = stage.querySelector('.cuts-ring');
  const builtIn = HAIRCUT_STYLES.map((s) => new URL(styleThumb(s), SITE).href);
  // The uploaded cuts from the last visit go up straight away; the ring is only redrawn if they changed.
  const saved = savedPhotos();
  let shown = pick([...saved, ...builtIn], count);
  paint(stage, ring, shown);

  rpcShared('list_haircut_styles')
    .then((rows) => {
      const uploaded = [...new Set((rows || []).filter((r) => r.storage_path).map((r) => publicFileUrl('haircut-styles', r.storage_path)))];
      storageSet(PHOTOS_KEY, JSON.stringify(uploaded.slice(0, 24)));
      const next = pick([...uploaded, ...builtIn], count);
      if (next.join() !== shown.join()) { shown = next; paint(stage, ring, shown); }
    })
    .catch(() => { /* the ring is already turning */ });

  addEventListener('resize', () => size(stage, ring), { passive: true });
  if (!still) leanTowardsMouse(stage);
  if (!quiet) dimOnScroll(stage);
  restWhileScrolling();
}

const PHOTOS_KEY = 'ac_ring_photos';

function savedPhotos() {
  try {
    const list = JSON.parse(storageGet(PHOTOS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && /^https:\/\//.test(u)) : [];
  } catch {
    return [];
  }
}

/** The first `count` photos, repeated if there aren't enough to go round. */
function pick(photos, count) {
  const list = [];
  for (let i = 0; photos.length && list.length < count; i += 1) list.push(photos[i % photos.length]);
  return list;
}

function paint(stage, ring, photos) {
  ring.style.setProperty('--n', photos.length);
  ring.innerHTML = photos.map((src, i) => `
    <figure class="cut" style="--i:${i}"><img src="${src.replace(/"/g, '&quot;')}" alt="" decoding="async" draggable="false"></figure>`).join('');
  size(stage, ring);
}

/** Spaces the photos evenly round the ring, whatever their size on this screen. */
function size(stage, ring) {
  const n = ring.children.length;
  const card = ring.firstElementChild;
  if (!n || !card) return;
  const w = card.offsetWidth || 120;
  stage.style.setProperty('--r', `${Math.round((w / 2 / Math.tan(Math.PI / n)) * 1.18)}px`);
}

function leanTowardsMouse(stage) {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  let x = 0;
  let y = 0;
  let raf = 0;
  addEventListener('pointermove', (e) => {
    x = e.clientX / innerWidth - 0.5;
    y = e.clientY / innerHeight - 0.5;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        stage.style.setProperty('--tx', `${(x * 18).toFixed(2)}deg`);
        stage.style.setProperty('--ty', `${(y * -10).toFixed(2)}deg`);
      });
    }
  }, { passive: true });
}

function dimOnScroll(stage) {
  let raf = 0;
  const apply = () => {
    raf = 0;
    const gone = Math.min(scrollY / (innerHeight * 1.1), 1);
    stage.style.setProperty('--cuts-o', (1 - gone * 0.75).toFixed(3));
    // Past the top of the page the ring is only a dim backdrop, so it rests there (css: fx-past-hero).
    document.documentElement.classList.toggle('fx-past-hero', gone > 0.85);
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
  apply();
}

/** The ring rests while the page is scrolling, which keeps scrolling smooth on phones (css: fx-scrolling). */
function restWhileScrolling() {
  const root = document.documentElement;
  let timer = 0;
  addEventListener('scroll', () => {
    if (!timer) root.classList.add('fx-scrolling');
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; root.classList.remove('fx-scrolling'); }, 220);
  }, { passive: true });
}
