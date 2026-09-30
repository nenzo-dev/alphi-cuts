// Shared by the privacy, terms, disclaimer, developers and 404 pages: fills in the shop name and
// announcement, and renders the legal text (the owner's version if they've edited it).
import { CONFIG, VERSION } from './config.js';
import { select } from './lib/api.js';
import { $, $$, installGlobalErrorHandlers } from './lib/ui.js';
import { renderMarkdown } from './lib/markdown.js';
import { fill, contentVars } from './lib/content.js';
import { LEGAL_DOCS } from './legal-content.js';

installGlobalErrorHandlers();

const docKey = document.body.dataset.doc;
const doc = LEGAL_DOCS[docKey];
const fallbackVars = { shop: CONFIG.shortName, owner: 'the owner', owner_first: 'the barber', slot: '30' };

function renderDoc(vars, override) {
  if (!doc) return;
  const text = typeof override === 'string' && override.trim() ? override : doc.text;
  $('#doc').innerHTML = renderMarkdown(fill(text, vars));
}

renderDoc(fallbackVars);
$$('.app-version').forEach((el) => { el.textContent = `v${VERSION}`; });

(async () => {
  try {
    const rows = await select('site_config', 'id=eq.1&select=*');
    const c = rows && rows[0];
    if (!c) return;
    const vars = contentVars({
      ...c,
      closed_weekdays: c.closed_weekdays || [],
      booking_days_ahead: c.booking_days_ahead || 7,
    });
    $$('[data-shop-name]').forEach((el) => { el.textContent = vars.shop; });
    if (doc) document.title = `${doc.title} | ${vars.shop}`;
    const ann = $('#announcement');
    if (ann && c.announcement) {
      ann.textContent = c.announcement;
      ann.hidden = false;
    }
    renderDoc(vars, c.content && c.content.legal && c.content.legal[docKey]);
  } catch {
    /* the default wording is already showing */
  }
})();
