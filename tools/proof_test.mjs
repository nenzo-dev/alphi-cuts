// Tests for js/lib/proof.js (reading and judging payment screenshots). Run: node tools/proof_test.mjs
import { parseProofText, judgeProof, accountNumbers, validSignedName, nameInText } from '../js/lib/proof.js';

let fails = 0;
const eq = (a, b, what) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) { fails++; console.log('FAIL', what, 'got', JSON.stringify(a), 'wanted', JSON.stringify(b)); } else console.log('ok  ', what);
};

const ctx = { ownerName: 'Alfred Phiri', accountNumbers: accountNumbers('Airtel, 20194278, get cash\nMTN 0971 234 567'), today: '2026-10-11' };
eq(ctx.accountNumbers, ['20194278', '0971234567'], 'account numbers from the payment details');

// The shop clock in these tests is 12:40 (10:40 UTC).
const goodFile = { kind: 'png', size: 250000, width: 1080, height: 2340, modified: '2026-10-11T10:30:00Z', meta: {}, sha256: 'a'.repeat(64), name: 'Screenshot.png' };
const judge = (text, file = goodFile, c = {}) => {
  const parsed = parseProofText(text, ctx);
  return { parsed, j: judgeProof({ file, ocr: { text, confidence: 88, words: 40 }, parsed }, { price: 50, ownerName: 'Alfred Phiri', today: '2026-10-11', now: new Date('2026-10-11T10:40:00Z'), nowMin: 760, ...c }) };
};

// ---- Airtel Money
let r = judge(`Airtel Money
Sent K50.00 to ALFRED PHIRI 0977654321.
Trans. ID: MP261011.1204.A56789
Fee K0.00. Balance K120.50.
11 Oct 2026 12:04`);
eq(r.j.verdict, 'approved', 'airtel: approved');
eq(r.parsed.amount.value, 50, 'airtel: amount ignores balance and fee');
eq(r.parsed.txn_id, 'MP261011.1204.A56789', 'airtel: txn id');
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
eq(r.j.verdict, 'rejected', 'account number only, no name: rejected (the name has to be there too)');
eq(r.parsed.date, '2026-10-11', 'today word');

