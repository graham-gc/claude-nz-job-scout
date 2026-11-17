import { hash } from './store.mjs';
import { key } from './evidence.mjs';
import { channelKind, closureBoundToAdvertisement, fieldIsEmployerPosting, isEmployerPosting, publicationDateIn, readDate, statedFacts, PUBLICATION_RANK, PUBLICATION_SEMANTICS } from './evidence.mjs';
import { foreignScope, isForeignPlace, nzLocality, nzPlace, remoteScope, REMOTE_ONLY } from './places.mjs';
import { aucklandInstant, looksLikeTimestamp, momentDay, nzClock, nzDay, parseMoment, parseNumeric } from './dates.mjs';

export const nzDate = value => nzDay(value);

const dayNumber = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const fields = new Set(['location', 'workArrangement', 'hoursPerWeek', 'engagement', 'contractType', 'duration', 'durationWeeks', 'durationMonths', 'startAt', 'endAt', 'workRights']);
export function criteria(input) {
  if (!input || !Array.isArray(input.roleFamilies) || !input.roleFamilies.length || input.roleFamilies.some(x => typeof x !== 'string' || !x.trim())) throw new Error('roleFamilies must contain the requested role families');
  const disclosures = [];
  const location = input.location ?? { country: 'New Zealand', onsiteCities: [], remoteOutside: true };
  if (!input.location) disclosures.push('No location supplied: the region is evaluated at country level (New Zealand), without assuming a city. Supply onsiteCities for city-level matching.');
  const result = { roleFamilies: input.roleFamilies, postingDays: input.postingDays ?? 7,
    location: { country: location.country ?? 'New Zealand', onsiteCities: location.onsiteCities ?? [], remoteOutside: location.remoteOutside !== false },
    all: input.all ?? [], any: input.any ?? [], preferences: input.preferences ?? [], exclusions: input.exclusions ?? [],
    includeTalentPools: input.includeTalentPools === true, disclosures };
  if (!Number.isInteger(result.postingDays) || result.postingDays < 1 || result.postingDays > 365) throw new Error('postingDays must be 1–365');
  if (result.location.country !== 'New Zealand') throw new Error('location needs country New Zealand');
  if (!Array.isArray(result.location.onsiteCities) || result.location.onsiteCities.some(c => typeof c !== 'string' || !c.trim())) throw new Error('location.onsiteCities must be a list of city names (may be empty)');
  if (typeof result.location.remoteOutside !== 'boolean') throw new Error('location needs country New Zealand, onsiteCities and remoteOutside');
  if (!Array.isArray(result.all) || !Array.isArray(result.any) || result.any.some(g => !Array.isArray(g) || !g.length)) throw new Error('all is a list of conditions; any is a list of nonempty alternative condition lists');
  for (const c of [...result.all, ...result.any.flat()]) {
    if (!c || !fields.has(c.field) || !['eq', 'in', 'lte', 'gte', 'contains'].includes(c.op) || c.value == null) throw new Error('Invalid condition: see references/input.md for fields and operators');
    if (c.op === 'in' && (!Array.isArray(c.value) || !c.value.length)) throw new Error('in requires a nonempty array');
    if (['lte', 'gte'].includes(c.op) && typeof c.value !== 'number' && !/^\d{4}-\d{2}-\d{2}$/.test(c.value)) throw new Error('lte/gte require a number or ISO date');
    if (['duration', 'durationWeeks', 'durationMonths'].includes(c.field) && c.valueUnit && !['weeks', 'months'].includes(c.valueUnit)) throw new Error('valueUnit must be weeks or months');
  }
  if (!result.location.onsiteCities.length) disclosures.push('location.onsiteCities is empty: no city is treated as a conflict.');
  return result;
}
export const contextHash = (criteria, resumeHash) => hash({ criteria, resumeHash });
const verdict = (name, status, detail) => ({ name, status, detail });

