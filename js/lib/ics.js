// "Add to calendar": a small .ics file with two alarms (a heads-up and one at the start). Phone
// calendars ring even when the browser is closed, which a web page alone can't do.
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

function fold(line) {
  const out = [];
  let rest = line;
  while (rest.length > 70) {
    out.push(rest.slice(0, 70));
    rest = ` ${rest.slice(70)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function bookingIcs({ uid, startMs, minutes, title, location, description, reminderMinutes }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AlPhi Cuts//Booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@alphi-cuts`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + minutes * 60000)}`,
    `SUMMARY:${escText(title)}`,
    `LOCATION:${escText(location)}`,
    `DESCRIPTION:${escText(description)}`,
  ];
  if (reminderMinutes > 0) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(title)}`, `TRIGGER:-PT${reminderMinutes}M`, 'END:VALARM');
  }
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(title)}`, 'TRIGGER:PT0M', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function downloadFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
