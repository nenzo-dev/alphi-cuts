// Reading a payment screenshot on the client's own phone (nothing is sent anywhere to be read):
//   1. readFileInfo()  the file itself: name, size, type, size in pixels, when it was saved, a
//                      fingerprint (SHA-256) and what the picture's own metadata says (EXIF / PNG
//                      text / XMP: the camera, the editing app, the time it was taken).
//   2. readText()      OCR with Tesseract (vendor/tesseract, loaded only when a screenshot is picked).
//   3. parseProofText() who was paid, how much, the transaction ID, the date, the status.
//   4. judgeProof()    only two things can turn a screenshot down: it isn't a picture, or it
//                      doesn't show the price paid. Everything else (name, account, transaction
//                      ID, timing, editing marks...) is read and kept as a note for Mr Alfred, not
//                      a reason to reject, because those checks were turning down real payments.
// An accepted screenshot only books the slot. Mr Alfred still looks at it and confirms the money
// himself when the client shows up at the shop.

const OCR_BASE = new URL('../../vendor/tesseract/', import.meta.url).href;

export const MAX_BYTES = 8 * 1024 * 1024;
const MIN_BYTES = 20 * 1024;
const MIN_CONFIDENCE = 65;       // how sure the reader has to be of the writing
const MAX_AGE_MIN = 60;            // the screenshot, and the payment on it, are at most an hour old
const FUTURE_SLACK_MIN = 5;        // phone clocks differ a little

// Editing apps. A payment screenshot is made by the phone itself, not by one of these.
const EDITORS = /photoshop|adobe|canva|picsart|snapseed|pixlr|gimp|lightroom|figma|paint\.net|fotor|photoroom|meitu|beautyplus|facetune|inshot|picmonkey|affinity|sketch|krita|capcut|remini|ibis ?paint|polarr|vsco|photopea|lunapic/i;

// ---------------------------------------------------------------- small helpers
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function sniff(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'jpeg';
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) return 'webp';
  return '';
}

const text8 = (u8) => new TextDecoder('utf-8', { fatal: false }).decode(u8);
const trimNul = (s) => s.replace(/\0+$/g, '').trim();

// ---------------------------------------------------------------- picture metadata
// EXIF is a small TIFF file inside the picture. Only the few tags that matter here are read.
function parseTiff(buf, start, length) {
  const out = {};
  try {
    const v = new DataView(buf, start, length);
    const little = v.getUint16(0) === 0x4949;
    const u16 = (o) => v.getUint16(o, little);
    const u32 = (o) => v.getUint32(o, little);
    const ascii = (o, n) => {
      const at = n > 4 ? u32(o + 8) : o + 8;
      return trimNul(text8(new Uint8Array(buf, start + at, Math.min(n, 200))));
    };
    const readIfd = (offset, handler) => {
      if (!offset || offset + 2 > length) return;
      const count = Math.min(u16(offset), 200);
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        if (e + 12 > length) break;
        handler(u16(e), u16(e + 2), u32(e + 4), e);
      }
    };
    let exifPtr = 0;
    readIfd(u32(4), (tag, type, n, e) => {
      if (tag === 0x010f && type === 2) out.make = ascii(e, n);
      else if (tag === 0x0110 && type === 2) out.model = ascii(e, n);
      else if (tag === 0x0131 && type === 2) out.software = ascii(e, n);
      else if (tag === 0x0132 && type === 2) out.dateTime = ascii(e, n);
      else if (tag === 0x8769) exifPtr = u32(e + 8);
    });
    readIfd(exifPtr, (tag, type, n, e) => {
      if (tag === 0x9003 && type === 2) out.taken = ascii(e, n);
      else if (tag === 0x829a) out.exposure = true;   // a camera setting
      else if (tag === 0x829d) out.aperture = true;
      else if (tag === 0x8827) out.iso = true;
      else if (tag === 0xa430 && type === 2) out.owner = ascii(e, n);
    });
  } catch { /* a damaged EXIF block is ignored */ }
  return out;
}

function xmpTool(str) {
  const m = /CreatorTool\s*=\s*"([^"]{1,120})"/i.exec(str) || /<xmp:CreatorTool>([^<]{1,120})</i.exec(str) || /<tiff:Software>([^<]{1,120})</i.exec(str);
  return m ? m[1].trim() : '';
}

