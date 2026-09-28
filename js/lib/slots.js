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

// The shop is a single physical location in Chongwe, Zambia -- every date/time decision (which day
// is "today", which slots are already past) has to use the SHOP's clock, not whichever timezone a
// visiting device happens to be set to. Using the browser's own local time here was a real bug: a
// client whose phone was set to a different timezone (or just had the wrong date) could book into a
// day that never matched the owner's "today", so the booking silently never showed up in his queue.
const SHOP_TZ = 'Africa/Lusaka';

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Minutes since midnight, in the shop's own timezone -- for "is this slot already past" checks.
export function nowMinutesInShopTz() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: SHOP_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// The next `days` calendar dates starting today, all computed in the shop's timezone (used to build
// the date picker) -- returns [{ iso, isToday, isTomorrow }, ...].
export function shopDateOptions(days) {
  const startISO = todayISO();
  const [y, m, d] = startISO.split('-').map(Number);
  // noon UTC avoids any DST/rounding edge landing on the wrong calendar day when we add days.
  const start = new Date(Date.UTC(y, m - 1, d, 12));
  const out = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(start);
    dt.setUTCDate(dt.getUTCDate() + i);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
    out.push({ iso, isToday: i === 0, isTomorrow: i === 1, date: dt });
  }
  return out;
}
