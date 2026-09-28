// Turns "opens 08:00, closes 20:00, 20 minutes a cut" into the list of bookable start times:
// 08:00, 08:20, 08:40 ... 19:40 (the last slot still finishes exactly at closing time).
export function daySlots(openTime, closeTime, slotMinutes) {
  const [oh, om] = openTime.split(':').map(Number);
  const [ch, cm] = closeTime.split(':').map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  const out = [];
  for (let t = openMin; t + slotMinutes <= closeMin; t += slotMinutes) {
    const h = String(Math.floor(t / 60)).padStart(2, '0');
    const m = String(t % 60).padStart(2, '0');
    out.push(`${h}:${m}`);
  }
  return out;
}

export function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
