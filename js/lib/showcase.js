// The ring of haircut photos that turns slowly in 3D behind every page. It shows the cuts the owner
// uploaded in the owner panel first, then the built-in styles, and leans a little towards the mouse.
// On the home page it is bright behind the top of the page and dims as you scroll down; on the other
// pages it stays dim so the text is easy to read.
import { rpc, publicFileUrl } from './api.js';
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
  paint(stage, ring, pick(builtIn, count));

  rpc('list_haircut_styles')
    .then((rows) => {
      const uploaded = [...new Set((rows || []).filter((r) => r.storage_path).map((r) => publicFileUrl('haircut-styles', r.storage_path)))];
      if (uploaded.length) paint(stage, ring, pick([...uploaded, ...builtIn], count));
    })
    .catch(() => { /* the built-in styles are already turning */ });

  addEventListener('resize', () => size(stage, ring), { passive: true });
  if (!still) leanTowardsMouse(stage);
  if (!quiet) dimOnScroll(stage);
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
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(apply); }, { passive: true });
  apply();
}
