// IMAP date handling: INTERNALDATE ("17-Jul-1996 02:44:25 -0700") to
// epoch milliseconds. No exceptions — returns NaN on malformed input.

const MONTHS: string[] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthOf(name: string): i32 {
  const low = name.toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) {
    if (low == MONTHS[i]) return i;
  }
  return -1;
}

function digits(s: string, start: i32, count: i32): i32 {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    if (idx >= s.length) return -1;
    const c = s.charCodeAt(idx);
    if (c < 48 || c > 57) return -1;
    n = n * 10 + (c - 48);
  }
  return n;
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
function daysFromCivil(y: i32, m: i32, d: i32): i64 {
  const yy: i64 = m <= 2 ? y - 1 : y;
  const era: i64 = (yy >= 0 ? yy : yy - 399) / 400;
  const yoe: i64 = yy - era * 400;
  const mp: i64 = (m + 9) % 12;
  const doy: i64 = (153 * mp + 2) / 5 + d - 1;
  const doe: i64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

/** Parse an IMAP INTERNALDATE to epoch ms; NaN when malformed. */
export function parseImapDate(s: string): f64 {
  // "dd-Mon-yyyy HH:MM:SS ±HHMM" (day/month may be space padded)
  if (s.length < 20) return NaN;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) == 32) i++;
  const day = digits(s, i, 2);
  if (day < 1 || day > 31) return NaN;
  i += 2;
  if (s.charCodeAt(i) != 45) return NaN; // '-'
  i++;
  const month = monthOf(s.substring(i, i + 3));
  if (month < 0) return NaN;
  i += 3;
  if (s.charCodeAt(i) != 45) return NaN;
  i++;
  let year = digits(s, i, 4);
  if (year < 0) {
    // tolerate 2-digit years
    const yy = digits(s, i, 2);
    if (yy < 0) return NaN;
    year = yy >= 70 ? 1900 + yy : 2000 + yy;
    i += 2;
  } else {
    i += 4;
  }
  if (s.charCodeAt(i) != 32) return NaN;
  i++;
  const hh = digits(s, i, 2);
  if (s.charCodeAt(i + 2) != 58) return NaN;
  const mm = digits(s, i + 3, 2);
  if (s.charCodeAt(i + 5) != 58) return NaN;
  const ss = digits(s, i + 6, 2);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 60) return NaN;
  i += 8;
  while (i < s.length && s.charCodeAt(i) == 32) i++;
  let offsetMinutes = 0;
  if (i < s.length) {
    const sign = s.charCodeAt(i);
    const oh = digits(s, i + 1, 2);
    const om = digits(s, i + 3, 2);
    if (oh >= 0 && om >= 0 && oh <= 23 && om <= 59) {
      offsetMinutes = (sign == 45 ? -1 : 1) * (oh * 60 + om);
    }
  }
  const days = daysFromCivil(year, month + 1, day);
  const ms = <f64>days * 86400000.0 + <f64>(hh * 3600 + mm * 60 + ss - offsetMinutes * 60) * 1000.0;
  return ms;
}