// Duration keeps its own unit. Weeks are never converted into months, or months into weeks.
export function durationValue(record, field) {
  const d = record.fields.duration?.value;
  if (!d || typeof d !== 'object') return { amount: null, unit: null };
  if (field === 'durationWeeks') return d.unit === 'weeks' ? { amount: d.amount, unit: 'weeks' } : { amount: null, unit: d.unit };
  if (field === 'durationMonths') return d.unit === 'months' ? { amount: d.amount, unit: 'months' } : { amount: null, unit: d.unit };
  return { amount: d.amount, unit: d.unit };
}
export function condition(record, c) {
  const name = c.label ?? c.field;
  if (['duration', 'durationWeeks', 'durationMonths'].includes(c.field)) {
    const { amount, unit } = durationValue(record, c.field);
    if (amount == null) return verdict(name, 'unknown', `duration not stated in the requested unit (${unit ?? 'none stated'}); no conversion is applied`);
    const wanted = c.valueUnit ?? (c.field === 'durationMonths' ? 'months' : 'weeks');
    if (unit !== wanted) return verdict(name, 'unknown', `${amount} ${unit} stated; the condition is expressed in ${wanted}; no conversion is applied`);
    const pass = c.op === 'lte' ? amount <= c.value : c.op === 'gte' ? amount >= c.value : c.op === 'eq' ? amount === c.value : String(amount).includes(String(c.value));
    return verdict(name, pass ? 'satisfied' : 'conflict', `${amount} ${unit} ${c.op} ${JSON.stringify(c.value)}`);
  }
  const v = record.fields[c.field]?.value;
  if (v == null) return verdict(name, 'unknown', `${c.field} not stated/read`);
  const pass = c.op === 'eq' ? key(v) === key(c.value) : c.op === 'in' ? c.value.some(x => key(x) === key(v))
    : c.op === 'contains' ? key(v).includes(key(c.value)) : c.op === 'lte' ? v <= c.value : v >= c.value;
  return verdict(name, pass ? 'satisfied' : 'conflict', `${v} ${c.op} ${JSON.stringify(c.value)}`);
}