function parseJpeg(buf) {
  const u8 = new Uint8Array(buf);
  const out = {};
  let p = 2;
  while (p + 4 < u8.length) {
    if (u8[p] !== 0xff) break;
    const marker = u8[p + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const len = (u8[p + 2] << 8) | u8[p + 3];
    const body = p + 4;
    if (marker === 0xe1) {
      const head = text8(u8.subarray(body, body + 30));
      if (head.startsWith('Exif\0\0')) Object.assign(out, parseTiff(buf, body + 6, len - 8));
      else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) out.xmp = xmpTool(text8(u8.subarray(body, body + Math.min(len - 2, 60000))));
    } else if (marker === 0xed && text8(u8.subarray(body, body + 14)).startsWith('Photoshop 3.0')) {
      out.photoshop = true;
    }
    p += 2 + len;
  }
  return out;
}

function parsePng(buf) {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  const out = {};
  let p = 8;
  while (p + 12 <= u8.length) {
    const len = v.getUint32(p);
    const type = text8(u8.subarray(p + 4, p + 8));
    const body = p + 8;
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tEXt' || type === 'iTXt') {
      const s = text8(u8.subarray(body, body + Math.min(len, 60000)));
      const key = s.split('\0')[0];
      const value = trimNul(s.slice(key.length + 1).replace(/^[\0\s]*/, '')).slice(0, 300);
      if (/^software$/i.test(key)) out.software = value;
      else if (/^creation time$/i.test(key)) out.taken = value;
      else if (/^XML:com\.adobe\.xmp$/i.test(key)) out.xmp = xmpTool(s);
      else if (/^(author|source|comment)$/i.test(key) && EDITORS.test(value)) out.software = out.software || value;
    } else if (type === 'eXIf') {
      Object.assign(out, parseTiff(buf, body, len));
    }
    p += 12 + len;
  }
  return out;
}

function parseWebp(buf) {
  const u8 = new Uint8Array(buf);
  const v = new DataView(buf);
  const out = {};
  let p = 12;
  while (p + 8 <= u8.length) {
    const type = text8(u8.subarray(p, p + 4));
    const len = v.getUint32(p + 4, true);
    if (type === 'EXIF') {
      const at = text8(u8.subarray(p + 8, p + 14)).startsWith('Exif') ? p + 14 : p + 8;
      Object.assign(out, parseTiff(buf, at, len));
    } else if (type === 'XMP ') {
      out.xmp = xmpTool(text8(u8.subarray(p + 8, p + 8 + Math.min(len, 60000))));
    }
    p += 8 + len + (len % 2);
  }
  return out;
}

async function imageSize(file) {
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    if (bmp.close) bmp.close();
    return size;
  } catch {
    return await new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
}

