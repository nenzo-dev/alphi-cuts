// Reading a payment screenshot on the client's own phone (nothing is sent anywhere to be read):
//   1. readFileInfo()  the file itself: name, size, type, size in pixels, when it was saved, a
//                      fingerprint (SHA-256) and what the picture's own metadata says (EXIF / PNG
//                      text / XMP: the camera, the editing app, the time it was taken).
//   2. readText()      OCR with Tesseract (vendor/tesseract, loaded only when a screenshot is picked).
//   3. parseProofText() who was paid, how much, the transaction ID, the date, the status.
//   4. judgeProof()    checks all of it against what this shop expects and answers approved or
//                      rejected, with the reasons in plain words.
// The checks catch careless fakes and mistakes. They can't prove a payment is real, which is why
// the owner still looks at the screenshot and confirms the money himself.

const OCR_BASE = new URL('../../vendor/tesseract/', import.meta.url).href;

export const MAX_BYTES = 8 * 1024 * 1024;
const MIN_BYTES = 20 * 1024;
const MAX_FILE_AGE_DAYS = 3;       // the picture was saved within the last few days
const MAX_PAYMENT_AGE_DAYS = 2;    // and shows a payment from today or the last two days

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
  while ((m = dmy.exec(text))) push(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
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
    // "From ALFRED PHIRI" is the sender, not the person paid.
    const ctxLine = `${lines[Math.max(0, Math.min(...where) - 1)] || ''} ${lines[Math.min(...where)] || ''}`.toUpperCase();
    const nameAt = Math.max(0, ctxLine.search(new RegExp(tokens[0].slice(0, 3))));
    const before = ctxLine.slice(0, nameAt);
    if (/\bFROM\b/.test(before) && !/\b(TO|PAID|SENT|RECIPIENT|BENEFICIARY|PAYEE)\b/.test(before.slice(before.lastIndexOf('FROM')))) nameOk = false;
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
  const money = /(?:ZMW|ZMK|KWACHA|\bK)\s?([0-9][0-9Oo,.]{0,12})|([0-9][0-9,]*\.\d{2})\s?(?:ZMW|ZMK)/gi;
  lines.forEach((line, idx) => {
    let m;
    money.lastIndex = 0;
    while ((m = money.exec(line))) {
      const before = line.slice(Math.max(0, m.index - 22), m.index).toLowerCase();
      if (/(fee|fees|charge|charges|balance|bal|tax|commission|available|limit|cashback|bonus)[^0-9]{0,14}$/.test(before)) continue;
      const value = numberFrom((m[1] || m[2]).trim());
      if (!Number.isFinite(value) || value <= 0 || value > 1000000) continue;
      const near = `${lines[idx - 1] || ''} ${line}`.toLowerCase();
      amounts.push({ value, line, strong: /(sent|paid|payment|pay |amount|transfer|debited|cash ?out|purchase|completed|successful)/.test(near) });
    }
  });
  const amount = amounts.find((a) => a.strong) || amounts[0] || null;

  // ---- transaction ID
  let txnId = '';
  const label = /(?:financial\s+transaction\s+id|trans(?:action)?\.?\s*(?:id|ref(?:erence)?|no\.?|number)|trx\.?\s*(?:id|ref|no\.?)?|txn\.?\s*(?:id|ref|no\.?)?|\btid\b|reference(?:\s*(?:no\.?|number|id))?|\bref\.?(?:\s*(?:no\.?|id))?|confirmation\s*(?:code|no\.?|number)?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9._\-]{5,34})/gi;
  let m;
  while ((m = label.exec(flat))) {
    const cand = m[1].replace(/[.\-_]+$/g, '');
    if ((cand.match(/\d/g) || []).length >= 4 && !/^20\d{2}[-/.]\d/.test(cand)) { txnId = cand.toUpperCase(); break; }
  }
  if (!txnId) {
    const airtel = /\b([A-Z]{2}\d{6}\.\d{4}\.[A-Z0-9]{4,8})\b/i.exec(flat);
    if (airtel) txnId = airtel[1].toUpperCase();
  }

  // ---- when
  const dates = findDates(flat, today);
  const date = dates.length ? dates.sort().slice(-1)[0] : (/\btoday\b/i.test(flat) ? today : (/\byesterday\b/i.test(flat) ? addDays(today, -1) : ''));
  const t = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*([ap]m)?/i.exec(flat);
  const time = t ? `${pad(+t[1])}:${t[2]}${t[3] ? ` ${t[3].toUpperCase()}` : ''}` : '';

  // ---- status, network, numbers
  const bad = [...new Set((flat.match(/\b(fail(?:ed|ure)?|declined|rejected|insufficient|cancel(?:led)?|reversed|pending|unsuccessful|error|expired|not\s+(?:sent|completed|successful)|invalid)\b/gi) || []).map((w) => w.toLowerCase()))];
  const good = [...new Set((flat.match(/\b(success(?:ful(?:ly)?)?|completed|confirmed|sent|paid|received|approved|done)\b/gi) || []).map((w) => w.toLowerCase()))];
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
    date_found: dates.length > 0 || !!date,
    time,
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
    file.size > MAX_BYTES ? 'The file is too large (over 8 MB).' : 'The file is too small to be a real screenshot.');
  add('pixels', 'It is the size of a phone screenshot', Math.min(file.width, file.height) >= 400 && Math.max(file.width, file.height) >= 700,
    'The picture is too small to be a screenshot of a phone screen.');
  const editor = [m.software, m.xmp, m.owner].filter(Boolean).find((s) => EDITORS.test(s)) || (m.photoshop ? 'Photoshop' : '');
  add('edited', 'It was not made or changed in an editing app', !editor, editor ? `Its details say it was made or changed with ${editor}.` : '');
  const camera = !!(m.exposure || m.aperture || m.iso);
  add('camera', 'It is a screenshot, not a photo of a screen', !camera, 'This looks like a photo taken with a camera. Please send a screenshot.');
  const ageDays = file.modified ? (now.getTime() - Date.parse(file.modified)) / 86400000 : 0;
  add('fresh', 'The file was saved recently', !(file.modified && ageDays > MAX_FILE_AGE_DAYS && Date.parse(file.modified) > 86400000),
    `This file was saved ${Math.floor(ageDays)} days ago. Please send a screenshot from your new payment.`);
  const readable = (ocr.words || 0) >= 12 && (ocr.confidence || 0) >= 45;
  add('readable', 'The writing is clear enough to read', readable, 'We could not read the writing clearly. Please send a full, sharp screenshot of the payment message.');

  const r = parsed.recipient;
  add('recipient', `The payment went to ${owner}`, r.name_ok || r.account_ok,
    `We could not see "${owner}" as the person paid.`);

  const amt = parsed.amount;
  add('amount', `The amount is ${fmtK(price)} or more`, !!amt && amt.value + 0.001 >= price,
    amt ? `We read ${fmtK(amt.value)}, but the price is ${fmtK(price)}.` : 'We could not find the amount paid.');

  add('txn', 'There is a transaction ID', !!parsed.txn_id, 'We could not find a transaction ID in the screenshot.');
  add('status', 'It does not say the payment failed', parsed.status_bad.length === 0,
    `It mentions "${parsed.status_bad[0] || ''}", so the payment may not have gone through.`);
  add('status_good', 'It says the payment was successful', parsed.status_good.length > 0, 'We could not see a "successful" or "sent" message.', false);

  let dateOk = true;
  let dateDetail = '';
  if (parsed.date) {
    const diff = dayNumber(today) - dayNumber(parsed.date);
    if (diff < -1) { dateOk = false; dateDetail = 'The date on it is in the future.'; }
    else if (diff > MAX_PAYMENT_AGE_DAYS) { dateOk = false; dateDetail = `It shows a payment from ${parsed.date}, which is too long ago.`; }
  }
  add('date', 'The payment is recent', dateOk, dateDetail);
  add('date_found', 'The date is visible', !!parsed.date, 'We could not read the date on it.', false);

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
export function buildProof({ file, ocr, parsed, judged, path }) {
  return {
    v: 1,
    verdict: judged.verdict,
    path,
    sha256: file.sha256,
    file: {
      name: file.name, size: file.size, type: file.type, kind: file.kind, width: file.width, height: file.height,
      modified: file.modified, meta: file.meta,
    },
    extracted: {
      recipient_ok: parsed.recipient.name_ok, account_ok: parsed.recipient.account_ok, recipient_line: parsed.recipient.line,
      amount: parsed.amount ? parsed.amount.value : null, txn_id: parsed.txn_id, date: parsed.date, time: parsed.time,
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
