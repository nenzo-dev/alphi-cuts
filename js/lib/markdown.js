// A deliberately tiny formatter for the legal pages, which the owner can edit:
//   # / ## / ### headings, "- " list items, **bold**, blank line = new paragraph.
// Everything is HTML-escaped first, so no tags or links typed into the text can run.
import { esc } from './ui.js';

const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para = [];
  let list = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushList = () => { if (list.length) { html += `<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`; list = []; } };

  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if (!line) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara(); flushList();
      const level = m[1].length;
      html += `<h${level}>${inline(m[2])}</h${level}>`;
    } else if ((m = line.match(/^[-*]\s+(.+)$/))) {
      flushPara();
      list.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html;
}