// A posting that names a place outside the requested country has stated its
// location, so it is a conflict rather than an unknown. A posting that names
// only "Remote" has not stated where it hires, so it stays unknown. A remote
// posting that names its own scope ("Remote (US)", "Remote, Latin America")
// has stated where it hires too.
export function locationVerdict(record, config) {
  const location = (record.fields.location?.value ?? '').trim();
  const arrangement = record.fields.workArrangement?.value;
  if (!location) return verdict('Location', 'unknown', 'Job location not stated/read');
  if (isForeignPlace(location)) return verdict('Location', 'conflict', `Location outside New Zealand: ${location}`);
  if (REMOTE_ONLY.test(location)) return verdict('Location', 'unknown', `Remote only; the posting does not state whether the employer hires in ${config.location.country}`);
  const scope = remoteScope(location);
  if (scope) {
    if (nzPlace(scope)) return verdict('Location', 'satisfied', `${location}; remote work covers ${scope}`);
    const outside = foreignScope(scope);
    if (outside) return verdict('Location', 'conflict', `Remote work is limited to ${scope}; it does not cover ${config.location.country}`);
    return verdict('Location', 'unknown', `Remote scope "${scope}" is not a recognised hiring region; treated as unknown, not as a match`);
  }
  if (!nzPlace(location)) return verdict('Location', 'unknown', `Region not parsed from "${location}"; treated as unknown, not as a match`);
  const cities = config.location.onsiteCities ?? [];
  if (!cities.length) return verdict('Location', 'satisfied', `In ${config.location.country} and no specific city was requested: ${location}`);
  const inCity = cities.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()}\\b`, 'i').test(location));
  if (inCity) return verdict('Location', 'satisfied', location);
  if (arrangement === 'remote' && config.location.remoteOutside) return verdict('Location', 'satisfied', `${location}; role is stated as remote and remote work is allowed`);
  // The country alone says where the employer hires, not in which city:
  // "Aotearoa" does not prove "not in Auckland", so it stays unknown.
  if (!nzLocality(location)) return verdict('Location', 'unknown', `Only the country is stated ("${location}"); no city is named, so the posting is not proved to be outside ${cities.join(', ')}`);
  return verdict('Location', 'conflict', `In ${config.location.country} but not in the requested cities (${cities.join(', ')}): ${location}`);
}

// Only these semantics say the page itself calls the value a deadline. A
// validity window (`validThrough`) does not, and an ambiguous value cannot be
// promoted into one.
export const DEADLINE_SEMANTICS = ['deadline', 'deadline-date'];

// The claims a field carries: the value the reader kept and every value it
// set beside it. A fact that was displaced is kept, never dropped, so the
// check can judge what was actually seen.
function fieldClaims(field) {
  const list = [];
  if (field?.value != null) list.push({ value: field.value, semantics: field.semantics, source: field.source, origin: field.origin, quote: field.quote });
  for (const alt of field?.ambiguity ?? []) list.push({ value: alt.value, semantics: alt.semantics, source: alt.source, origin: alt.origin, quote: alt.quote });
  return list;
}

// The publication window is judged on every reading the value allows. When the
// readings disagree — one inside the window, one outside — the status stays
// unknown: the reader does not pick a reading to make a conclusion fit.
//
// A value that names a moment is compared as a moment, in Auckland's clock. A
// value that names only a day is compared on the Auckland calendar, so a
// publication date is never read as UTC midnight.
//
// The claims a posting makes are read against each other, because they say
// different things. A claim that states when the role first appeared
// ("first advertised", a JobPosting's datePosted) and a claim that states the
// date of one advertisement of it ("Posted 16/11") can both be true of the
// same role: the second is a republication of the first. They contradict each
// other only when the order is the other way round, and a posting that
// contradicts itself is not resolved by picking one of its dates — the status
// stays unknown, which is neither "recent" nor "stale".
//
// Which page a claim came from decides what it may be used for. The employer's
// own posting governs: it is the page the run verified, and it is the page
// that speaks for the vacancy. A mirror's claim speaks for that mirror, and
// it is used only when the employer's own posting states no publication date
// at all.
export function publicationVerdict(posted, config, now, record = null) {
  const claims = fieldClaims(posted).filter(c => PUBLICATION_SEMANTICS.includes(c.semantics));
  if (!claims.length) {
    return verdict('Recent publication', 'unknown', posted?.value ? `${posted.semantics}: ${posted.value}; not first-publication evidence` : 'First-publication date not stated/read');
  }
  const today = nzDate(now);
  const employer = claims.filter(c => fieldIsEmployerPosting(c, record));
  const pool = employer.length ? employer : claims;
  const readings = pool.map(claim => readClaim(claim, config, now, today));
  const unreadable = readings.find(r => r.kind === 'unreadable');
  if (unreadable) {
    return verdict('Recent publication', 'unknown', `${unreadable.claim.value} (${unreadable.claim.semantics}) could not be read as a date`);
  }
  const first = readings.filter(r => r.claim.semantics === 'first-published');
  const advertised = readings.filter(r => r.claim.semantics === 'advertised-date');
  if (first.length) {
    // The first appearance is what the posting says it is.
    const earliest = Math.min(...first.map(r => Math.min(...r.days.map(day => dayNumber(day)))));
    const named = first.map(r => `${r.claim.value} (${r.claim.semantics})`).join('; ');
    const firstDays = new Set(first.map(r => r.days.map(d => dayNumber(d)).sort().join('|')));
    if (firstDays.size > 1) {
      return verdict('Recent publication', 'unknown', `the posting states more than one first-publication date (${named}); which one is the first appearance is not established`);
    }
    // A republication is later than the first appearance. A publication date
    // that precedes it contradicts the posting's own account of when the role
    // first appeared.
    const earlier = advertised.find(r => Math.min(...r.days.map(day => dayNumber(day))) < earliest);
    if (earlier) {
      return verdict('Recent publication', 'unknown', `the posting states the role was first advertised on ${first[0].claim.value} and published on ${earlier.claim.value}; the two statements do not agree on when it first appeared`);
    }
    const governing = first.find(r => Math.min(...r.days.map(d => dayNumber(d))) === earliest) ?? first[0];
    return verdict('Recent publication', governing.status, readingDetail(governing));
  }
  // No claim states a first appearance, so the earliest advertisement date is
  // the first appearance: a later one is a republication of it.
  const governing = advertised.reduce((a, b) => (earliestDay(b) < earliestDay(a) ? b : a), advertised[0]);
  return verdict('Recent publication', governing.status, readingDetail(governing));
}

// The day a claim names, for ordering claims against each other.
const earliestDay = reading => Math.min(...reading.days.map(day => dayNumber(day)));
// What a claim says about the window, in the reader's own words.
function readingDetail(reading) {
  const claim = reading.claim;
  if (reading.days.length > 1) {
    const status = reading.status;
    return `${claim.value} (${claim.semantics}) reads as ${reading.days.join(' or ')}; ${status === 'conflict' ? 'every reading is outside the window' : status === 'satisfied' ? 'every reading is inside the window' : 'the readings disagree about the window'}`;
  }
  return `${claim.value} (${claim.semantics})`;
}

// One claim, read and judged on every reading it allows.
function readClaim(claim, config, now, today) {
  const value = String(claim.value ?? '');
  const moment = parseMoment(value);
  if (moment && moment.kind !== 'day') {
    if (moment.kind === 'invalid') return { claim, kind: 'unreadable', days: [], status: 'unknown' };
    const stamp = moment.kind === 'instant' ? moment.stamp : aucklandInstant(moment.clock);
    if (stamp == null) return { claim, kind: 'unreadable', days: [], status: 'unknown' };
    const age = (Date.parse(now) - stamp) / 86400000;
    return { claim, kind: 'moment', days: [momentDay(moment)], status: age < 0 ? 'unknown' : age <= config.postingDays ? 'satisfied' : 'conflict' };
  }
  const { readings } = readDate(value);
  if (!readings.length) return { claim, kind: 'unreadable', days: [], status: 'unknown' };
  const ages = readings.map(day => dayNumber(today) - dayNumber(day));
  const inside = ages.every(a => a >= 0 && a <= config.postingDays);
  const outside = ages.every(a => a > config.postingDays);
  return { claim, kind: 'day', days: readings, status: inside ? 'satisfied' : outside ? 'conflict' : 'unknown' };
}

// The publication date as a reference point for comparing a closing value. A
// publication date that names only a day covers that whole day, so a closing
// later the same day does not precede it.
//
// When the posting states several publication dates, the earliest is the
// reference: the posting cannot have appeared before it first appeared, so a
// closing that precedes even that date is contradictory evidence.
function publicationReference(postedAt) {
  const claims = fieldClaims(postedAt).filter(c => PUBLICATION_SEMANTICS.includes(c.semantics));
  if (!claims.length) return null;
  const moments = [];
  for (const claim of claims) {
    const moment = parseMoment(String(claim.value ?? ''));
    if (moment && moment.kind !== 'invalid') { moments.push(moment); continue; }
    const { readings } = readDate(String(claim.value ?? ''));
    if (readings.length === 1) moments.push({ kind: 'day', day: readings[0] });
  }
  if (!moments.length) return null;
  const stamps = moments.map(m => m.kind === 'day' ? Date.parse(`${m.day}T00:00:00Z`) : (m.kind === 'instant' ? m.stamp : aucklandInstant(m.clock))).filter(Number.isFinite);
  if (!stamps.length) return moments[0];
  const earliest = Math.min(...stamps);
  const chosen = moments.find(m => (m.kind === 'day' ? Date.parse(`${m.day}T00:00:00Z`) : (m.kind === 'instant' ? m.stamp : aucklandInstant(m.clock))) === earliest);
  return chosen ?? moments[0];
}

// Whether a closing value precedes the publication date it belongs to.
function beforePublication(moment, publication) {
  if (!publication || !moment) return false;
  if (publication.kind === 'day') {
    // A publication date that names a day covers that day.
    return momentDay(moment) < publication.day;
  }
  const published = publication.kind === 'instant' ? publication.stamp : aucklandInstant(publication.clock);
  const closes = moment.kind === 'instant' ? moment.stamp : moment.kind === 'clock' ? aucklandInstant(moment.clock) : aucklandInstant(`${moment.day}T00:00:00`);
  if (published == null || closes == null) return false;
  return closes < published;
}

// Where a closing moment stands against now, and against the posting's own
// publication date: 'expired', 'open', 'before-publication' or 'too-far'.
export function closingStanding(moment, postedAt, now) {
  const nowStamp = Date.parse(now);
  const publication = publicationReference(postedAt);
  if (beforePublication(moment, publication)) return 'before-publication';
  if (moment.kind === 'instant') {
    if (moment.stamp - nowStamp > 366 * 86400000) return 'too-far';
    return moment.stamp < nowStamp ? 'expired' : 'open';
  }
  if (moment.clock > nzClock(new Date(nowStamp + 366 * 86400000))) return 'too-far';
  return moment.clock < nzClock(now) ? 'expired' : 'open';
}

// A closing value can name a day or a moment. A value with an explicit time
// and an explicit timezone is an instant and is compared as one. A value with
// a time but no timezone is the employer's own clock, and the runtime's day
// boundary is Auckland's, so it is read and compared in that clock. Only a
// plain date is compared on the calendar — otherwise a closing moment earlier
// today would pass as "today" and the advertisement would stay open.
export function closingMoment(value) {
  const moment = parseMoment(value);
  if (moment && moment.kind !== 'invalid' && moment.kind !== 'day') return moment;
  // A numeric date with a clock is read on the reading that survives: "25-12-
  // 2026 03:12" cannot be month first, so the day and the time are known. A
  // value with two readings names no single moment and is judged on both.
  const numeric = parseNumeric(value);
  if (numeric?.kind === 'numeric' && !numeric.ambiguous && numeric.candidates[0].clock) {
    return { kind: 'clock', clock: numeric.candidates[0].clock, day: numeric.candidates[0].day };
  }
  return null;
}

// A closing date can close a role only when the evidence establishes what it
// is and what day it names. The page must call it a deadline, and the value
// must be readable without choosing between two days. A value with two
// readings is only expired when every reading is in the past; when the
// readings disagree, the status is "meaning ambiguous", never "expired".
//
// A validity window is a third thing. Google's JobPosting schema gives
// `validThrough` one meaning: "the date when the job posting will expire". On
// the employer's own posting that is the employer's own statement, and a
// moment in the past closes the advertisement. On a mirror or an aggregator
// the same value speaks for that advertisement alone, and an ambiguous value
// speaks for nothing, so it stays pending verification.
//
// Which page a value came from decides what it may be used for. A fact read
// from a mirror keeps speaking for the mirror even after the record is joined
// to the employer's own posting.
// A deadline that is not the employer's own statement does not close the
// employer's role. A mirror that says "applications closed on 12 November"
// speaks for that advertisement; whether the employer's vacancy is still open
// is decided by the employer's own posting, and until that page is read the
// state of the vacancy stays unknown rather than closed.
const unconfirmedDeadline = value => ({ ...verdict('Closing date', 'unknown', `The closing date (${value}) is stated on a page that is not the employer's own posting; it is pending verification against the employer's original posting`), advisory: true });

export function closingVerdict(closing, postedAt, now, options = {}) {
  const record = options.record ?? null;
  const claims = fieldClaims(closing);
  if (!claims.length) return null;
  const employer = claims.filter(c => fieldIsEmployerPosting(c, record));
  const pool = employer.length ? employer : claims;
  const distinct = [...new Set(pool.map(c => String(c.value)))];
  if (distinct.length > 1) {
    return { ...verdict('Closing date', 'unknown', `The closing value reads differently across sources (${distinct.join(' / ')}); its meaning is ambiguous — pending verification against the employer's original posting`), advisory: true };
  }
  const claim = pool[0];
  const value = String(claim.value);
  const semantics = claim.semantics;
  const authoritative = employer.length > 0;
  // A numeric value whose time or whose date does not exist is not read as a
  // date. It is kept and reported as unreadable, never turned into an expiry
  // and never dropped so that the advertisement looks open.
  const numeric = parseNumeric(value);
  if (numeric?.kind === 'invalid') {
    const what = numeric.reason === 'time' ? 'the time it names is not a valid time' : 'the date it names is not a real date';
    const label = semantics === 'valid-through' ? 'validity window' : 'deadline';
    return { ...verdict('Closing date', 'unknown', `Unconfirmed ${label} retained: ${value}; ${what}, so it is not read as a date and not used for expiry`), advisory: true };
  }
  if (!DEADLINE_SEMANTICS.includes(semantics)) {
    if (semantics === 'valid-through' && authoritative) {
      const moment = closingMoment(value);
      if (moment) {
        const standing = closingStanding(moment, postedAt, now);
        if (standing === 'before-publication') return { ...verdict('Closing date', 'unknown', `Unconfirmed validity window retained: ${value}; it precedes the stated publication date`), advisory: true };
        if (standing === 'too-far') return { ...verdict('Closing date', 'unknown', `Unconfirmed validity window retained: ${value}; too far ahead to be a closing date`), advisory: true };
        if (standing === 'expired') return verdict('Closing date', 'conflict', `The employer's own posting states the advertisement is valid until ${value} (valid-through); that moment has passed`);
        return null;
      }
      const { readings } = readDate(value);
      if (!readings.length) return { ...verdict('Closing date', 'unknown', `Unconfirmed validity window retained: ${value}; it is not read as a date and is not used for expiry`), advisory: true };
      if (readings.length > 1) return { ...verdict('Closing date', 'unknown', `The validity window (${value}) reads as two different days (${readings.join(' or ')}); its meaning is ambiguous — pending verification against the employer's original posting`), advisory: true };
      const today = nzDate(now);
      if (readings[0] >= today) return null;
      const publication = publicationReference(postedAt);
      if (publication && readings[0] < publication.day) return { ...verdict('Closing date', 'unknown', `Unconfirmed validity window retained: ${value}; it precedes the stated publication date`), advisory: true };
      return verdict('Closing date', 'conflict', `The employer's own posting states the advertisement is valid until ${value} (valid-through); that date has passed`);
    }
    return { ...verdict('Closing date', 'unknown', `The page carries a ${semantics ?? 'unstated'} value (${value}); what it denotes is not established — pending verification against the employer's original posting`), advisory: true };
  }
  const moment = closingMoment(value);
  if (moment) {
    const standing = closingStanding(moment, postedAt, now);
    if (standing === 'before-publication') return { ...verdict('Closing date', 'unknown', `Unconfirmed deadline retained: ${value}; it precedes the stated publication date`), advisory: true };
    if (standing === 'too-far') return { ...verdict('Closing date', 'unknown', `Unconfirmed deadline retained: ${value}; too far ahead to be a deadline`), advisory: true };
    if (standing !== 'expired') return null;
    return authoritative ? verdict('Closing date', 'conflict', `Deadline has passed: ${value}`) : unconfirmedDeadline(value);
  }
  const { readings } = readDate(value);
  if (!readings.length) {
    const stated = looksLikeTimestamp(value)
      ? `Unconfirmed deadline retained: ${value}; the time it names is not a valid time, so it is not read as a date and not used for expiry`
      : `Unconfirmed deadline retained: ${value}; not used for urgency or open status`;
    return { ...verdict('Closing date', 'unknown', stated), advisory: true };
  }
  const today = nzDate(now);
  const past = readings.map(day => day < today);
  if (past.every(Boolean)) {
    const publication = publicationReference(postedAt);
    if (readings.length === 1 && publication && readings[0] < publication.day) {
      return { ...verdict('Closing date', 'unknown', `Unconfirmed deadline retained: ${value}; it precedes the stated publication date`), advisory: true };
    }
    return authoritative ? verdict('Closing date', 'conflict', `Deadline has passed: ${value}`) : unconfirmedDeadline(value);
  }
  if (past.some(Boolean)) {
    return { ...verdict('Closing date', 'unknown', `The deadline value (${value}) reads as two different days (${readings.join(' or ')}); its meaning is ambiguous — pending verification against the employer's original posting`), advisory: true };
  }
  if (readings.length === 1) {
    const ms = Date.parse(`${readings[0]}T00:00:00Z`);
    if (ms - Date.parse(now) > 366 * 86400000) return { ...verdict('Closing date', 'unknown', `Unconfirmed deadline retained: ${value}; too far ahead to be a deadline`), advisory: true };
  }
  return null;
}