// ---- fakes
r = judge(`Sent K20.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'too little money: rejected');
eq(r.j.reasons.some((x) => /K20/.test(x)), true, 'too little money: says K20');

r = judge(`Sent K50.00 to JOHN BANDA 0977111222. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'wrong person: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261001.1204.A56789 01 Oct 2026 12:04 successful`);
eq(r.j.verdict, 'rejected', 'old payment: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. successful 11 Oct 2026 12:04 Balance K90`);
eq(r.j.verdict, 'rejected', 'no transaction id: rejected');

r = judge(`Transfer FAILED. Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04`);
eq(r.j.verdict, 'rejected', 'failed payment: rejected');

r = judge(`Payment from ALFRED PHIRI of K50.00 completed. Trans ID MP261011.1204.A56789 11 Oct 2026 12:04`);
eq(r.j.verdict, 'rejected', 'he is the sender, not the receiver: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, meta: { software: 'Adobe Photoshop 25.0' } });
eq(r.j.verdict, 'rejected', 'photoshop: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, meta: { exposure: true, make: 'samsung' } });
eq(r.j.verdict, 'rejected', 'camera photo: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, modified: '2026-09-01T10:00:00Z' });
eq(r.j.verdict, 'rejected', 'old file: rejected');

r = judge(`Sent K50.00 to ALFRED PHIRI. Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04 successful`, { ...goodFile, kind: '' });
eq(r.j.verdict, 'rejected', 'not an image: rejected');

// OCR slips: K5O.OO and PHIR1
r = judge(`Sent K5O.OO to ALFRED PHIR1 0977654321 successful
Trans. ID: MP261011.1204.A56789
11/10/2026 12:04`);
eq(r.parsed.amount && r.parsed.amount.value, 50, 'ocr slip in amount');
eq(r.j.verdict, 'approved', 'ocr slip in name: still approved');

// strict: no date, no time, or no success message and it is turned down
r = judge(`Sent K50.00 to ALFRED PHIRI successful. Trans ID: 12345678901`);
eq(r.j.verdict, 'rejected', 'no date: rejected');
eq(r.j.reasons.some((x) => /when the payment was made/.test(x)), true, 'no date: says it could not read when');
r = judge(`Sent K50.00 to ALFRED PHIRI successful. Trans ID: 12345678901 11 Oct 2026`);
eq(r.j.verdict, 'rejected', 'a date but no time: rejected');
r = judge(`K50.00 ALFRED PHIRI Trans. ID: MP261011.1204.A56789 11 Oct 2026 12:04`);
eq(r.j.verdict, 'rejected', 'no success message: rejected');

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
eq(r.j.reasons.some((x) => /65 minutes old/.test(x)), true, 'the owner is told how old the payment is');
eq(pay('11 Oct 2026 09:40').j.verdict, 'rejected', 'a payment from 3 hours ago: rejected');
eq(pay('10 Oct 2026 12:40').j.verdict, 'rejected', 'a payment from yesterday: rejected');
eq(pay('11 Oct 2026 13:05').j.verdict, 'rejected', 'a payment 25 minutes in the future: rejected');
eq(pay('11 Oct 2026 12:44').j.verdict, 'approved', 'a payment 4 minutes ahead (clock difference): fine');
eq(pay('11 Oct 2026 12:47').j.verdict, 'rejected', 'a payment 7 minutes ahead: rejected');
eq(pay('Today').j.verdict, 'rejected', 'today with no time: rejected, there is no way to tell how old it is');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:10:00Z' }).j.verdict, 'rejected', 'a screenshot saved 90 minutes ago: rejected');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:45:00Z' }).j.verdict, 'approved', 'a screenshot saved 55 minutes ago: fine');
eq(pay('11 Oct 2026 12:39', { ...goodFile, modified: '2026-10-11T09:38:00Z' }).j.verdict, 'rejected', 'a screenshot saved 62 minutes ago: rejected');
// the time inside an Airtel ID counts, not the clock in the corner
r = judge(`15:30 Airtel Money Cash out of ZMW 50.00 to agent ALFRED PHIRI 20194278 successful. TID: CO261011.1004.A33706`);
eq(r.j.verdict, 'rejected', 'the status bar clock does not make an old TID new');

// ---- a real cash-out message from a client's phone (big print, so the lines wrap in odd places)
const at1645 = { now: new Date('2026-10-11T14:45:00Z'), nowMin: 16 * 60 + 45 };
const file1645 = { ...goodFile, modified: '2026-10-11T14:43:00Z' };
const realClient = `You have withdrawn ZMW
50.00 from 11/10/2026
ALFRED PHIRI. Bal is ZMW
124.25. TID:
CO261011.1642.I86552.`;
r = judge(realClient, file1645, at1645);
eq(r.j.verdict, 'approved', 'client cash-out message: approved');
eq(r.parsed.amount && r.parsed.amount.value, 50, 'client cash-out: amount is 50, not the balance 124.25');
eq(r.parsed.txn_id, 'CO261011.1642.I86552', 'client cash-out: TID');
eq(r.parsed.recipient.name_ok, true, 'client cash-out: Alfred Phiri after "withdrawn ... from"');
eq(r.parsed.date, '2026-10-11', 'client cash-out: 11/10/2026 is 11 October (the ID says so)');
eq(r.parsed.pay_time, '16:42', 'client cash-out: time from the ID');
// the same ID however the big letter I was read
for (const tid of ['CO261011.1642.186552', 'CO261011.1642.l86552', 'C0261011.1642.I86552', 'CO261O11.1642.I86552', 'CO261011.1642.|86552']) {
  eq(parseProofText(`You have withdrawn ZMW 50.00 from 11/10/2026 ALFRED PHIRI. Bal is ZMW 124.25. TID: ${tid}.`, ctx).txn_id, 'CO261011.1642.I86552', `TID read as ${tid}`);
}
r = judge(realClient.replace('ALFRED PHIRI', 'JOHN BANDA'), file1645, at1645);
eq(r.j.verdict, 'rejected', 'client cash-out to someone else: rejected');
r = judge(`ZMW 50.00 received from 574569876 ALFRED PHIRI. Bal ZMW 150.26. TID: CO261011.1642.I86552`, file1645, at1645);
eq(r.j.verdict, 'rejected', 'a message where he is the sender: rejected');
r = judge(realClient.replace('50.00', '20.00'), file1645, at1645);
eq(r.j.verdict, 'rejected', 'client cash-out of K20: rejected');
r = judge(realClient.replace('CO261011.1642', 'CO261011.1542'), file1645, at1645);
eq(r.j.verdict, 'rejected', 'an ID from over an hour ago: rejected');

// ---- the real cash-out message from a client's phone (28 September, so these tests set the clock to then)
const real2 = `You have withdrawn ZMW
50.00 from 20194278
ALFRED PHIRI. Bal is ZMW
124.25. TID:
CO260928.1202.I86552.
Airtel Zambia`;
const sep28 = { now: new Date('2026-09-28T10:05:00Z'), nowMin: 12 * 60 + 5, today: '2026-09-28' };
const fileSep28 = { ...goodFile, modified: '2026-09-28T10:04:00Z' };
r = judge(real2, fileSep28, sep28);
eq(r.j.verdict, 'approved', 'real client message, 3 minutes after the payment: approved');
eq(r.parsed.amount && r.parsed.amount.value, 50, 'real client message: amount 50, not the balance');
eq(r.parsed.txn_id, 'CO260928.1202.I86552', 'real client message: TID');
eq(r.parsed.tid_date, '2026-09-28', 'real client message: date inside the TID');
eq(r.parsed.pay_time, '12:02', 'real client message: time inside the TID');
eq(r.parsed.recipient.name_ok, true, 'real client message: Alfred Phiri found');
eq(r.parsed.recipient.account_ok, true, 'real client message: the agent code 20194278 found');
eq(r.parsed.network, 'Airtel Money', 'real client message: Airtel');
eq(r.parsed.status_bad, [], 'real client message: nothing says failed');
for (const tid of ['CO260928.12O2.I86552', 'CO260928.l2O2.I86552', 'C0260928.1202.l86552', 'CO26O928.1202.186552', 'CO260928.I2O2.|86552']) {
  eq(parseProofText(`You have withdrawn ZMW 50.00 from 20194278 ALFRED PHIRI. Bal is ZMW 124.25. TID: ${tid}.`, ctx).txn_id, 'CO260928.1202.I86552', `real TID read as ${tid}`);
}
eq(judge(real2, fileSep28, { ...sep28, now: new Date('2026-09-28T11:30:00Z'), nowMin: 13 * 60 + 30 }).j.verdict, 'rejected', 'real client message, 88 minutes after the payment: rejected');
eq(judge(real2, fileSep28, { now: new Date('2026-10-11T10:05:00Z'), nowMin: 12 * 60 + 5, today: '2026-10-11' }).j.verdict, 'rejected', 'real client message sent two weeks later: rejected');
eq(judge(real2.replace('ALFRED PHIRI', 'JOHN BANDA').replace('20194278', '20194279'), fileSep28, sep28).j.verdict, 'rejected', 'the same message for another agent: rejected');
eq(judge(real2.replace('50.00', '10.00'), fileSep28, sep28).j.verdict, 'rejected', 'real client message edited to K10: rejected');

// ---- the file itself
r = judge(realClient, { ...file1645, modified: '' }, at1645);
eq(r.j.verdict, 'rejected', 'a file that does not say when it was saved: rejected');
eq(judge(realClient, { ...file1645, name: 'whatever.png' }, at1645).j.verdict, 'approved', 'the file name is not checked');
eq(judge(realClient, { ...file1645, modified: '2026-10-11T14:55:00Z' }, at1645).j.verdict, 'rejected', 'saved 10 minutes in the future: rejected');
eq(judge(realClient, { ...file1645, modified: '2026-10-11T14:48:00Z' }, at1645).j.verdict, 'approved', 'saved 3 minutes in the future (clock difference): fine');

// ---- very strict
const strict = (text, file = file1645, c = {}) => judge(text, file, { ...at1645, requireAccount: true, ...c });
const withCode = realClient.replace('from 11/10/2026', 'from 20194278 11/10/2026');
eq(strict(withCode).j.verdict, 'approved', 'the name and the agent code, both there: approved');
eq(judge(real2, fileSep28, { ...sep28, requireAccount: true }).j.verdict, 'approved', 'the real client message, with the name and the agent code: approved with every strict check on');
// a digit where the ID has a letter is a letter read wrongly
for (const [read, want] of [['CO261011.1806.584801', 'CO261011.1806.S84801'], ['CO261011.1806.884801', 'CO261011.1806.B84801'], ['CO261011.1806.284801', 'CO261011.1806.Z84801'], ['CO261011.1806.D54334', 'CO261011.1806.D54334'], ['CO261011.1806.054334', 'CO261011.1806.O54334']]) {
  eq(parseProofText(`TID: ${read}.`, ctx).txn_id, want, `ID read as ${read}`);
}

// a stray dot inside the last part is dropped
eq(parseProofText('TID: CO261011.1814.L.46151.', ctx).txn_id, 'CO261011.1814.L46151', 'ID read with a dot inside its last part');

// a stray character in front of the ID is dropped
for (const read of ['C0O261011.1810.K40790', 'CCO261011.1810.K40790', 'CO261011.1810.K40790']) {
  eq(parseProofText(`TID: ${read}.`, ctx).txn_id, 'CO261011.1810.K40790', `ID read as ${read}`);
}

// ---- the Airtel app's "Transaction Details" screen (a real client booked with one of these): the ID shows twice
const appScreen = (tid1, tid2 = tid1) => `5:30 5G
Transaction Details Done
Transaction Successful
You have withdrawn ZMW 50.00 from 20194278 ALFRED
PHIRI. Bal is ZMW 59.54. TID: ${tid1}.
Transaction ID ${tid2}
Amount ZMW 50
Transaction Date & Time 11 Oct 2026, 17:30
Do another transaction`;
const at1735 = { now: new Date('2026-10-11T15:35:00Z'), nowMin: 17 * 60 + 35, requireAccount: true };
const fileApp = { ...goodFile, modified: '2026-10-11T15:31:00Z' };
r = judge(appScreen('CO261011.1730.D54334'), fileApp, at1735);
eq(r.j.verdict, 'approved', 'airtel app screen, 5 minutes after paying: approved with every strict check on');
eq(r.parsed.tid_count, 1, 'airtel app screen: the ID shown twice is one payment');
eq(r.parsed.written_time, '17:30', 'airtel app screen: the time beside the date');
eq(r.parsed.recipient.name_ok && r.parsed.recipient.account_ok, true, 'airtel app screen: the name and the agent code');
eq(judge(appScreen('CO261011.1730.D54334', 'C0261011.1730.054334'), fileApp, at1735).j.verdict, 'approved', 'the second copy of the ID read a little differently (O for D, 0 for O): still one payment');
eq(judge(appScreen('CO261011.1730.D54334', 'CO261011.1738.D54334'), fileApp, at1735).j.verdict, 'approved', 'the second copy with a digit misread in the time: still one payment (same ending)');
eq(judge(appScreen('CO261011.1730.D54334', 'CO261011.1730.D54339'), fileApp, at1735).j.verdict, 'approved', 'the second copy with the last digit misread: still one payment');
eq(judge(appScreen('CO261011.1730.D54334', 'C0O261011.1730.D54334'), fileApp, at1735).j.verdict, 'approved', 'the second copy with a stray character in front: still one payment');
eq(judge(appScreen('C0O261011.1730.D54334', 'CO261011.1730.D54334'), fileApp, at1735).j.verdict, 'approved', 'the first copy with a stray character in front: still one payment');
eq(judge(appScreen('CO261011.1730.D54334', 'CO261011.1405.K98765'), fileApp, at1735).j.verdict, 'rejected', 'a different payment from earlier on the same screen: rejected');
eq(judge(appScreen('CO261011.1730.D54334').replace('11 Oct 2026, 17:30', '11 Oct 2026, 15:30'), fileApp, at1735).j.verdict, 'rejected', 'the written time two hours off the time in the ID: rejected');
eq(judge(appScreen('CO261011.1730.D54334'), fileApp, { ...at1735, now: new Date('2026-10-11T16:45:00Z'), nowMin: 18 * 60 + 45 }).j.verdict, 'rejected', 'airtel app screen an hour and a quarter later: rejected');

// exactly what the reader gave for the real picture (the balance and the "TID:" label came out garbled)
const real2Ocr = 'You have withdrawn ZMW\n50.00 from 20194278\nALFRED PHIRI. Bal is ZMW\n2422550):\nC0260928.1202.186552.\n\n« Airtel Zambia\n';
r = judge(real2Ocr, fileSep28, { ...sep28, requireAccount: true });
eq(r.j.verdict, 'approved', 'the real picture as the reader gave it: approved with every strict check on');
eq(r.parsed.txn_id, 'CO260928.1202.I86552', 'the real picture as the reader gave it: the ID is put right');
eq(r.parsed.tid_count, 1, 'the real picture as the reader gave it: one payment');
r = strict(realClient);
eq(r.j.verdict, 'rejected', 'the name but not the agent code: rejected when the payment details have a code');
eq(r.j.reasons.some((x) => /agent code/.test(x)), true, 'the owner is told the code is missing');
eq(judge(realClient, file1645, at1645).j.verdict, 'approved', 'the same message when the payment details have no code: approved');
eq(strict(withCode.replace('ALFRED PHIRI', 'JOHN BANDA')).j.verdict, 'rejected', 'the agent code but another name: rejected');

// one payment in the picture
r = strict(withCode + '\nYou have withdrawn ZMW 50.00 from 20194278 ALFRED PHIRI. TID: CO261011.1542.A12345.');
eq(r.parsed.tid_count, 2, 'two transaction IDs counted');
eq(r.j.verdict, 'rejected', 'two payments in one picture: rejected');
eq(strict(withCode + '\n' + withCode).parsed.tid_count, 1, 'the same ID twice is one payment');

// the time written on the message has to match the time in the ID
eq(strict(withCode + '\nToday 16:44').j.verdict, 'approved', 'a message time stamp 2 minutes after the payment: fine');
r = strict(withCode + '\nToday 15:10');
eq(r.j.verdict, 'rejected', 'a message time stamp far from the ID: rejected');
eq(r.j.reasons.some((x) => /time shown/.test(x)), true, 'the owner is told the times disagree');

// the date has to be the same day as the ID
eq(strict(withCode.replace('11/10/2026', '12/10/2026')).j.verdict, 'rejected', 'a date one day off from the ID: rejected');
eq(strict(withCode.replace('11/10/2026', '11 Oct 2026')).j.verdict, 'approved', 'the same day written another way: fine');

// not finished, or not through
for (const word of ['Enter your PIN to confirm', 'Please confirm', 'Do you want to continue?', 'Are you sure', 'Transaction in progress', 'Awaiting approval', 'Request denied', 'Request timed out']) {
  eq(strict(withCode + '\n' + word).j.verdict, 'rejected', `"${word}": rejected`);
}
eq(strict(withCode + '\nProcessing fee ZMW 0.50').j.verdict, 'approved', 'a processing fee line is not a problem');

// the reading has to be sure
eq(judge(withCode, file1645, at1645).j.verdict, 'approved', 'the reading is sure (88%): approved');
const unsure = (conf, words = 40) => { const parsed = parseProofText(withCode, ctx); return judgeProof({ file: file1645, ocr: { text: withCode, confidence: conf, words }, parsed }, { price: 50, ownerName: 'Alfred Phiri', today: '2026-10-11', ...at1645 }); };
eq(unsure(70).verdict, 'approved', 'the reading is 70% sure: approved');
eq(unsure(60).verdict, 'rejected', 'the reading is only 60% sure: rejected');
eq(unsure(90, 8).verdict, 'rejected', 'too few words: rejected');

// what the picture says about when it was made
const metaFile = (meta) => ({ ...file1645, meta });
eq(strict(withCode, metaFile({ taken: '2026:10:11 16:43:10' })).j.verdict, 'approved', 'inside date from 2 minutes ago: approved');
eq(strict(withCode, metaFile({ taken: '2026:10:11 09:10:00' })).j.verdict, 'rejected', 'inside date from this morning: rejected');
eq(strict(withCode, metaFile({ dateTime: '2026:10:10 16:43:10' })).j.verdict, 'rejected', 'a modified date from yesterday: rejected');
eq(strict(withCode, metaFile({ taken: 'not a date' })).j.verdict, 'approved', 'an unreadable inside date is ignored');

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