/** Everything the file itself says: name, size, type, pixels, when it was saved, fingerprint, metadata. */
export async function readFileInfo(file) {
  const info = {
    name: String(file.name || '').slice(0, 120),
    size: file.size,
    type: file.type || '',
    kind: '',
    modified: file.lastModified ? new Date(file.lastModified).toISOString() : '',
    width: 0,
    height: 0,
    sha256: '',
    meta: {},
  };
  const buf = await file.arrayBuffer();
  info.sha256 = hex(await crypto.subtle.digest('SHA-256', buf));
  info.kind = sniff(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
  try {
    if (info.kind === 'jpeg') info.meta = parseJpeg(buf);
    else if (info.kind === 'png') info.meta = parsePng(buf);
    else if (info.kind === 'webp') info.meta = parseWebp(buf);
  } catch { info.meta = {}; }
  Object.assign(info, await imageSize(file));
  return info;
}

// ---------------------------------------------------------------- OCR
let tessLoad = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tessLoad) {
    tessLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${OCR_BASE}tesseract.min.js`;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('ocr missing')));
      s.onerror = () => { tessLoad = null; reject(new Error('ocr script')); };
      document.head.appendChild(s);
    });
  }
  return tessLoad;
}

function supportsSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

// Light-on-dark screenshots read badly, so they're turned dark-on-light first. Big pictures are
// scaled down, small ones up, to the size the engine reads best.
async function prepareForOcr(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(2, Math.max(0.6, 1500 / Math.max(bmp.width, 1)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 40) { sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
  const dark = sum / Math.max(n, 1) < 120;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const v = dark ? 255 - g : g;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** OCR. onProgress(0..1, label) is called while it works. Throws if the engine can't start. */
export async function readText(file, onProgress = () => {}) {
  onProgress(0.02, 'Getting ready');
  const T = await loadTesseract();
  let phase = 'Getting ready';
  const worker = await T.createWorker('eng', 1, {
    workerPath: `${OCR_BASE}worker.min.js`,
    corePath: `${OCR_BASE}${supportsSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`,
    langPath: OCR_BASE,
    gzip: true,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'recognizing text') { phase = 'Reading'; onProgress(0.3 + 0.68 * (m.progress || 0), phase); }
      else if (/loading|initializ/i.test(m.status || '')) onProgress(0.05 + 0.25 * (m.progress || 0), 'Getting ready');
    },
  });
  try {
    const canvas = await prepareForOcr(file);
    const { data } = await worker.recognize(canvas);
    return { text: data.text || '', confidence: Number(data.confidence) || 0, words: (data.words || []).length };
  } finally {
    worker.terminate().catch(() => {});
  }
}

// ---------------------------------------------------------------- reading the text
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function numberFrom(s) {
  const cleaned = String(s).replace(/[Oo]/g, '0').replace(/[.,]+$/, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function validDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2020 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

function findDates(text, today) {
  const found = [];
  const [ty] = today.split('-').map(Number);
  const push = (y, m, d) => { if (validDay(y, m, d)) found.push(isoOf(y, m, d)); };
  let m;
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = iso.exec(text))) push(+m[1], +m[2], +m[3]);
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/g;
  while ((m = dmy.exec(text))) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (a > 12) push(y, b, a);          // 25-10-2026: day first
    else if (b > 12) push(y, a, b);     // 10-25-2026: month first
    else { push(y, b, a); if (a !== b) push(y, a, b); }   // 10-11-2026 can be read either way (Airtel writes it month first)
  }
  const named = /\b(\d{1,2})(?:st|nd|rd|th)?[\s,.-]+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:[\s,.-]+(20\d{2}|\d{2})(?![\d:]))?\b/gi;
  while ((m = named.exec(text))) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    pushYearless(+m[1], MONTHS[m[2].toLowerCase()], year);
  }
  const named2 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?![\d:])(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
  while ((m = named2.exec(text))) pushYearless(+m[2], MONTHS[m[1].toLowerCase()], m[3] ? +m[3] : null);
  function pushYearless(d, mo, year) {
    if (year) { push(year, mo, d); return; }
    // No year shown (most SMS screenshots): this year, or last year if that would be in the future.
    let y = ty;
    if (validDay(y, mo, d) && dayNumber(isoOf(y, mo, d)) > dayNumber(today) + 1) y -= 1;
    push(y, mo, d);
  }
  return found;
}

/**
 * An Airtel transaction ID has a fixed shape (CO261011.1642.I86552: two letters, a date, a time, a letter and
 * five digits), and the big letter I looks like a small l and a 1 on a phone. Read the letters and the digits by
 * where they sit, so the same payment always gives the same ID, however the picture was read.
 */
function canonTid(raw) {
  const trimmed = String(raw).replace(/[.\-_]+$/g, '');
  // A stray dot inside the last part (L.46151 for L46151) is dropped.
  const parts = trimmed.split('.');
  const s = parts.length > 3 ? `${parts[0]}.${parts[1]}.${parts.slice(2).join('')}` : trimmed;
  const m = /^([A-Za-z0-9]{2,4})([0-9OoIl|]{6})\.([0-9OoIl|]{4})\.([A-Za-z0-9|])([0-9OoIl|]{5})$/.exec(s);
  if (!m) return s.toUpperCase();
  const digits = (x) => x.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  // Where a letter belongs, a digit is a letter read wrongly: 0 O, 1 I, 5 S, 8 B, 2 Z, 6 G (and l, | are the capital I).
  const letter = (x) => x.replace(/0/g, 'O').replace(/[1l|]/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B').replace(/2/g, 'Z').replace(/6/g, 'G').toUpperCase();
  // The two letters in front: if the picture gave extra ones, keep the pair that is a kind of transaction
  // Airtel uses (CO cash out, MP merchant payment, PP person to person), else the first two.
  const front = letter(m[1]);
  const pairs = [...Array(front.length - 1).keys()].map((i) => front.slice(i, i + 2));
  const prefix = pairs.find((x) => /^(CO|MP|PP)$/.test(x)) || front.slice(0, 2);
  return `${prefix}${digits(m[2])}.${digits(m[3])}.${letter(m[4])}${digits(m[5])}`;
}

function addDays(iso, delta) {
  return new Date((dayNumber(iso) + delta) * 86400000).toISOString().slice(0, 10);
}

/**
 * Pulls the facts out of the OCR text.
 * ctx: { ownerName, accountNumbers: ['0971234567'], today: 'YYYY-MM-DD' (the shop's date) }
 */
export function parseProofText(raw, ctx = {}) {
  const text = String(raw || '').replace(/ /g, ' ');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flat = lines.join('\n');
  const upper = flat.toUpperCase();
  const today = ctx.today || new Date().toISOString().slice(0, 10);

  // ---- who was paid
  const tokens = String(ctx.ownerName || '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  const lineWords = lines.map((l) => l.toUpperCase().split(/[^A-Z]+/).filter(Boolean));
  const hitLine = (tok) => lineWords.findIndex((ws) => ws.some((w) => w.length >= 3 && editDistance(w, tok) <= (tok.length >= 5 ? 1 : 0)));
  const where = tokens.map(hitLine);
  let nameOk = tokens.length > 0 && where.every((i) => i >= 0) && Math.max(...where) - Math.min(...where) <= 2;
  let nameLine = nameOk ? lines[where[0]] : '';
  if (nameOk) {
    // "From ALFRED PHIRI" is the sender, not the person paid. (But "You have withdrawn ZMW 50 from 2019
    // ALFRED PHIRI" is the client's own cash-out message: the agent they paid is after "from".)
    const first = Math.min(...where);
    const nameRe = new RegExp(tokens[0].slice(0, 3));
    const ctxLine = `${lines[Math.max(0, first - 1)] || ''} ${lines[first] || ''}`.toUpperCase();
    const before = ctxLine.slice(0, Math.max(0, ctxLine.search(nameRe)));
    const here = (lines[first] || '').toUpperCase();
    const wide = `${lines.slice(Math.max(0, first - 3), first).join(' ')} ${here.slice(0, Math.max(0, here.search(nameRe)))}`.toUpperCase();
    const cashOut = /\b(WITHDRAWN|WITHDREW|WITHDRAW|WITHDRAWAL|CASH ?OUT)\b/.test(wide);
    if (/\bFROM\b/.test(before) && !cashOut && !/\b(TO|PAID|SENT|RECIPIENT|BENEFICIARY|PAYEE)\b/.test(before.slice(before.lastIndexOf('FROM')))) nameOk = false;
  }
  const digits = flat.replace(/[^0-9]/g, '');
  let accountOk = false;
  let account = '';
  for (const a of ctx.accountNumbers || []) {
    const needle = a.length >= 9 ? a.slice(-9) : a;
    if (needle.length >= 6 && digits.includes(needle)) { accountOk = true; account = a; break; }
  }

  // ---- how much
  const amounts = [];
  // The text as one line: a large font wraps "ZMW" and the number onto different lines.
  const oneLine = lines.join(' ');
  const money = /(?:ZMW|ZMK|KWACHA|\bK)\s?([0-9][0-9Oo,.]{0,12})|([0-9][0-9,]*\.\d{2})\s?(?:ZMW|ZMK)/gi;
  let mo;
  while ((mo = money.exec(oneLine))) {
    const before = oneLine.slice(Math.max(0, mo.index - 22), mo.index).toLowerCase();
    if (/(fee|fees|charge|charges|balance|bal|tax|commission|comm|available|limit|cashback|bonus)[^0-9]{0,14}$/.test(before)) continue;
    const value = numberFrom((mo[1] || mo[2]).trim());
    if (!Number.isFinite(value) || value <= 0 || value > 1000000) continue;
    const near = oneLine.slice(Math.max(0, mo.index - 60), mo.index + 60);
    amounts.push({ value, line: near, strong: /(sent|paid|payment|pay |amount|transfer|debited|cash ?out|withdrawn|withdrew|purchase|completed|successful)/.test(near.toLowerCase()) });
  }
  const amount = amounts.find((a) => a.strong) || amounts[0] || null;

  // ---- transaction ID
  let txnId = '';
  const label = /(?:financial\s+transaction\s+id|trans(?:action)?\.?\s*(?:id|ref(?:erence)?|no\.?|number)|trx\.?\s*(?:id|ref|no\.?)?|txn\.?\s*(?:id|ref|no\.?)?|\btid\b|reference(?:\s*(?:no\.?|number|id))?|\bref\.?(?:\s*(?:no\.?|id))?|confirmation\s*(?:code|no\.?|number)?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9._\-|]{5,34})/gi;
  let m;
  while ((m = label.exec(flat))) {
    const cand = m[1].replace(/[.\-_]+$/g, '');
    if ((cand.match(/\d/g) || []).length >= 4 && !/^20\d{2}[-/.]\d/.test(cand)) { txnId = canonTid(cand); break; }
  }
  if (!txnId) {
    const airtel = /\b([A-Z0-9]{2}[0-9OIl]{6}\.[0-9OIl]{4}\.[A-Z0-9][0-9OIl]{4,7})\b/i.exec(flat);
    if (airtel) txnId = canonTid(airtel[1]);
  }
  // An Airtel transaction ID carries its own date and time: CO261011.1254.A33706 is 11 Oct 2026, 12:54.
  let tidDate = '';
  let tidTime = '';
  const tm = /^[A-Z]{2}(\d{2})(\d{2})(\d{2})\.(\d{2})(\d{2})\./.exec(txnId);
  if (tm && validDay(2000 + +tm[1], +tm[2], +tm[3]) && +tm[4] < 24 && +tm[5] < 60) {
    tidDate = isoOf(2000 + +tm[1], +tm[2], +tm[3]);
    tidTime = `${tm[4]}:${tm[5]}`;
  }

  // Every transaction ID in the picture. More than one payment showing is turned down. But the Airtel app's
  // Transaction Details screen shows the same ID twice (in the message and in its own row), and a letter or a
  // digit can be read differently each time, so IDs from the same day that are within two minutes of each
  // other, or that end alike, are one payment.
  const tids = new Set(txnId ? [txnId] : []);
  const airtelAll = /\b([A-Z0-9]{2,4}[0-9OIl]{6}\.[0-9OIl]{4}\.[A-Z0-9][0-9OIl]{4,7})\b/gi;
  let am;
  while ((am = airtelAll.exec(flat))) tids.add(canonTid(am[1]));
  const payments = [];
  for (const id of tids) {
    const mt = /^[A-Z]{2}(\d{6})\.(\d{2})(\d{2})\./.exec(id);
    const at = mt ? Number(mt[2]) * 60 + Number(mt[3]) : -1;
    const suffix = id.split('.').pop();
    if (!payments.some((p) => p.id === id || editDistance(p.id, id) <= 2 || (mt && p.day === mt[1] && (Math.abs(p.at - at) <= 2 || editDistance(p.suffix, suffix) <= 2)))) {
      payments.push({ id, day: mt ? mt[1] : '', at, suffix });
    }
  }

  // ---- when
  const dates = findDates(flat, today);
  // Of the readings of a date, the one nearest today that isn't in the future.
  const nearness = (iso) => { const d = dayNumber(today) - dayNumber(iso); return d < -1 ? 1000 - d : Math.abs(d); };
  const seen = dates.length ? dates.slice().sort((x, y) => nearness(x) - nearness(y))[0] : (/\btoday\b/i.test(flat) ? today : (/\byesterday\b/i.test(flat) ? addDays(today, -1) : ''));
  const date = tidDate || seen;
  const t = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*([ap]m)?/i.exec(flat);
  const time = t ? `${pad(+t[1])}:${t[2]}${t[3] ? ` ${t[3].toUpperCase()}` : ''}` : tidTime;
  // The time of the payment itself: inside the ID, else on the same line as a date. (The first clock on a
  // screenshot is the phone's status bar: when the screenshot was taken, not when it was paid.)
  const hm24 = (mt) => `${pad(mt[3] ? (+mt[1] % 12) + (/p/i.test(mt[3]) ? 12 : 0) : +mt[1])}:${mt[2]}`;
  let writtenTime = '';   // the time written beside a date (a message's own time stamp)
  for (const line of lines) {
    const lt = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*([ap]m)?/i.exec(line);
    if (lt && (findDates(line, today).length > 0 || /\b(today|yesterday)\b/i.test(line))) { writtenTime = hm24(lt); break; }
  }
  const payTime = tidTime || writtenTime;

  // ---- status, network, numbers
  const bad = [...new Set((flat.match(/\b(fail(?:ed|ure)?|declined|rejected|insufficient|cancel(?:led)?|reversed|pending|unsuccessful|error|expired|denied|blocked|unable|timed?\s*out|in\s+progress|awaiting|enter\s+(?:your\s+)?pin|please\s+confirm|do\s+you\s+want|are\s+you\s+sure|not\s+(?:sent|completed|successful)|invalid)\b/gi) || []).map((w) => w.toLowerCase()))];
  const good = [...new Set((flat.match(/\b(success(?:ful(?:ly)?)?|completed|confirmed|sent|paid|received|withdrawn|withdrew|approved|done)\b/gi) || []).map((w) => w.toLowerCase()))];
  let network = '';
  if (/\bMTN\b|MOMO/.test(upper)) network = 'MTN MoMo';
  else if (/AIRTEL/.test(upper)) network = 'Airtel Money';
  else if (/ZAMTEL|KWACHA PAY/.test(upper)) network = 'Zamtel Kwacha';
  else {
    const bank = /\b(ZANACO|STANBIC|FNB|ABSA|ATLAS MARA|ECOBANK|STANDARD CHARTERED|INDO ZAMBIA|ACCESS BANK|FIRST ALLIANCE)\b/.exec(upper);
    if (bank) network = bank[1];
  }
  const phones = [...new Set((flat.match(/(?:\+?260|\b0)\s?\d{2}\s?\d{3}\s?\d{4}\b/g) || []).map((p) => p.replace(/\s/g, '')))].slice(0, 4);

  return {
    recipient: { name_ok: nameOk, account_ok: accountOk, account, line: nameLine.slice(0, 120) },
    amount: amount ? { value: amount.value, line: amount.line.slice(0, 160) } : null,
    amounts: amounts.slice(0, 6).map((a) => a.value),
    txn_id: txnId,
    date,
    tid_date: tidDate,
    text_dates: dates,
    date_found: dates.length > 0 || !!date,
    time: payTime || time,
    pay_time: payTime,
    tid_time: tidTime,
    written_time: writtenTime,
    tid_count: payments.length,
    network,
    status_bad: bad,
    status_good: good,
    phones,
  };
}

// ---------------------------------------------------------------- the verdict
const fmtK = (n) => `K${Number(n).toFixed(Number.isInteger(Number(n)) ? 0 : 2)}`;

/**
 * file: readFileInfo(); ocr: { text, confidence, words }; parsed: parseProofText();
 * ctx: { price, ownerName, today: 'YYYY-MM-DD', now: Date }
 */
export function judgeProof({ file, ocr, parsed }, ctx = {}) {
  const now = ctx.now || new Date();
  const today = ctx.today || now.toISOString().slice(0, 10);
  const price = Number(ctx.price) || 0;
  const owner = ctx.ownerName || 'the shop owner';
  const m = file.meta || {};
  const checks = [];
  const add = (id, label, ok, detail, hard = true) => checks.push({ id, label, ok: !!ok, detail: detail || '', hard });

  add('type', 'It is a picture file (JPG, PNG or WebP)', file.kind !== '', file.kind ? '' : 'This is not a JPG, PNG or WebP picture.');
  add('size', 'The file size is normal for a screenshot', file.size >= MIN_BYTES && file.size <= MAX_BYTES,
    file.size > MAX_BYTES ? 'The file is too large (over 8 MB).' : 'The file is too small to be a real screenshot.', false);
  add('pixels', 'It is the size of a phone screenshot', Math.min(file.width, file.height) >= 400 && Math.max(file.width, file.height) >= 700,
    'The picture is too small to be a screenshot of a phone screen.', false);
  const editor = [m.software, m.xmp, m.owner].filter(Boolean).find((s) => EDITORS.test(s)) || (m.photoshop ? 'Photoshop' : '');
  add('edited', 'It was not made or changed in an editing app', !editor, editor ? `Its details say it was made or changed with ${editor}.` : '', false);
  const camera = !!(m.exposure || m.aperture || m.iso);
  add('camera', 'It is a screenshot, not a photo of a screen', !camera, 'This looks like a photo taken with a camera. Please send a screenshot.', false);
  const agoText = (min) => (min < 120 ? `${Math.round(min)} minutes` : `${Math.round(min / 60)} hours`);
  // Minutes since a date and time on the shop's clock (negative when it is in the future).
  const nowMin = Number.isFinite(ctx.nowMin) ? ctx.nowMin : now.getUTCHours() * 60 + now.getUTCMinutes();
  const minutesAgo = (iso, hhmm) => {
    const [h, mi] = hhmm.split(':').map(Number);
    return (dayNumber(today) - dayNumber(iso)) * 1440 + (nowMin - (h * 60 + mi));
  };
  const recent = (min) => min >= -FUTURE_SLACK_MIN && min <= MAX_AGE_MIN;
  const tooOld = (min) => (min < 0 ? 'is in the future' : `is ${agoText(min)} old`);
  // Everything about the file has to be from the last hour: when it was saved, and the date in its name.
  const fileAge = file.modified && Date.parse(file.modified) > 86400000 ? (now.getTime() - Date.parse(file.modified)) / 60000 : null;
  add('fresh', 'The screenshot was saved in the last hour', fileAge !== null && recent(fileAge),
    fileAge === null ? 'The file does not say when it was saved.' : `The file ${fileAge < 0 ? 'was saved in the future' : `was saved ${agoText(fileAge)} ago`}.`, false);
  // Everything inside the picture about when it was made has to be recent too.
  const metaStamp = (v) => {
    const x = /^(20\d{2})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || '').trim());
    return x && validDay(+x[1], +x[2], +x[3]) && +x[4] < 24 && +x[5] < 60 ? [isoOf(+x[1], +x[2], +x[3]), `${x[4]}:${x[5]}`] : null;
  };
  const metaOld = [m.taken, m.dateTime].map(metaStamp).filter(Boolean).map(([d, t]) => minutesAgo(d, t)).find((a) => !recent(a));
  add('meta_time', 'The date saved inside the picture is from the last hour', metaOld === undefined,
    metaOld === undefined ? '' : `The date saved inside the picture ${tooOld(metaOld)}.`, false);
  const readable = (ocr.words || 0) >= 12 && (ocr.confidence || 0) >= MIN_CONFIDENCE;
  add('readable', 'The writing is clear enough to read', readable, 'We could not read the writing clearly. Please send a full, sharp screenshot of the payment message.', false);

  const r = parsed.recipient;
  // The owner's name has to be there, and the account (agent code) from his payment details too, when there is one.
  add('recipient', `The payment went to ${owner}`, r.name_ok && (!ctx.requireAccount || r.account_ok),
    r.name_ok ? 'We could not see the payment account (the agent code or number) from the payment details.' : `We could not see "${owner}" as the person paid.`, false);

  const amt = parsed.amount;
  add('amount', `The amount is ${fmtK(price)} or more`, !!amt && amt.value + 0.001 >= price,
    amt ? `We read ${fmtK(amt.value)}, but the price is ${fmtK(price)}.` : 'We could not find the amount paid.');

  add('txn', 'There is a transaction ID', !!parsed.txn_id, 'We could not find a transaction ID in the screenshot.', false);
  add('status', 'It does not say the payment failed', parsed.status_bad.length === 0,
    `It mentions "${parsed.status_bad[0] || ''}", so the payment may not have gone through.`, false);
  add('status_good', 'It says the payment was successful', parsed.status_good.length > 0, 'We could not see a "successful", "sent" or "withdrawn" message.', false);

  // When it was paid: the date and time (the time inside an Airtel transaction ID, or the one beside the date).
  // No date or no time means no way to know how old the payment is, so it is turned down.
  let dateOk = false;
  let dateDetail = 'We could not read when the payment was made.';
  if (parsed.date && parsed.pay_time) {
    const age = minutesAgo(parsed.date, parsed.pay_time);
    dateOk = recent(age);
    dateDetail = `The payment ${tooOld(age)}.`;
  } else if (parsed.date) {
    dateDetail = 'It shows a date but no time, so there is no way to tell how old the payment is.';
  }
  add('date', 'The payment was made in the last hour', dateOk, dateDetail, false);
  const agrees = !parsed.tid_date || !(parsed.text_dates || []).length || parsed.text_dates.some((d) => d === parsed.tid_date);
  add('tid_date', 'The date matches the date in the transaction ID', agrees, "The date shown doesn't match the date inside the transaction ID.", false);
  let timesOk = true;
  if (parsed.tid_time && parsed.written_time) {
    const [a, b] = [parsed.tid_time, parsed.written_time].map((x) => { const [h, mi] = x.split(':').map(Number); return h * 60 + mi; });
    const gap = Math.abs(a - b);
    timesOk = Math.min(gap, 1440 - gap) <= 10;   // a message can arrive a little after the payment
  }
  add('times_agree', 'The time shown matches the time in the transaction ID', timesOk, "The time shown doesn't match the time inside the transaction ID.", false);
  add('one_payment', 'The picture shows one payment', (parsed.tid_count || 0) <= 1, 'The picture shows more than one transaction.', false);

  // Not even a picture: that is the only thing worth saying.
  const failed = file.kind === '' ? checks.filter((c) => c.id === 'type') : checks.filter((c) => c.hard && !c.ok);
  const verdict = failed.length ? 'rejected' : 'approved';
  return {
    verdict,
    checks,
    reasons: failed.map((c) => c.detail || c.label),
    warnings: checks.filter((c) => !c.hard && !c.ok).map((c) => c.detail || c.label),
    contact: `If you really paid, please call ${owner} to confirm he has seen your payment.`,
  };
}

/** What gets saved with the booking, for the owner to see next to the screenshot. */
export function buildProof({ file, ocr, parsed, judged, path, signedName = '', nameSeen = false }) {
  return {
    v: 1,
    verdict: judged.verdict,
    signed_name: String(signedName || '').trim().replace(/\s+/g, ' ').toUpperCase(),   // the name the client signed with
    name_seen: !!nameSeen,                                                              // ... and whether it is in the screenshot
    path,
    sha256: file.sha256,
    file: {
      name: file.name, size: file.size, type: file.type, kind: file.kind, width: file.width, height: file.height,
      modified: file.modified, meta: file.meta,
    },
    extracted: {
      recipient_ok: parsed.recipient.name_ok, account_ok: parsed.recipient.account_ok, recipient_line: parsed.recipient.line,
      amount: parsed.amount ? parsed.amount.value : null, txn_id: parsed.txn_id, date: parsed.date, time: parsed.time, pay_time: parsed.pay_time,
      network: parsed.network, phones: parsed.phones, status_good: parsed.status_good, status_bad: parsed.status_bad,
    },
    checks: judged.checks.map((c) => ({ id: c.id, ok: c.ok, hard: c.hard })),
    warnings: judged.warnings,
    ocr: { confidence: Math.round(ocr.confidence || 0), words: ocr.words || 0, text: String(ocr.text || '').slice(0, 1500) },
  };
}

/** Accounts / numbers in the owner's payment details ("MTN 0971 234 567", "Airtel 20194278"). */
export function accountNumbers(instructions) {
  const out = [];
  for (const m of String(instructions || '').matchAll(/\+?\d[\d ]{5,16}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 6 && d.length <= 15 && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The name as the client signs it: first and last name, letters only. */
export function validSignedName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  return n.length >= 5 && n.length <= 60 && /^[A-Za-z][A-Za-z.'-]*( [A-Za-z][A-Za-z.'-]*)+$/.test(n);
}

/** Is every part of that name somewhere in the screenshot's text (allowing for a letter misread)? */
export function nameInText(name, text) {
  const tokens = String(name || '').toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const words = String(text || '').toUpperCase().split(/[^A-Z]+/).filter((w) => w.length >= 3);
  return tokens.every((tok) => words.some((w) => editDistance(w, tok) <= (tok.length >= 5 ? 1 : 0)));
}
