// Tests for js/lib/proof.js (reading and judging payment screenshots). Run: node tools/proof_test.mjs
import { parseProofText, judgeProof, accountNumbers } from '../js/lib/proof.js';

let fails = 0;
const eq = (a, b, what) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.log('FAIL', what, 'got', JSON.stringify(a), 'wanted', JSON.stringify(b)); } else console.log('ok  ', what);
};

const ctx = { ownerName: 'Alfred Phiri', accountNumbers: accountNumbers('Airtel, 20194278, get cash\nMTN 0971 234 567'), today: '2026-10-11' };
eq(ctx.accountNumbers, ['20194278', '0971234567'], 'account numbers from the payment details');

const goodFile = { kind: 'png', size: 250000, width: 1080, height: 2340, modified: '2026-10-11T09:00:00Z', meta: {}, sha256: 'a'.repeat(64), name: 'Screenshot.png' };
const judge = (text, file = goodFile, c = {}) => {
  const parsed = parseProofText(text, ctx);
  return { parsed, j: judgeProof({ file, ocr: { text, confidence: 88, words: 40 }, parsed }, { price: 50, ownerName: 'Alfred Phiri', today: '2026-10-11', now: new Date('2026-10-11T10:00:00Z'), ...c }) };
};

// ---- Airtel Money
let r = judge(`Airtel Money
Sent K50.00 to ALFRED PHIRI 0977654321.
Trans. ID: MP261011.1234.A56789
Fee K0.00. Balance K120.50.
11 Oct 2026 12:04`);
eq(r.j.verdict, 'approved', 'airtel: approved');
eq(r.parsed.amount.value, 50, 'airtel: amount ignores balance and fee');
eq(r.parsed.txn_id, 'MP261011.1234.A56789', 'airtel: txn id');
eq(r.parsed.network, 'Airtel Money', 'airtel: network');
eq(r.parsed.date, '2026-10-11', 'airtel: date');

// ---- MTN MoMo SMS, no year
r = judge(`MTN MoMo
Payment for K50.00 to Alfred Phiri 0961234567 has been completed.
Financial Transaction Id: 14567890123.
External Transaction Id: 998877
Your new balance is K1,250.00.
Sat, 11 Oct 12:30`);
eq(r.j.verdict, 'approved', 'mtn: approved');
eq(r.parsed.amount.value, 50, 'mtn: amount not the balance');
eq(r.parsed.txn_id, '14567890123', 'mtn: txn id');
eq(r.parsed.date, '2026-10-11', 'mtn: date without year');

// ---- paid by account number only (name cut off)
r = judge(`Airtel Money
You have sent ZMW 60.00 to 20194278 successfully.
Trans ID MP261011.7777.B11111
Today 14:02`);
eq(r.j.verdict, 'approved', 'account number only: approved');
eq(r.parsed.date, '2026-10-11', 'today word');

// ---- fakes
r = judge(`Sent K20.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'too little money: rejected');
eq(r.j.reasons.some((x) => /K20/.test(x)), true, 'too little money: says K20');

r = judge(`Sent K50.00 to JOHN BANDA 0977111222. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'wrong person: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261001.1234.A56789 01 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'old payment: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. successful 11 Oct 2026 12:04 Balance K90`);
eq(r.j.verdict, 'rejected', 'no transaction id: rejected');

r = judge(`Transfer FAILED. Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04`);
eq(r.j.verdict, 'rejected', 'failed payment: rejected');

r = judge(`Payment from ALFRED PHIRI of K50.00 completed. Trans ID MP261011.1234.A56789 11 Oct 2026 12:04`);
eq(r.j.verdict, 'rejected', 'he is the sender, not the receiver: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, meta: { software: 'Adobe Photoshop 25.0' } });
eq(r.j.verdict, 'rejected', 'photoshop: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, meta: { exposure: true, make: 'samsung' } });
eq(r.j.verdict, 'rejected', 'camera photo: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, modified: '2026-09-01T10:00:00Z' });
eq(r.j.verdict, 'rejected', 'old file: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1234.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, kind: '' });
eq(r.j.verdict, 'rejected', 'not an image: rejected');

// OCR slips: K5O.OO and PHIR1
r = judge(`Sent K5O.OO to ALFRED PHIR1 0977654321 successful
Trans. ID: MP261011.1234.A56789
11/10/2026 12:04`);
eq(r.parsed.amount && r.parsed.amount.value, 50, 'ocr slip in amount');
eq(r.j.verdict, 'approved', 'ocr slip in name: still approved');

// a clean good proof from a screenshot with no date: approved with a warning
r = judge(`Sent K50.00 to ALFRED PHIRI successful. Trans ID: 12345678901`);
eq(r.j.verdict, 'approved', 'no date: approved');
eq(r.j.warnings.length > 0, true, 'no date: has a warning');

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