export function hardChecks(record, config, now) {
  const f = record.fields, checks = [];
  checks.push(locationVerdict(record, config));
  checks.push(publicationVerdict(f.postedAt, config, now, record));
  if (f.closesAt?.value) {
    const closing = closingVerdict(f.closesAt, f.postedAt, now, { record });
    if (closing) checks.push(closing);
  }
  checks.push(...config.all.map(c => condition(record, c)));
  if (config.any.length) {
    const alternatives = config.any.map(group => group.map(c => condition(record, c)));
    checks.push(verdict('Work/availability alternatives', alternatives.some(g => g.every(c => c.status === 'satisfied')) ? 'satisfied'
      : alternatives.every(g => g.some(c => c.status === 'conflict')) ? 'conflict' : 'unknown', alternatives));
  }
  return checks;
}

// The model may point at a fact the posting itself states that the reader did
// not lift into a field. The runtime verifies the pointer against the page
// and judges it: the model supplies the quotation, never the fact.
export const DISQUALIFIER_KINDS = ['publication-outside-window', 'engagement-outside-availability'];
export function verifyDisqualifiers(record, config, judgment, now) {
  const verified = [];
  const duties = record.fields.duties?.value ?? '';
  for (const claim of judgment?.disqualifiers ?? []) {
    if (!claim || typeof claim.quote !== 'string' || !duties.includes(claim.quote)) continue;
    if (claim.kind === 'publication-outside-window') {
      // The reader's own publication date decides when it decided. A
      // quotation fills a gap; it never overrules a fact the run already
      // recorded, and a quotation whose date is not bound to the publication
      // wording proves nothing.
      //
      // It does not settle a contradiction either. When the posting itself
      // states two publication dates, the runtime cannot know which one is
      // the first appearance, and a quotation that points at one of them
      // would be choosing the reading that produces a conclusion.
      const recorded = publicationVerdict(record.fields.postedAt, config, now, record);
      if (recorded.status === 'satisfied' || recorded.status === 'conflict') continue;
      const recordedClaims = fieldClaims(record.fields.postedAt).filter(c => PUBLICATION_SEMANTICS.includes(c.semantics));
      if (recordedClaims.length) continue;
      const { readings } = publicationDateIn(claim.quote);
      if (!readings.length) continue;
      const today = nzDate(now);
      const ages = readings.map(day => dayNumber(today) - dayNumber(day));
      // Every reading must be outside the window: a claim that only holds for
      // one of two possible readings is not a fact.
      if (!ages.every(a => a > config.postingDays)) continue;
      verified.push({ name: 'Publication date stated in the posting', detail: `The posting states a publication date outside the requested ${config.postingDays}-day window: "${claim.quote}"` });
      continue;
    }
    if (claim.kind === 'engagement-outside-availability') {
      const facts = statedFacts(claim.quote);
      if (!Object.keys(facts).length) continue;
      const merged = { ...record, fields: { ...record.fields, ...facts } };
      const alternatives = config.any.map(group => group.map(c => condition(merged, c)));
      if (!alternatives.length || !alternatives.every(group => group.some(c => c.status === 'conflict'))) continue;
      verified.push({ name: 'Engagement stated in the posting', detail: `The posting states an engagement outside the requested availability alternatives: "${claim.quote}"` });
    }
  }
  return verified;
}

