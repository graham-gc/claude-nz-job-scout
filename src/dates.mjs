// Dates and moments.
//
// The runtime keeps every comparison in one clock: Auckland's. A value that
// names a moment is compared as a moment; a value that names only a day is
// compared on the Auckland calendar. Nothing is read in the machine's own
// timezone, so the same evidence reads the same way wherever the scan runs,
// and the day a value names is never silently turned into UTC midnight.

export const AUCKLAND = 'Pacific/Auckland';

const clockParts = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: AUCKLAND, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(value));
const pick = (parts, type) => parts.find(p => p.type === type)?.value ?? '00';

// The Auckland calendar day of an instant: 'YYYY-MM-DD'.
export const nzDay = value => {
  const p = clockParts(value);
  return `${pick(p, 'year')}-${pick(p, 'month')}-${pick(p, 'day')}`;
};
// The Auckland wall clock of an instant: 'YYYY-MM-DDTHH:mm:ss'.
export const nzClock = value => {
  const p = clockParts(value);
  return `${pick(p, 'year')}-${pick(p, 'month')}-${pick(p, 'day')}T${pick(p, 'hour')}:${pick(p, 'minute')}:${pick(p, 'second')}`;
};
// The instant at which an Auckland wall clock reads that clock. A clock with no
// offset stated is the employer's own clock, and the employer's clock is read
// in Auckland's.
export function aucklandInstant(clock) {
  const text = String(clock ?? '').trim();
  const wanted = (text.length === 16 ? `${text}:00` : text).slice(0, 19);
  const want = Date.parse(`${wanted}Z`);
  if (!Number.isFinite(want)) return null;
  let stamp = want;
  for (let i = 0; i < 4; i++) {
    const observed = Date.parse(`${nzClock(stamp)}Z`);
    if (!Number.isFinite(observed)) return null;
    const drift = want - observed;
    if (!drift) break;
    stamp += drift;
  }
  // The clock has to exist in Auckland's calendar. On the morning the clocks
  // go forward, an hour of that day does not happen, and a value that names it
  // is not read as a moment — the runtime does not move it to the hour next to
  // it, which would make a deadline an hour earlier than the employer wrote.
  return nzClock(stamp) === wanted ? stamp : null;
}

// A calendar date that exists. 31 February is not a date, and a value that
// names one is not read as a day.
export function isoDay(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const stamp = Date.UTC(y, m - 1, d);
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A value that carries a time. Fractional seconds are part of the standard
// time format, not an anomaly, so they are read rather than refused.
const TIMESTAMP = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
export const looksLikeTimestamp = value => /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}(?::\d{2})?/.test(String(value ?? '').trim());

// A value that names a moment:
//   instant — a time and a timezone: the moment itself;
//   clock   — a time with no timezone: the employer's own clock;
//   day     — no time at all: a calendar day.
// A value that names a time that does not exist is invalid, and an invalid
// value is never read as a day.
export function parseMoment(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const m = text.match(TIMESTAMP);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, offset] = m;
  const day = isoDay(y, mo, d);
  if (!day) return { kind: 'invalid' };
  if (hh == null) return { kind: 'day', day };
  const H = Number(hh), M = Number(mm), S = Number(ss ?? 0);
  if (H > 23 || M > 59 || S > 59) return { kind: 'invalid' };
  const time = `${String(H).padStart(2, '0')}:${mm}:${String(ss ?? '00').padStart(2, '0')}`;
  if (!offset) return { kind: 'clock', clock: `${day}T${time}`, day };
  const zone = /^[+-]\d{4}$/.test(offset) ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset.toUpperCase();
  const stamp = Date.parse(`${day}T${time}${zone}`);
  if (!Number.isFinite(stamp)) return { kind: 'invalid' };
  return { kind: 'instant', stamp, day, clock: nzClock(stamp) };
}

// A numeric date: "12/11/2026", or the same date with a time, "12-11-2026
// 03:12". New Zealand writes the day first and US boards write the month
// first, so a numeric date has two possible readings unless one of its parts
// rules the other out. The reader returns every reading it can justify and
// never picks one to make a conclusion fit.
//
// A reading keeps the clock when the value names one: the clock decides
// whether a closing moment earlier today has already passed, and dropping it
// would turn a deadline that expired at 09:00 into one that is still open.
// A time that does not exist is not a date, and such a value is never read as
// a day.
const NUMERIC = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
export function parseNumeric(value) {
  const text = String(value ?? '').trim();
  const m = text.match(NUMERIC);
  if (!m) return null;
  const [, a, b, year, hh, mm, ss] = m;
  const H = hh == null ? null : Number(hh), M = Number(mm), S = Number(ss ?? 0);
  if (H !== null && (H > 23 || M > 59 || S > 59)) return { kind: 'invalid', reason: 'time' };
  const days = [...new Set([isoDay(year, b, a), isoDay(year, a, b)].filter(Boolean))];
  if (!days.length) return { kind: 'invalid', reason: 'date' };
  const candidates = days.map(day => ({
    day,
    clock: H === null ? null : `${day}T${String(H).padStart(2, '0')}:${mm}:${String(ss ?? '00').padStart(2, '0')}`,
  }));
  return { kind: 'numeric', candidates, ambiguous: candidates.length > 1 };
}

// The day a moment falls on, in Auckland's clock.
export const momentDay = moment => moment.kind === 'instant' ? nzDay(moment.stamp) : moment.day;
