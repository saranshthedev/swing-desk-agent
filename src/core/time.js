// India Standard Time helpers. IST is UTC+05:30 all year (no daylight saving).

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

export function indiaParts(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 = Sunday … 6 = Saturday
  };
}

export const indiaDate = (ms = Date.now()) => indiaParts(ms).date;

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the India week containing `ms`. */
export function indiaWeekStart(ms = Date.now()) {
  const p = indiaParts(ms);
  return addDays(p.date, -((p.weekday + 6) % 7));
}

/** UTC milliseconds for an India calendar date and minutes after India midnight. */
export function indiaTimeToMs(date, minutes) {
  return Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - IST_OFFSET_MS;
}

/** Calendar days from date `a` to date `b` (both YYYY-MM-DD). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function parseClock(text) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(text));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isDate(text) {
  return typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`));
}