// The checks a record carries, including the ones the model's quotation
// proved. A verified disqualifier is a hard condition under its own name, so
// a date exclusion is never reported as a responsibility mismatch.
export function checksWithJudgment(record, config, judgment, now) {
  const checks = hardChecks(record, config, now);
  const verified = verifyDisqualifiers(record, config, judgment, now);
  for (const v of verified) checks.push(verdict(v.name, 'conflict', v.detail));
  return { checks, verified };
}

// A recruitment channel that addresses employers is not a vacancy and not a
// talent pool. It is recognised from the page's own text, so the rule holds
// for every record whose body has been read.
export const isChannel = record => record.opportunityKind?.value === 'employer-channel' || Boolean(channelKind(record.fields.duties?.value ?? ''));

// An exclusion names the condition that excluded it. A role dropped because
// its publication date is out of the window is never reported as a
// responsibility mismatch, and the reverse is never true either.
const conflictNames = checks => [...new Set(checks.filter(c => c.status === 'conflict').map(c => c.name))].join(', ');

export function classify(record, config, judgment, now) {
  const { checks } = checksWithJudgment(record, config, judgment, now);
  // A closure closes the vacancy only when the employer said so, on the
  // employer's own posting. A mirror that says "this job has expired" proves
  // that mirror advertisement expired and says nothing about the employer's
  // role, so it stays out of the recommendation area without being called closed.
  if (record.closure) {
    const bound = record.closure.scope === 'employer-posting' || closureBoundToAdvertisement(record, record.closure.source?.url);
    if (bound) return { category: 'closed', checks, reason: `${record.closure.scope} explicitly closed` };
    return { category: 'mirror-expired', checks, reason: 'Only the mirror advertisement states it has expired; the employer vacancy status remains unknown, not confirmed closed' };
  }
  // An identity anomaly is neither a recommendation nor a high-value lead.
  if (record.anomalies?.length || record.identityConflict) return { category: 'identity-anomaly', checks, reason: 'Identity could not be resolved across sources; not recommended' };
  // An employer-facing recruitment channel is not a vacancy and not a talent
  // pool. It is disclosed as a channel to follow up; it never becomes a
  // recommendation, and a candidate-side entry point on it is never taken for
  // a verified application route.
  if (isChannel(record)) return { category: 'channel', checks, reason: 'Employer-facing recruitment channel: the page addresses employers and the candidate-side entry point is not verified — a channel to check, not a job recommendation' };
  if (record.opportunityKind?.value === 'talent-pool') {
    // Allowing talent pools is not allowing every talent pool. A pool is
    // still bound by the hard conditions and by the duty match: a pool in
    // another country, or one whose responsibilities were never assessed,
    // is not a lead and never enters the recommendation area.
    if (!config.includeTalentPools) return { category: 'excluded', checks, reason: 'Expression of interest/talent pool, not a confirmed vacancy' };
    if (checks.some(x => x.status === 'conflict')) return { category: 'excluded', checks, reason: `Talent pool conflicts with a hard condition: ${conflictNames(checks)}` };
    if (!judgment) return { category: 'excluded', checks, reason: 'Talent pool without a responsibility assessment' };
    if (judgment.fit === 'weak') return { category: 'excluded', checks, reason: 'Talent pool responsibilities do not match' };
    return { category: 'pool', checks, reason: 'Expression of interest/talent pool, not a confirmed vacancy' };
  }
  if (checks.some(x => x.status === 'conflict')) return { category: 'excluded', checks, reason: `Known hard-condition conflict: ${conflictNames(checks)}` };
  if (!judgment) return { category: 'unassessed', checks, reason: 'No responsibility assessment' };
  if (judgment.fit === 'weak') return { category: 'excluded', checks, reason: 'Responsibilities do not match' };
  if (record.readState !== 'read' || record.authority !== 'registered-official' || !record.fields.employer?.value || !record.fields.title?.value) return { category: 'unresolved', checks, reason: 'Primary vacancy not fully read or employer association/identity unconfirmed' };
  if (checks.some(x => x.status === 'unknown' && !x.advisory) || record.application.status !== 'verified') return { category: 'check', checks, reason: 'Missing hard-condition evidence or unverified application route' };
  return { category: 'ready', checks, reason: 'All required checks and application route verified' };
}
