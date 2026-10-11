// Tests for js/lib/proof.js (reading and judging payment screenshots). Run: node tools/proof_test.mjs
import { parseProofText, judgeProof, accountNumbers, validSignedName, nameInText } from '../js/lib/proof.js';

let fails = 0;
const eq = (a, b, what) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.log('FAIL', what, 'got', JSON.stringify(a), 'wanted', JSON.stringify(b)); } else console.log('ok  ', what);
};

const ctx = { ownerName: 'Alfred Phiri', accountNumbers: accountNumbers('Airtel, 20194278, get cash\nMTN 0971 234 567'), today: '2026-10-11' };
eq(ctx.accountNumbers, ['20194278', '0971234567'], 'account numbers from the payment details');

const goodFile = { kind: 'png', size: 250000, width: 1080, height: 2340, modified: '2026-10-11T10:30:00Z', meta: {}, sha256: 'a'.repeat(64), name: 'Screenshot.png' };
const judge = (text, file = goodFile, c = {}) => {
  const parsed = parseProofText(text, ctx);
  return { parsed, j: judgeProof({ file, ocr: { text, confidence: 88, words: 40 }, parsed }, { price: 50, ownerName: 'Alfred Phiri', today: '2026-10-11', now: new Date('2026-10-11T10:40:00Z'), nowMin: 760, ...c }) };
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
Sat, 11 Oct 11:50`);
eq(r.j.verdict, 'approved', 'mtn: approved');
eq(r.parsed.amount.value, 50, 'mtn: amount not the balance');
eq(r.parsed.txn_id, '14567890123', 'mtn: txn id');
eq(r.parsed.date, '2026-10-11', 'mtn: date without year');

// ---- paid by account number only (name cut off)
r = judge(`Airtel Money
You have sent ZMW 60.00 to 20194278 successfully.
Trans ID MP261011.7777.B11111
Today 11:58`);
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

// ---- the real Airtel message from Mr Alfred's phone (what he sees when money arrives)
const real = `AirtelMoney
10-11-2026 12:54
ZMW 50.00 received from 574569876 RUTH LUNGU. Bal ZMW 150.26. Comm ZMW 0.50 TID: CO261011.1254.A33706`;
let p = parseProofText(real, ctx);
eq(p.amount && p.amount.value, 50, 'real message: amount is 50, not the balance or the commission');
eq(p.txn_id, 'CO261011.1254.A33706', 'real message: TID');
eq(p.tid_date, '2026-10-11', 'real message: date inside the TID');
eq(p.date, '2026-10-11', 'real message: 10-11-2026 is 11 October, not 10 November');
eq(p.time, '12:54', 'real message: time');
eq(p.network, 'Airtel Money', 'real message: network');
// a cash-out confirmation a client could send for the same payment (the exact wording is a guess)
const at13 = { now: new Date('2026-10-11T11:00:00Z'), nowMin: 780 };
const file13 = { ...goodFile, modified: '2026-10-11T10:50:00Z' };
r = judge(`Airtel Money
Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. Bal ZMW 150.26. Comm ZMW 0.50 TID: CO261011.1254.A33706
10-11-2026 12:54`, file13, at13);
eq(r.j.verdict, 'approved', 'cash-out to the agent code: approved');
eq(r.parsed.amount.value, 50, 'cash-out: amount');
r = judge(`Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO261001.1254.A33706 10-11-2026 12:54`, file13, at13);
eq(r.j.verdict, 'rejected', 'the date in the ID disagrees with the date shown: rejected');
r = judge(`Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO260901.1254.A33706`, file13, at13);
eq(r.j.verdict, 'rejected', 'a TID from September: rejected as old');
r = judge(`Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO261011.1254.A33706 25-10-2026`, file13, at13);
eq(r.j.verdict, 'rejected', 'a day-first date that disagrees: rejected');
r = judge(`Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO261011.1254.A33706 11/10/2026`, file13, at13);
eq(r.j.verdict, 'approved', 'day-first 11/10/2026 agrees with the TID');

// ---- nothing older than an hour (the shop clock is 12:40 in these tests)
const pay = (when, file = goodFile, c = {}) => judge(`Sent K50.00 to ALFRED PHIRI 0977654321. Trans. ID: 14567890123 ${when} successful`, file, c);
eq(pay('11 Oct 2026 12:39').j.verdict, 'approved', 'a payment from 1 minute ago');
eq(pay('11 Oct 2026 11:42').j.verdict, 'approved', 'a payment from 58 minutes ago');
r = pay('11 Oct 2026 11:35');
eq(r.j.verdict, 'rejected', 'a payment from 65 minutes ago: rejected');
eq(r.j.reasons.some((x) => /last hour/.test(x)), true, 'it says the payment must be from the last hour');
eq(pay('11 Oct 2026 09:40').j.verdict, 'rejected', 'a payment from 3 hours ago: rejected');
eq(pay('10 Oct 2026 12:40').j.verdict, 'rejected', 'a payment from yesterday: rejected');
eq(pay('11 Oct 2026 13:05').j.verdict, 'rejected', 'a payment 25 minutes in the future: rejected');
eq(pay('11 Oct 2026 12:47').j.verdict, 'approved', 'a payment 7 minutes ahead (clock difference): fine');
eq(pay('Today').j.verdict, 'approved', 'today with no time: the file is the check');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:10:00Z' }).j.verdict, 'rejected', 'a screenshot saved 90 minutes ago: rejected');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:45:00Z' }).j.verdict, 'approved', 'a screenshot saved 55 minutes ago: fine');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:38:00Z' }).j.verdict, 'rejected', 'a screenshot saved 62 minutes ago: rejected');
// the time inside an Airtel ID counts, not the clock in the corner
r = judge(`15:30 Airtel Money Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO261011.1004.A33706`);
eq(r.j.verdict, 'rejected', 'the status bar clock does not make an old TID new');

// ---- the name signed
eq(validSignedName('Ruth Lungu'), true, 'full name');
eq(validSignedName('RUTH LUNGU'), true, 'upper case');
eq(validSignedName("Mary-Ann O'Neil Banda"), true, 'three parts');
eq(validSignedName('Ruth'), false, 'one name is not enough');
eq(validSignedName('R L'), false, 'initials');
eq(validSignedName('Ruth 123'), false, 'digits');
eq(validSignedName(''), false, 'empty');
eq(nameInText('Ruth Lungu', 'received from 574569876 RUTH LUNGU. Bal'), true, 'name in the text');
eq(nameInText('Ruth Lungu', 'received from 574569876 RUTH LUNGO. Bal'), true, 'one letter misread is fine');
eq(nameInText('Ruth Lungu', 'received from 574569876 JOHN BANDA. Bal'), false, 'a different name');

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
