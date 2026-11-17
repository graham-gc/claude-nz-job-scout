import { load, decodeEntities } from './html.mjs';
import { hash } from './store.mjs';
import { isoDay, looksLikeTimestamp, parseMoment, parseNumeric } from './dates.mjs';
import { publicUrl } from './net.mjs';
import { placeFragment } from './places.mjs';
import { tenantOf, adIdentity } from './site.mjs';

export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const key = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Local canonicalisation never performs network-level validation. History files and
// model-reported URLs may be malformed; a bad entry must not abort a scan.
export function canonicalLocal(value) {
  let u;
  try { u = new URL(String(value ?? '')); } catch { return null; }
  u.hash = '';
  for (const p of [...u.searchParams.keys()]) if (/^(utm_.+|refId|trackingId|position|pageNum|oga|origin|trk)$/i.test(p)) u.searchParams.delete(p);
  if (/^(www|nz)\.linkedin\.com$/.test(u.hostname)) {
    const id = u.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)\/?$/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
  }
  return u.toString();
}
export function canonical(value) {
  const u = publicUrl(value); u.hash = '';
  for (const p of [...u.searchParams.keys()]) if (/^(utm_.+|refId|trackingId|position|pageNum|oga|origin|trk)$/i.test(p)) u.searchParams.delete(p);
  if (/^(www|nz)\.linkedin\.com$/.test(u.hostname)) {
    const id = u.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)\/?$/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
  }
  return u.toString();
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•',
  middot: '·', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', pound: '£', euro: '€',
  yen: '¥', deg: '°', laquo: '«', raquo: '»', times: '×', divide: '÷', dash: '–' };
export { decodeEntities };
// Only tag-shaped markup is removed, so a literal "< $50k" survives.
export const stripTags = text => String(text ?? '').replace(/<\/?[a-z][^>]*>/gi, ' ');
// One normalised body for the whole runtime: entities decoded and tags stripped until stable.
// Raw responses stay on disk as snapshots, so normalisation never destroys traceability.
export function normaliseText(value) {
  let text = String(value ?? '');
  for (let i = 0; i < 4; i++) {
    const next = stripTags(decodeEntities(text)).replace(/\s+/g, ' ').trim();
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, ' ').trim();
}

// A publication timestamp is strengthened by the kind of evidence, not by the
// order it was read in. A page that states when the role was first advertised
// replaces an API timestamp that only says "last published". Every claim that
// disagrees with the one kept is kept beside it as an ambiguity, so nothing is
// dropped and nothing is decided by read order: two publication dates that
// disagree are a contradiction the check must see, not a detail it may lose.
export const SEMANTICS_WEIGHT = {
  'first-published': 4, 'advertised-date': 3, 'deadline': 3, 'deadline-date': 3,
  'platform-created': 2, 'valid-through': 2, 'last-published': 1, 'updated': 0, 'reposted': 0
};
const POSTED_STRENGTH = SEMANTICS_WEIGHT;
// The day a publication value names, for ordering two claims of the same kind.
// The earliest reading is used: a value that reads two ways is ordered by the
// day it could be earliest, so which claim is kept never depends on the
// reading the reader would prefer.
export function publicationOrderKey(value) {
  const { readings } = readDate(String(value ?? ''));
  if (!readings.length) return null;
  return [...readings].sort()[0];
}
export function setPostedAt(fields, value, response, quote, semantics) {
  if (value == null || value === '') return;
  const strength = POSTED_STRENGTH[semantics] ?? 1;
  const current = fields.postedAt;
  if (!current || current.value == null) { fields.postedAt = fact(value, response, quote, semantics); return; }
  const currentStrength = POSTED_STRENGTH[current.semantics] ?? 1;
  const same = String(current.value) === String(value);
  // A claim that agrees with the one kept adds nothing; the wording that
  // carried it is already on the fact.
  if (same && currentStrength >= strength) return;
  const source = { url: response?.url, observedAt: response?.observedAt, snapshot: response?.snapshot };
  const incoming = { value, semantics, source, quote: clean(quote) };
  const displaced = same ? null : { value: current.value, semantics: current.semantics, source: current.source, quote: current.quote, origin: current.origin };
  if (currentStrength > strength) {
    // The weaker reading stays on the record as an ambiguity.
    current.ambiguity = [...(current.ambiguity ?? []), incoming];
    return;
  }
  if (currentStrength === strength) {
    // Two claims of the same kind: the earlier one is the first appearance, and
    // it is kept whichever order the pages were read in. The later one stays
    // beside it as the republication it is.
    const earlier = publicationOrderKey(value), later = publicationOrderKey(current.value);
    if (!(earlier && later && earlier < later)) {
      current.ambiguity = [...(current.ambiguity ?? []), incoming];
      return;
    }
  }
  const stronger = fact(value, response, quote, semantics);
  stronger.ambiguity = [...(current.ambiguity ?? []), ...(displaced ? [displaced] : [])];
  fields.postedAt = stronger;
}

export const fact = (value, response, quote = value, semantics) => value === null || value === undefined || value === ''
  ? { value: null, absence: 'not-stated-on-page', source: { url: response?.url, observedAt: response?.observedAt, snapshot: response?.snapshot } }
  : { value, source: { url: response?.url, observedAt: response?.observedAt, snapshot: response?.snapshot }, quote: clean(typeof quote === 'object' ? JSON.stringify(quote) : quote), ...(semantics ? { semantics } : {}) };
export const textOf = html => { const $ = load(String(html ?? '')); $('script,style,nav,footer').remove(); return normaliseText($.root().text()); };

export function newRecord(lead, run) {
  const canonicalUrl = canonicalLocal(lead.url) ?? String(lead.url ?? '');
  return { recordId: hash(run + canonicalUrl).slice(0, 24), canonicalUrl, aliases: [canonicalUrl],
    provider: lead.provider ?? 'html', account: lead.account ?? '', authority: lead.authority ?? 'discovery-only',
    lead: { title: lead.title ?? '', employer: lead.employer ?? '', discoveredFrom: lead.discoveredFrom ?? lead.url },
    ids: { advertisement: lead.advertisement ?? null, apiPosting: lead.apiPosting ?? null, platformJob: null, requisition: null },
    fields: {}, readState: 'not-read', closure: null, application: { status: 'not-checked', reason: 'Not checked' },
    // Every body the record has read is kept, with the document it came from.
    bodies: [],
    detailUrl: lead.detailUrl ?? null, applicationUrl: lead.applicationUrl ?? null, sourceKey: lead.sourceKey ?? 'unattributed',
    // A relative publication wording ("20 hours ago") is kept as it was written,
    // with its source and observation time. It is never turned into a date.
    relativePublication: lead.relativePublication ?? null,
    conflicts: [], anomalies: [], association: lead.association ?? null };
}

// ---------------------------------------------------------------------------
// Declaration-anchored fact extraction.
// A term is only a fact when the sentence around it actually declares it.
// A first-hit keyword scan over the whole body is not evidence.
// ---------------------------------------------------------------------------
const sentences = text => String(text ?? '').split(/(?<=[.!?;:])\s+|\s*\|\s*|\n+/).map(s => clean(s)).filter(s => s.length > 3);
const NEGATED = /\b(?:not|never|no longer|without|non|cannot|will not|won't|isn't|aren't|non-)\b/i;
const REJECTED_PHRASES = { engagement: /\bvolunteer\s+(?:time\s+off|leave|day|days|hours|programme|opportunity|opportunities|break)\b/i, contractType: /\b(?:permanent|fixed[\s-]?term|temporary)\s+(?:employees?|staff|candidates?)\s+(?:receive|enjoy|benefit|are eligible|get)\b/i, workload: /\b(?:full[\s-]?time|part[\s-]?time)\s+(?:employees?|staff|workers?|colleagues?)\s+(?:receive|enjoy|benefit|get|are eligible|work)\b/i, duration: /\b(?:sick leave|annual leave|parental leave|unpaid leave|long service leave|wait(?:ing)? period|notice period|probation period|focus areas?)\b/i };

function declaration(text, patterns, { reject = null } = {}) {
  for (const sentence of sentences(text)) {
    if (NEGATED.test(sentence)) continue;
    if (reject && reject.test(sentence)) continue;
    for (const pattern of patterns) {
      const m = sentence.match(pattern.re);
      if (!m) continue;
      const value = pattern.map ? pattern.map(m) : (m[1] ?? m[0]);
      if (value === null || value === undefined || value === '') continue;
      return { value, quote: clean(sentence).slice(0, 300) };
    }
  }
  return null;
}

// The hours a role works, read from the sentence that states them.
//
// A number only says something about this vacancy when the sentence attaches
// it to the role. Three things do not: a number the sentence negates ("this
// role is not 40 hours per week but 20 hours per week" states 20), a number
// that describes the employer's staff rather than the role ("most full-time
// employees work 40 hours per week"), and a number the sentence limits
// ("up to 20 hours per week" states no single week).
const HOURS_VALUE = String.raw`\d{1,2}(?:\.\d+)?\s*(?:hours?|hrs?)\s*(?:per\s*(?:week|wk)|\/\s*(?:week|wk)|p\.?\s*w\.?\b)`;
const HOURS_RE = new RegExp(HOURS_VALUE, 'gi');
// A population the employer's staff are, not the role being advertised.
const HOURS_POPULATION = /\b(?:employees?|staff|colleagues?|workers?|candidates?|people|team|roles?|positions?|vacancies|jobs?)\s+(?:work|works|are|typically|usually|generally|report|earn|get|receive)\b/i;
// Wording that limits a number instead of stating it.
const HOURS_LIMIT = /\b(?:up to|at most|at least|no more than|no less than|more than|fewer than|less than|maximum of|minimum of|around|approximately|about)\s*$/i;
// A negation that scopes the number in front of it.
const HOURS_NEGATION = /\b(?:not|never|no longer|n't|rather than|other than|instead of|isn't|aren't|wasn't|weren't)\b/i;
// The word that turns a claim into its correction: what follows it is what
// the sentence asserts.
const HOURS_CONTRAST = /\b(?:but|however|although|though|whereas|rather|instead)\b/i;
export function roleHours(text) {
  for (const sentence of sentences(text)) {
    // A sentence that corrects itself is read in its corrected form.
    const parts = sentence.split(HOURS_CONTRAST);
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p];
      let previous = 0;
      for (const match of part.matchAll(HOURS_RE)) {
        // The wording that carries the number is what decides what the number
        // is about: only the wording since the last number belongs to it.
        const lead = part.slice(previous, match.index);
        previous = match.index + match[0].length;
        if (HOURS_POPULATION.test(lead)) continue;
        if (HOURS_NEGATION.test(lead)) continue;
        if (HOURS_LIMIT.test(lead)) continue;
        const value = Number((match[0].match(/\d+(?:\.\d+)?/) ?? [''])[0]);
        if (!Number.isFinite(value) || value <= 0 || value > 60) continue;
        return { value, quote: clean(sentence).slice(0, 300) };
      }
    }
  }
  return null;
}

const mapEngagement = raw => /contractor|self[\s-]?employ/i.test(raw) ? 'independent-contractor' : /volunteer/i.test(raw) ? 'volunteer' : 'employee';
const ENGAGEMENT_PATTERNS = [
  { re: /(?:this|the)\s+(?:role|position|job|vacancy|opportunity)\s+(?:is|will be|would be|has been)\s+(?:an?\s+)?(independent\s+contractor|self[\s-]?employed|paid\s+volunteer|volunteer|permanent\s+employee|fixed[\s-]?term\s+employee|employee|contractor)\b/i, map: mapEngagement },
  { re: /(?:applicants?|candidates?|you)\s+(?:will be|would be|are|is)\s+(?:an?\s+)?(independent\s+contractor|self[\s-]?employed|paid\s+volunteer|volunteer|permanent\s+employee|fixed[\s-]?term\s+employee|employee|contractor)\b/i, map: mapEngagement },
  { re: /(?:engagement|employment)\s*(?:type|category|status)?\s*[:\-]\s*(independent\s+contractor|self[\s-]?employed|volunteer|permanent\s+employee|fixed[\s-]?term\s+employee|employee|contractor)\b/i, map: mapEngagement },
  { re: /\b(?:we|employer)\s+(?:offer|engage|employ)\s+(?:successful\s+)?(?:applicants?|candidates?)\s+as\s+(?:an?\s+)?(independent\s+contractor|self[\s-]?employed|volunteer|permanent\s+employee|fixed[\s-]?term\s+employee|employee|contractor)\b/i, map: mapEngagement },
];
const CONTRACT_PATTERNS = [
  { re: /(?:contract|employment)\s*type\s*[:\-]\s*(permanent|fixed[\s-]?term)/i },
  { re: /(?:this|the)\s+(?:role|position|job|vacancy)\s+is\s+(?:a\s+)?(permanent|fixed[\s-]?term|temporary)/i, map: m => /fixed|temporary/i.test(m[1]) ? 'fixed-term' : 'permanent' },
  { re: /\b(permanent)\s+(?:position|role|contract|employment)\b/i },
  { re: /\b(fixed[\s-]?term)\s+(?:contract|position|role|employment|opportunity)\b/i },
  // A temporary position and a stated contract term are both fixed-term work.
  { re: /\b(temporary)\s+(?:position|role|employment)\b/i, map: () => 'fixed-term' },
  { re: /\b\d{1,2}\s*[-–]?\s*(?:week|month)\s+contract\s+term\b/i, map: () => 'fixed-term' },
];
// Every pattern carries its value in a capture group: a body sentence such as
// "Full-time role, 38 hours per week." must still yield a workload fact.
const WORKLOAD_PATTERNS = [
  { re: /(?:this|the)\s+(?:role|position|job)\s+is\s+(?:an?\s+)?(full[\s-]?time|part[\s-]?time)/i },
  { re: /((?:full|part)[\s-]?time)\s+(?:role|position|job|employment)\b/i },
  // "Full-time, temporary position with an anticipated 14-month contract term".
  // The words in between must not be another workload word, so a sentence that
  // offers both "full-time, part-time positions" is not read as a workload.
  { re: /((?:full|part)[\s-]?time)\b\s*(?:,\s*)?(?:(?!full|part)[\w-]+\s+){0,2}(?:role|position|job|employment)\b/i },
  { re: /(?:hours|working hours|hours of work)\s*[:\-]?\s*(?:are|is|will be)?\s*(full[\s-]?time|part[\s-]?time)/i },
];
// A duration is only a fact when the body ties a span to the engagement:
// a contract term, a placement or a programme. Months and weeks stay in their
// own unit; no conversion is ever applied.
const DURATION_PATTERNS = [
  { re: /\b(\d{1,2})\s*[-–]?\s*(weeks?|months?)\s+(?:fixed[\s-]?term\s+)?(?:contract|term|placement|programme|program|internship|opportunity)\b/i },
  { re: /\b(?:fixed[\s-]?term|contract|placement|programme|program|internship|opportunity)\s*(?:of|for)?\s*(\d{1,2})\s*[-–]?\s*(weeks?|months?)\b/i },
];
const SALARY_PLACEHOLDER = /^(?:tbd|to be decided|na|n\/a|negotiable|competitive|undisclosed)$/i;

// A duration is only a fact when the sentence itself ties a span to the
// engagement: a contract term, a placement or a programme. "no 6 month wait
// period" and "focus areas over the next 12-18 months" are not durations.
// The unit is kept exactly as written: months are never turned into weeks.
const DURATION_CONTEXT = /\b(?:wait(?:ing)? period|notice period|probation period|focus areas?|accru(?:e|es|al|ing))\b/i;
const durationFact = body => {
  for (const sentence of sentences(body)) {
    if (NEGATED.test(sentence)) continue;
    // A sentence that talks about a waiting or accrual clause is about service
    // periods, not about how long the engagement lasts.
    if (DURATION_CONTEXT.test(sentence)) continue;
    for (const pattern of DURATION_PATTERNS) {
      const m = sentence.match(pattern.re);
      if (!m) continue;
      const amount = Number(m[1]);
      const unit = /month/i.test(m[2]) ? 'months' : 'weeks';
      if (!Number.isFinite(amount) || amount <= 0) continue;
      return { value: { amount, unit }, quote: clean(sentence).slice(0, 300) };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Dates.
// A numeric date has two possible readings unless one of its parts rules the
// other out: New Zealand writes day first, US boards write month first. The
// reader returns every reading it can justify and never picks one to make a
// conclusion fit. One reading means the date is unambiguous. Two readings mean
// the value itself says so — and a conclusion that holds for both readings is
// still safe to state.
// ---------------------------------------------------------------------------
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = name => { const i = MONTH_NAMES.indexOf(String(name ?? '').toLowerCase().replace(/[^a-z]/g, '')); return i < 0 ? null : i + 1; }
const isoDate = isoDay;
export function readDate(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { readings: [], format: 'empty' };
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    // A value that carries a time is read as a moment first. A time that does
    // not exist is not a date, and the value is not quietly read as its day.
    if (looksLikeTimestamp(text)) {
      const moment = parseMoment(text);
      if (!moment || moment.kind === 'invalid') return { readings: [], format: 'invalid' };
    }
    const day = isoDate(iso[1], iso[2], iso[3]);
    return day ? { readings: [day], format: 'iso' } : { readings: [], format: 'invalid' };
  }
  const numeric = parseNumeric(text);
  if (numeric) {
    if (numeric.kind === 'invalid') return { readings: [], format: 'invalid' };
    const readings = numeric.candidates.map(c => c.day);
    return { readings, format: readings.length > 1 ? 'numeric-ambiguous' : 'numeric' };
  }
  const words = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (words) {
    const month = monthIndex(words[2]), day = month ? isoDate(words[3], month, words[1]) : null;
    return day ? { readings: [day], format: 'day-month' } : { readings: [], format: 'invalid' };
  }
  return { readings: [], format: 'unreadable' };
}

// The wording that makes a date a publication date. A date that belongs to
// something else — an application deadline, an event, a review, an office
// opening — is not one.
const PUBLICATION_WORDING = /\b(?:posted|published|advertised|listed|advertisement date|date posted|date published)\b/i;
// The date has to be bound to the wording. "Our office opened on 15/10/2026 and
// this role was first advertised on 16/11/2026" states one publication date,
// and it is the second one; the first date is a different fact about a
// different thing. A quotation that carries the wording and a date somewhere
// else proves nothing, so the binding is what counts.
const DATE_SOURCE = String.raw`(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})`;
// How strong a publication claim is. A posting that says when the role was
// first advertised is evidence about the advertisement itself; a plain
// "posted on" is evidence about one posting of it; a repost says only that the
// advertisement was put up again, which proves nothing about when it first
// appeared.
export const PUBLICATION_RANK = { 'first-published': 3, 'advertised-date': 2, 'reposted': 1 };
export const PUBLICATION_SEMANTICS = ['first-published', 'advertised-date'];
// A negation belongs to the wording it sits in front of. "This role was not
// first advertised on 15/10/2026" states no publication date at all, and the
// date in it is not evidence of one.
const NEGATED_WORDING = /\b(?:not|never|no longer|n't)\b((?:\s+[A-Za-z]+){0,2})\s*$/i;
const negatedBefore = prefix => {
  const m = prefix.match(NEGATED_WORDING);
  return Boolean(m) && !m[1].includes(',');
};
// A repost is not a first publication. The wording "reposted", "re-posted",
// "republished" and "relisted" carries a repost date, and no other pattern may
// read the date inside it as a publication date: the guard below stops the
// generic publication wording from matching the tail of "Reposted" or
// "re-published".
//
// The generic wording is not required to start at a word boundary. A posting
// often runs its words together — "AucklandPosted 15/10/2026" — and the date
// is still a date the posting states. The guard is what separates that from
// "Reposted", which is a repost and not a publication.
const NOT_A_REPOST = String.raw`(?<!\b[Rr]e-)(?<!\b[Rr]e)`;
const PUBLICATION_DATE_PATTERNS = [
  { semantics: 'first-published', wordingFirst: true, re: new RegExp(String.raw`\b(?:first|originally)\s+(?:advertised|posted|published|listed)\b(?:\s+on)?\s*:?\s*${DATE_SOURCE}`, 'gi') },
  { semantics: 'reposted', wordingFirst: true, re: new RegExp(String.raw`\b(?:reposted|re-posted|republished|re-published|relisted|re-advertised)\b(?:\s+on)?\s*:?\s*${DATE_SOURCE}`, 'gi') },
  { semantics: 'advertised-date', wordingFirst: true, re: new RegExp(String.raw`\b(?:advertisement date|advertised date|date posted|date published)\s*:?\s*${DATE_SOURCE}`, 'gi') },
  { semantics: 'advertised-date', wordingFirst: true, re: new RegExp(String.raw`${NOT_A_REPOST}(?:posted|published|advertised|listed)\b(?:\s+on)?\s*:?\s*${DATE_SOURCE}`, 'gi') },
  { semantics: 'advertised-date', wordingFirst: false, re: new RegExp(String.raw`${DATE_SOURCE}\s*(?:[-–—|,]\s*)?(?:was\s+)?${NOT_A_REPOST}(?:posted|published|advertised|listed)\b`, 'gi') },
];
// The context a negation is read in: the sentence the wording sits in. A
// negation in another sentence does not reach across to it.
const sentenceContext = prefix => {
  const cut = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'), prefix.lastIndexOf(';'), prefix.lastIndexOf('\n'));
  return cut >= 0 ? prefix.slice(cut + 1) : prefix;
};
// Every publication claim a text makes: the wording that carries it, the date
// bound to it, and how strong it is.
export function publicationClaimsIn(text) {
  const body = normaliseText(text);
  const claims = [];
  for (const pattern of PUBLICATION_DATE_PATTERNS) {
    for (const m of body.matchAll(new RegExp(pattern.re.source, 'gi'))) {
      const value = m[m.length - 1];
      if (!value) continue;
      const negated = pattern.wordingFirst
        ? negatedBefore(sentenceContext(body.slice(0, m.index)))
        : /\b(?:not|never|no longer|n't)\b/i.test(m[0]);
      if (negated) continue;
      claims.push({ value: value.trim(), semantics: pattern.semantics, quote: clean(m[0]) });
    }
  }
  return claims;
}
export function publicationDateIn(text) {
  const claims = publicationClaimsIn(text);
  const usable = claims.filter(c => c.semantics !== 'reposted');
  if (!usable.length) return { readings: [], format: claims.length ? 'no-publication-wording' : 'no-publication-wording', rank: 0, claims };
  const best = Math.max(...usable.map(c => PUBLICATION_RANK[c.semantics] ?? 0));
  const strongest = usable.filter(c => (PUBLICATION_RANK[c.semantics] ?? 0) === best);
  const values = [...new Set(strongest.map(c => c.value))];
  // Two different publication dates at the same strength cannot both be the
  // day the posting was published on, so nothing is decided by them.
  if (values.length > 1) return { readings: [], format: 'ambiguous', rank: best, claims };
  const { readings, format } = readDate(values[0]);
  return { readings, format: readings.length ? format : 'unreadable', rank: best, claims };
}

// A quoted passage is read with focused patterns: the model points at one
// sentence, so the reader does not need the body's context. The same
// declaration rules — negation, rejected phrases — still apply.
const QUOTE_CONTRACT_PATTERNS = [
  { re: /\bpermanent\b[^.]{0,40}\b(?:role|position|contract|employment)\b/i, map: () => 'permanent' },
  { re: /\b(?:fixed[\s-]?term|temporary)\b[^.]{0,40}\b(?:role|position|contract|employment|contract term)\b/i, map: () => 'fixed-term' },
];
const QUOTE_ENGAGEMENT_PATTERNS = [
  { re: /\b(?:paid\s+)?volunteer\b/i, map: () => 'volunteer' },
  { re: /\b(?:independent\s+)?contractor\b|\bself[\s-]?employ(?:ed|er)\b/i, map: () => 'independent-contractor' },
  { re: /\b(?:permanent|fixed[\s-]?term|temporary)\s+(?:employee|staff)\b/i, map: () => 'employee' },
  { re: /\b(?:this|the)\s+(?:role|position|job|vacancy)\s+is\s+(?:an?\s+)?(?:permanent|fixed[\s-]?term|temporary)\b/i, map: () => 'employee' },
];
const QUOTE_WORKLOAD_PATTERNS = [
  { re: /\bfull[\s-]?time\b/i, map: () => 'full-time' },
  { re: /\bpart[\s-]?time\b/i, map: () => 'part-time' },
];
// The engagement facts a quoted passage states, shaped like record fields so
// they can be merged over the record for a condition check.
export function statedFacts(text) {
  const body = normaliseText(text), out = {};
  const engagement = declaration(body, QUOTE_ENGAGEMENT_PATTERNS, { reject: REJECTED_PHRASES.engagement });
  if (engagement) out.engagement = { value: engagement.value };
  const contract = declaration(body, QUOTE_CONTRACT_PATTERNS, { reject: REJECTED_PHRASES.contractType });
  if (contract) out.contractType = { value: contract.value };
  const workload = declaration(body, QUOTE_WORKLOAD_PATTERNS, { reject: REJECTED_PHRASES.workload });
  if (workload) out.workload = { value: workload.value };
  const hours = roleHours(body);
  if (hours) out.hoursPerWeek = { value: hours.value };
  const duration = durationFact(body);
  if (duration) out.duration = { value: duration.value };
  return out;
}

// The wording that introduces a closing statement, and the date and time that
// follow it.
const CLOSING_PHRASE = /\b(?:closing(?:\s+(?:date|on))?|applications?\s+(?:close|closes|closed|must be submitted(?:\s+online)?\s+by)|apply by|application deadline)\b/gi;
const CLOSING_DATE_VALUE = String.raw`(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})`;
const CLOSING_TIME_VALUE = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)?`;
// A stated clock. A bare hour ("at 5") is not a clock — it could be either
// side of noon — so it is not read as one.
function clockFrom(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  if (minute > 59) return null;
  if (m[3] === 'pm') { if (hour < 1 || hour > 12) return null; hour = hour === 12 ? 12 : hour + 12; }
  else if (m[3] === 'am') { if (hour < 1 || hour > 12) return null; hour = hour === 12 ? 0 : hour; }
  else if (m[2] == null) return null;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
// The closing value a tail states, with the time it names when it names one.
function closingValue(tail) {
  const text = String(tail ?? '');
  const before = text.match(new RegExp(String.raw`^\s*:?\s*(?:at\s+(?<time>${CLOSING_TIME_VALUE})\s*)?(?:on\s+)?(?<date>${CLOSING_DATE_VALUE})`, 'i'));
  const after = text.match(new RegExp(String.raw`^\s*:?\s*(?:on\s+)?(?<date>${CLOSING_DATE_VALUE})\s*(?:at\s+(?<time>${CLOSING_TIME_VALUE}))?`, 'i'));
  const pick = [after, before].find(m => m?.groups?.date);
  if (!pick) return null;
  const raw = pick.groups.date;
  const clock = clockFrom(pick.groups.time);
  const { readings } = readDate(raw);
  // A closing statement the runtime cannot read is kept as it was written. It
  // is then reported as a statement it cannot read, rather than being dropped
  // and letting the advertisement look open. An invalid time is never read as
  // a day, so it can never become "expired".
  if (!readings.length) return { value: raw, quote: raw };
  // A date that reads two ways stays as written; the time cannot be attached
  // to a day the reader has not chosen.
  if (readings.length > 1) return { value: raw, quote: raw };
  const day = readings[0];
  // A time that was stated but cannot be read is kept in the value as it was
  // written, so the runtime reports it as a statement it cannot read rather
  // than as a day the employer never wrote.
  const stated = pick.groups.time ? pick.groups.time.trim().replace(/\s+/g, '') : null;
  const value = clock ? `${day}T${clock}:00` : stated ? `${day}T${stated}` : day;
  return { value, quote: `${pick.groups.time ? `at ${pick.groups.time} ` : ''}${raw}` };
}

// The employer's own page governs the closing value it states. A value read
// elsewhere — an inventory's deadline, a mirror's window — stays beside it
// as evidence, but it is not what the vacancy is judged on: the page the
// employer publishes is the primary document, and it is read even when an
// inventory already filled every field.
export function governClosing(record, response, value, quote, semantics) {
  const fields = record.fields;
  const current = fields.closesAt;
  if (value == null || value === '') return;
  if (!current?.value) { fields.closesAt = fact(value, response, quote, semantics); return; }
  // The same document already stated a closing value: it stands.
  if (current.source?.url && current.source.url === response?.url) return;
  // A mirror's claim never becomes the employer's own statement.
  if (!isEmployerPosting(record)) return;
  const governing = fact(value, response, quote, semantics);
  governing.superseded = { value: current.value, semantics: current.semantics, source: current.source, quote: current.quote, origin: current.origin };
  fields.closesAt = governing;
}

// The texts a quotation may be taken from: the body's that governs the
// record, and every other body the record has read. A declaration that only
// the employer's own page states is still the posting's own text, so a
// quotation of it is verifiable.
export function quoteCorpus(record) {
  const parts = [];
  const duties = record?.fields?.duties?.value;
  if (duties) parts.push(duties);
  for (const body of record?.bodies ?? []) if (body?.value) parts.push(body.value);
  return parts.join('\n');
}

export function observeText(record, text, response, kind = 'other') {
  const fields = record.fields;
  const set = (name, value, quote = value) => { if (!fields[name]?.value && value !== null && value !== undefined && value !== '') fields[name] = fact(value, response, quote); };
  const body = normaliseText(text);
  // Every body a record reads is kept, with the document it came from. The
  // employer's own page and an inventory's summary can each state something
  // the other does not, and a declaration only one of them carries is still
  // the posting's own text.
  if (body) {
    record.bodies = record.bodies ?? [];
    if (!record.bodies.some(b => b.value === body)) {
      record.bodies.push({ value: body, kind, source: { url: response?.url, observedAt: response?.observedAt, snapshot: response?.snapshot } });
    }
  }
  // The HTML job page is the primary document; an inventory's summary only
  // fills what the page does not state. When the page is read after the
  // inventory, the page's body becomes the duties and the inventory's body
  // stays in the corpus, so nothing is dropped and the primary document is
  // the one the runtime quotes from.
  const current = fields.duties;
  if (!current?.value) {
    const primary = fact(body, response);
    primary.bodyKind = kind;
    fields.duties = primary;
  } else if (current.bodyKind && current.bodyKind !== 'page' && kind === 'page') {
    record.bodies = record.bodies ?? [];
    if (!record.bodies.some(b => b.value === current.value)) {
      record.bodies.push({ value: current.value, kind: current.bodyKind, source: current.source });
    }
    const primary = fact(body, response);
    primary.bodyKind = 'page';
    fields.duties = primary;
  }
  const workload = declaration(body, WORKLOAD_PATTERNS, { reject: REJECTED_PHRASES.workload });
  set('workload', workload ? (workload.value.toLowerCase().startsWith('full') ? 'full-time' : 'part-time') : null, workload?.quote);
  const hours = roleHours(body);
  set('hoursPerWeek', hours?.value ?? null, hours?.quote);
  // Months and weeks stay in their own unit. No private conversion.
  const duration = durationFact(body);
  if (duration) set('duration', duration.value, duration.quote);
  const contract = declaration(body, CONTRACT_PATTERNS, { reject: REJECTED_PHRASES.contractType });
  set('contractType', contract ? (contract.value.toLowerCase().startsWith('fixed') ? 'fixed-term' : 'permanent') : null, contract?.quote);
  set('workArrangement', /\bhybrid\b/i.test(body) ? 'hybrid' : /\b(?:fully remote|remote.only|work from anywhere|remote first)\b/i.test(body) ? 'remote' : /\b(?:on.site|in.person|in office)\b/i.test(body) ? 'on-site' : null);
  const engagement = declaration(body, ENGAGEMENT_PATTERNS, { reject: REJECTED_PHRASES.engagement });
  set('engagement', engagement ? engagement.value : null, engagement?.quote);
  const pay = body.match(/\b(?:unpaid|paid internship|paid volunteer|expenses (?:are )?reimbursed|reimbursed expenses)\b/i);
  set('payStatus', pay ? /unpaid/i.test(pay[0]) ? 'unpaid' : /reimburs/i.test(pay[0]) ? 'reimbursed' : 'paid' : null, pay?.[0]);
  const salaryMatch = body.match(/(?:NZ\$|\$)\s*[\d,]+(?:\s*[–-]\s*(?:NZ\$|\$)?\s*[\d,]+)?\s*(?:per (?:annum|year|hour)|p\.?a\.?|\/hr)/i)?.[0] ?? null;
  // A zero or placeholder amount is not a salary fact.
  const salaryNumbers = salaryMatch ? [...salaryMatch.matchAll(/[\d,]+/g)].map(m => Number(m[0].replace(/,/g, ''))) : [];
  set('salary', salaryMatch && !SALARY_PLACEHOLDER.test(salaryMatch.trim()) && salaryNumbers.length && salaryNumbers.every(n => n > 0) ? salaryMatch : null, salaryMatch);
  const pool = poolKind(record, body);
  // A channel that recruits employers is neither a vacancy nor a talent pool:
  // the page itself is the employer-facing side, and the candidate-side entry
  // point on it is not a verified application route.
  const channel = channelKind(body);
  if (channel) record.opportunityKind = fact('employer-channel', response, channel);
  else if (pool) record.opportunityKind = fact('talent-pool', response, pool);
  const dates = name => {
    if (name === 'postedAt') {
      // Every publication claim the body makes is read, each with the wording
      // that carries it. "Posted 28 February, 2026" is the wording an
      // aggregator uses: no "on", and a comma before the year. "Posted
      // 15/10/2026" and "Posted on : 24-10-2026" are the numeric forms of the
      // same statement. A numeric date that could read two ways is stored as
      // written, so the check can judge it without the reader choosing a
      // reading.
      for (const claim of publicationClaimsIn(body)) {
        if (claim.semantics === 'reposted') {
          // A repost says when the advertisement was put up again, not when it
          // first appeared. It is kept as what it is and never counted as a
          // publication date.
          if (!record.repostedAt) record.repostedAt = fact(claim.value, response, claim.quote, 'reposted');
          continue;
        }
        const { readings } = readDate(claim.value);
        if (!readings.length) continue;
        const value = looksLikeTimestamp(claim.value) ? claim.value : readings.length === 1 ? readings[0] : claim.value;
        setPostedAt(fields, value, response, claim.quote, claim.semantics);
      }
      return;
    }
    // A closing statement keeps the time it names. "Applications close at 1pm
    // on 17 November 2026" is a moment, not a day, and dropping the hour would
    // read a closing that has passed as one that has not.
    // Every closing wording in the body is a candidate, and the first one
    // that states a readable date is the closing statement. A phrase that is
    // followed by nothing readable ("closing applications will be assessed")
    // is not a closing date, and the wording after it is still read.
    for (const phrase of body.matchAll(new RegExp(CLOSING_PHRASE.source, 'gi'))) {
      const start = phrase.index + phrase[0].length;
      const tail = body.slice(start, start + 90);
      const closing = closingValue(tail);
      if (!closing) continue;
      // The employer's own page governs the closing value it states. A value
      // read elsewhere stays beside it, but the page the employer publishes is
      // what the vacancy's closing is judged on.
      if (kind === 'page') governClosing(record, response, closing.value, `${phrase[0]}${closing.quote}`, 'deadline-date');
      else if (!fields[name]?.value) fields[name] = fact(closing.value, response, `${phrase[0]}${closing.quote}`, 'deadline-date');
      return;
    }
  };
  dates('postedAt'); dates('closesAt');
}

// A talent pool is a posting whose own subject is a pool: its title, its own
// heading, or an explicit statement that it is not an active vacancy. A clause
// that describes what the employer does with applicants ("unsuccessful
// applicants will be added to our talent pool for future roles") speaks about
// the employer's process, not about the posting, so it never turns a vacancy
// into a pool.
const POOL_TITLE = /\b(?:talent pool|talent community|talent register|join our (?:team|talent)|future opportunities|future consideration|job alert|speculative application|general application|register your interest|expressions? of interest)\b/i;
// Subject-of-the-posting declarations. These are checked against the body
// without the general negation filter: "this is not an active job opening" is
// a declaration about the posting, and that is exactly what makes it a pool.
const POOL_SUBJECT = [
  { re: /^(?:join\s+(?:our|the)\s+talent\s+(?:pool|community))/i },
  { re: /^(?:expressions?\s+of\s+interest)\b/i },
  { re: /^(?:register\s+(?:your\s+)?interest)\b/i },
  { re: /^(?:submit\s+an?\s+expression\s+of\s+interest)\b/i },
  { re: /^(?:we\s+(?:are\s+)?(?:accepting|inviting|collecting)\s+(?:expressions?\s+of\s+interest|interest))/i },
  { re: /\bthis\s+is\s+not\s+an?\s+active\s+job\s+opening\b/i },
  { re: /\bthis\s+is\s+not\s+(?:a\s+|an?\s+)?(?:current\s+)?vacancy\b/i },
  { re: /\bthis\s+is\s+not\s+a\s+job\s+opening\b/i },
  { re: /\bwe\s+do\s+not\s+have\s+any\s+(?:current\s+)?(?:open\s+)?(?:roles|vacancies|positions)\b/i },
  { re: /\bdon'?t\s+see\s+the\s+right\s+(?:opportunity|role|position)\b/i },
];
// A clause about what the employer does with applicants is not a statement
// about the posting. "We will add you to our talent pool for future
// opportunities" describes the employer's process, and a posting that says
// in the same breath that it is a current vacancy with applications open is
// a vacancy.
const POOL_PROCESS = [
  { re: /\bwe(?:'ll|\s+will)\s+add\s+you\s+to\s+our\s+[^.]{0,40}(?:careers\s+newsletter|talent\s+(?:pool|community))\b/i },
];
// A statement that the posting is a live vacancy, with applications open.
const CURRENT_VACANCY = /\b(?:this\s+is\s+a\s+current\s+vacancy|this\s+(?:vacancy|role|position|job|opening)\s+is\s+(?:current|open|available|live)|(?:applications?|apply|applying)\s+(?:are|is)?\s*(?:now\s+|still\s+)?open\b|you\s+can\s+apply(?:\s+now)?\b|apply\s+now\b|we(?:'re|\s+are)\s+currently\s+(?:hiring|recruiting|looking)\b|currently\s+(?:hiring|recruiting|looking)\s+for\b)/i;
export function poolKind(record, body) {
  const title = key(record.fields.title?.value ?? record.lead.title ?? '');
  if (POOL_TITLE.test(title)) return title;
  for (const sentence of sentences(body)) {
    for (const pattern of POOL_SUBJECT) {
      if (pattern.re.test(sentence)) return clean(sentence).slice(0, 300);
    }
  }
  // The posting's own declaration settles it: a posting that says it is a
  // current vacancy is a vacancy, whatever the employer says it does with
  // the applicants it does not take.
  if (CURRENT_VACANCY.test(String(body ?? ''))) return null;
  for (const sentence of sentences(body)) {
    for (const pattern of POOL_PROCESS) {
      if (pattern.re.test(sentence)) return clean(sentence).slice(0, 300);
    }
  }
  return null;
}

// An employer channel is a page whose own subject is recruiting employers, not
// candidates: it tells the reader to register as an employer, to list roles
// and to search candidate profiles. Such a page is not a vacancy, and it is
// not a talent pool either: what it offers is an event or a platform for
// employers, and the candidate-side entry point on it is not a verified
// application route.
//
// Two independent employer-facing instructions are required, so an employer
// phrase inside an ordinary job ad cannot turn a vacancy into a channel. A
// page that gives the candidate a route of its own is never a channel.
const CHANNEL_SUBJECT = [
  { re: /\bregister as an employer\b/i },
  { re: /\b(?:create|set up|build) your (?:organisation|organization|company|employer) profile\b/i },
  { re: /\blist your (?:intern|grad|graduate|job|role|vacancy|opening|position)s?\b/i },
  { re: /\bsearch (?:more than |over |up to )?[\d,]{2,}\s*(?:candidate|talent|student)?\s*profiles\b/i },
  { re: /\bmeet\b[^.]{0,60}\bcandidates\b/i },
  { re: /\b(?:hire|hiring)\s+(?:your\s+|the\s+)?(?:interns|graduates|students|candidates)\b/i }
];
// A candidate route on the same page means the page addresses the candidate.
const CANDIDATE_ROUTE = /\bapply now\b|\bapply for (?:this|our|the) (?:job|role|position)\b|\bsubmit (?:your |an )?application\b|\bsend (?:us |your )?(?:cv|resume)\b|\bstart (?:your )?application\b/i;
// A feature that is being tested is not an instruction to the reader. A QA
// vacancy whose responsibilities include testing the "register as an
// employer" journey is testing the employer's channel; it is not that
// channel, and it is not an employer-facing recruitment page.
const TESTING_SUBJECT = /\b(?:test(?:ing|s|ed)?|automat(?:e|ed|es|ing)|verif(?:y|ied|ies|ying)|regression|script(?:ing|s)?|suite|qa|quality assurance|coverage|exercis(?:e|es|ed))\b/i;
export function channelKind(body) {
  const text = String(body ?? '');
  if (!text) return null;
  if (CANDIDATE_ROUTE.test(text)) return null;
  const hits = [];
  for (const sentence of sentences(text)) {
    for (const pattern of CHANNEL_SUBJECT) {
      const m = sentence.match(pattern.re);
      if (!m) continue;
      // The wording in front of the phrase says what the phrase is about. A
      // phrase that is the object of a testing instruction is a feature under
      // test, not an instruction addressed to the reader.
      if (TESTING_SUBJECT.test(sentence.slice(0, m.index))) continue;
      hits.push(pattern);
    }
  }
  if (new Set(hits).size < 2) return null;
  for (const sentence of sentences(text)) {
    if (hits.some(h => h.re.test(sentence))) return clean(sentence).slice(0, 300);
  }
  return [...new Set(hits)].map(h => h.re.source).join('；').slice(0, 300);
}

// The body of a posting, read from whichever structure the platform returned.
// A posting object is never stringified: a platform that ships its body as a
// structured document is read as that document.
function apiBody(job) {
  const parts = [];
  const content = job.content;
  if (typeof content === 'string') parts.push(content);
  else if (content && typeof content === 'object' && !Array.isArray(content)) {
    // SmartRecruiters: content.sections.<name>.text
    if (content.sections && typeof content.sections === 'object') {
      for (const section of Object.values(content.sections)) {
        const text = typeof section === 'string' ? section : section?.text ?? '';
        if (text) parts.push(text);
      }
    } else if (typeof content.text === 'string') parts.push(content.text);
  }
  if (!parts.length) {
    if (job.descriptionHtml) parts.push(job.descriptionHtml);
    else if (job.descriptionPlain) parts.push(job.descriptionPlain);
    else if (job.description) parts.push(job.description);
    const lists = (job.lists ?? []).map(x => `${x.text}: ${x.content}`).join('\n');
    if (lists) parts.push(lists);
    const adSections = Object.values(job.jobAd?.sections ?? {}).map(x => x?.text ?? '').join('\n');
    if (adSections) parts.push(adSections);
  }
  return textOf(parts.join('\n'));
}

export function fromApi(record, job, response, company) {
  const f = record.fields, p = record.provider;
  const apiId = job.id ?? record.ids.apiPosting ?? null;
  if (apiId != null) record.ids.apiPosting = String(apiId);
  record.ids.platformJob = job.internal_job_id == null ? record.ids.platformJob : String(job.internal_job_id);
  if (!record.ids.requisition && (job.requisition_id ?? job.refNumber)) record.ids.requisition = job.requisition_id ?? job.refNumber;
  // SmartRecruiters names the posting jobTitle and the place jobAdLocation.
  f.title = fact(job.title ?? job.jobTitle ?? job.name ?? job.text, response);
  f.employer = fact(job.company_name ?? job.company?.name ?? company, response);
  if (f.employer.source && !job.company_name && !job.company?.name) f.employer.source.kind = 'registered-official-board';
  const text = apiBody(job);
  const location = job.jobAdLocation
    ?? (typeof job.location === 'object' ? job.location?.name ?? [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ') : job.location)
    ?? job.categories?.location;
  f.location = fact(location, response);
  // postedDate is the date the posting was advertised; releasedDate only says
  // when the posting was last touched, so it never stands in for one.
  const posted = p === 'greenhouse' ? job.first_published
    : p === 'ashby' ? job.publishedAt
    : p === 'smartrecruiters' ? (job.postedDate ?? job.releasedDate)
    : job.createdAt;
  const postedSemantics = p === 'greenhouse' ? 'first-published'
    : p === 'lever' ? 'platform-created'
    : p === 'smartrecruiters' ? (job.postedDate ? 'advertised-date' : 'last-published')
    : 'last-published';
  setPostedAt(f, typeof posted === 'number' ? new Date(posted).toISOString() : posted, response, posted, postedSemantics);
  if (job.updated_at) f.updatedAt = fact(job.updated_at, response, job.updated_at, 'updated');
  if (job.application_deadline && !f.closesAt?.value) f.closesAt = fact(job.application_deadline, response, job.application_deadline, 'deadline');
  const employment = job.employmentType ?? job.categories?.commitment ?? job.typeOfEmployment?.label;
  if (employment && !f.workload?.value) f.workload = fact(/part/i.test(employment) ? 'part-time' : /full/i.test(employment) ? 'full-time' : null, response, employment);
  if (job.workplaceType && !f.workArrangement?.value) f.workArrangement = fact(job.workplaceType.toLowerCase().replace('onsite', 'on-site'), response);
  if (job.applyUrl) record.applicationUrl = job.applyUrl;
  observeText(record, text, response, 'inventory');
  record.readState = text.length >= 100 ? 'read' : 'partial';
  // The advertisement id used to bind an application is the one carried by the job page.
  const adId = job.advertisement_id ?? job.adId ?? job.reqId ?? advertisementFromUrl(job.applyUrl ?? job.absolute_url ?? job.hostedUrl ?? job.jobUrl);
  if (adId) record.ids.advertisement = String(adId);
  else if (p === 'greenhouse' && apiId != null) record.ids.advertisement = String(apiId);
  record.detailUrl = jobPageUrl(record, job);
  record.apiUrl = p === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${record.account}/jobs/${record.ids.apiPosting ?? record.ids.advertisement}`
    : p === 'smartrecruiters' ? `https://api.smartrecruiters.com/v1/companies/${record.account}/postings/${record.ids.apiPosting}` : null;
  record.aliases = [...new Set([...record.aliases, ...[job.absolute_url, job.hostedUrl, job.jobUrl, job.applyUrl].filter(Boolean).map(canonicalLocal).filter(Boolean)])];
  return stampOrigin(record);
}

export function advertisementFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/jobs\.smartrecruiters\.com\/[^/]+\/(\d+)/i) ?? String(url).match(/\/jobs\/(\d+)(?:\/|$)/i);
  return m ? m[1] : null;
}

// The HTML job page is the primary vacancy document; the JSON API is a supplement.
export function jobPageUrl(record, job = {}) {
  const account = record.account;
  if (job.absolute_url) return job.absolute_url;
  if (job.hostedUrl) return job.hostedUrl;
  if (job.jobUrl) return job.jobUrl;
  if (record.provider === 'greenhouse' && record.ids.advertisement) return `https://job-boards.greenhouse.io/${account}/jobs/${record.ids.advertisement}`;
  if (record.provider === 'lever' && record.ids.advertisement) return `https://jobs.lever.co/${account}/${record.ids.advertisement}`;
  if (record.provider === 'smartrecruiters' && record.ids.advertisement) return `https://jobs.smartrecruiters.com/${account}/${record.ids.advertisement}`;
  if (record.provider === 'ashby' && record.ids.advertisement) return `https://jobs.ashbyhq.com/${account}/${record.ids.advertisement}`;
  return null;
}

function jobPostings($) {
  const out = [];
  function visit(x) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(visit);
    if ([].concat(x['@type'] ?? []).some(t => /(?:^|\/)JobPosting$/.test(t))) out.push(x);
    if (x['@graph']) visit(x['@graph']);
  }
  $('script[type="application/ld+json"]').each((_, e) => { try { visit(JSON.parse($(e).text())); } catch {} });
  return out;
}
// --- email delivery route ----------------------------------------------------
// A mailto: link is not a delivery instruction. The posting itself has to say
// how the application is delivered; the address may come from the mailto link.
const EMAIL_INSTRUCTIONS = [
  /(?:apply|send|submit|forward|email)\b[^]{0,140}?\b(?:cv|resume|application|cover letter)\b/i,
  /\b(?:apply|send|submit|forward)\b[^]{0,60}?\b(?:by|via|to)\s+e-?mail\b/i
];
// Wording that forbids the delivery: "do not send your CV to jobs@acme.example"
// names an address, and names it as one that must not receive the application.
const NEGATED_DELIVERY = /\b(?:do not|don'?t|never|must not|mustn'?t|should not|shouldn'?t|shall not|cannot|can'?t|will not|won'?t|no longer|refuse to|not accepted|not accepting)\b/i;
// Wording that asks a question or asks for contact rather than delivering an
// application: the address it names is a place to ask, not a place to apply.
const ENQUIRY_DELIVERY = /\b(?:question|enquir|enquir|inquir|quer|clarif|contact|reach out|get in touch|more information|more details|further information)\w*/i;
// An address in the employer's own text.
const EMAIL_ADDRESS = /([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;
// A mailto link, marked in the prose so the address it points at can be bound
// to the instruction written next to it.
const MAILTO_MARK = /\[mailto-(\d+)\]/g;
// The prose of the posting with every mailto link marked by its address: a
// link label is not a delivery instruction written by the employer, but the
// address the link points at can be bound to the sentence that carries the
// instruction.
function proseWithMailto(body) {
  const $ = load(String(body ?? ''));
  const main = $('main').length ? $('main').clone() : $('body').clone();
  main.find('script,style,nav,footer,aside').remove();
  const links = [];
  // The prose is read from the node tree, so a mailto anchor can be replaced
  // by its mark without the employer's own wording being lost elsewhere.
  function prose(node) {
    if (!node) return '';
    if (node.type === 'text') return node.value ?? '';
    if (node.type === 'tag' && node.tag === 'a') {
      const href = String(node.attribs?.href ?? '').trim();
      if (!/^mailto:/i.test(href)) return node.children.map(prose).join('');
      const address = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0]).trim();
      if (!address) return node.children.map(prose).join('');
      const label = clean(node.children.map(prose).join(''));
      links.push({ address, label });
      return `[mailto-${links.length - 1}]`;
    }
    return (node.children ?? []).map(prose).join('');
  }
  const text = normaliseText(main.elements.map(prose).join(''));
  // Instructions are read sentence by sentence, so a period inside an address
  // ("careers@acme.example") does not cut the sentence short.
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => clean(s)).filter(Boolean);
  return { text, sentences, links };
}
// The clauses of a sentence, split at the punctuation that separates one
// piece of wording from the next. An address is bound by the words of its own
// clause: "For enquiries contact help@acme.example" is a contact clause, and
// what that clause says decides whether the address receives an application.
function clausesOf(sentence) {
  const out = [];
  let start = 0;
  for (const m of sentence.matchAll(/[,;]/g)) {
    out.push({ text: sentence.slice(start, m.index), start });
    start = m.index + 1;
  }
  out.push({ text: sentence.slice(start), start });
  return out;
}
// The address a sentence binds to its delivery instruction, and the
// instruction as it is printed. An address only counts when it stands in the
// same sentence as the instruction that sends the application to it, and when
// its own clause says the application is sent there.
function emailBinding(sentence, links) {
  // The candidates: an address written in the employer's own text, and a
  // mailto link the employer put next to the instruction.
  const candidates = [];
  for (const m of sentence.matchAll(new RegExp(EMAIL_ADDRESS.source, 'g'))) candidates.push({ address: m[1], index: m.index });
  for (const m of sentence.matchAll(MAILTO_MARK)) {
    const link = links[Number(m[1])];
    if (link) candidates.push({ address: link.address, index: m.index });
  }
  candidates.sort((a, b) => a.index - b.index);
  if (!candidates.length) return null;
  const clauses = clausesOf(sentence);
  // The instructions the sentence carries, in the order they are written.
  const instructions = [];
  for (const pattern of EMAIL_INSTRUCTIONS) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    for (const m of sentence.matchAll(re)) instructions.push(m);
  }
  instructions.sort((a, b) => a.index - b.index);
  for (const candidate of candidates) {
    const clause = clauses.filter(c => c.start <= candidate.index).pop();
    if (!clause) continue;
    // The sentence has to carry the instruction that sends the application,
    // and the instruction has to come before the address it delivers to.
    const instruction = instructions.find(i => i.index < candidate.index);
    if (!instruction) continue;
    // The binding context is the wording between the instruction and the
    // address, and the clauses they sit in. A context that forbids the
    // delivery, or asks a question about it, does not deliver an
    // application: the address it names is not a route.
    const from = clauses.filter(c => c.start <= instruction.index).pop();
    const context = sentence.slice(from ? from.start : 0, clause.start + clause.text.length);
    if (NEGATED_DELIVERY.test(context)) continue;
    if (ENQUIRY_DELIVERY.test(context)) continue;
    // The instruction shown is the employer's own wording: the link's own
    // label is kept, with the address it points at.
    const printed = clean(sentence.replace(MAILTO_MARK, (_, index) => {
      const link = links[Number(index)];
      if (!link) return '';
      return link.label.includes('@') ? link.label : `${link.label} (${link.address})`.trim();
    }));
    return { address: candidate.address, instruction: printed };
  }
  return null;
}
export function emailRoute(text, body, response) {
  const prose = proseWithMailto(body);
  // A posting that says it does not take applications by email has no email
  // route at all, whatever else it prints.
  const noEmail = /(?:do not|not accept|cannot accept)[^.]{0,50}(?:by email|via email|email applications)/i;
  if (noEmail.test(prose.text) || noEmail.test(String(text ?? ''))) return null;
  for (const sentence of prose.sentences) {
    if (!EMAIL_INSTRUCTIONS.some(pattern => pattern.test(sentence))) continue;
    const binding = emailBinding(sentence, prose.links);
    if (!binding) continue;
    const email = binding.address;
    // The instruction shown is the employer's own wording. When the address is
    // written next to the instruction, that sentence is used; a link label alone
    // is not a delivery instruction.
    const written = String(text ?? '').split(/(?<=[.!?])\s+/).map(s => clean(s)).filter(Boolean);
    const withAddress = written.find(s => s.includes(email) && EMAIL_INSTRUCTIONS.some(pattern => pattern.test(s)));
    const instruction = withAddress ?? binding.instruction;
    return { email, instruction: clean(instruction).slice(0, 300), source: { url: response.url, observedAt: response.observedAt, snapshot: response.snapshot } };
  }
  return null;
}

// Where the posting says the job is. A place the posting names is read even
// when it is not a New Zealand city: a posting that names Woonsocket, Rhode
// Island has stated a location, and leaving that unread turns a known
// conflict into an unknown. The place phrase is the employer's own wording.
function locationCandidate($, text, body) {
  const carriers = [];
  const embedded = String(body ?? '').match(/"job_post_location"\s*:\s*"([^"]{2,80})"/);
  if (embedded) carriers.push({ value: embedded[1], quote: embedded[0].slice(0, 200) });
  const og = clean($('meta[property="og:description"]').first().attr('content'));
  if (og) carriers.push({ value: og, quote: og.slice(0, 200) });
  const element = clean($('[class*="location"],[data-testid="job-location"],.job-location').first().text());
  if (element) carriers.push({ value: element, quote: element.slice(0, 200) });
  const prose = text.match(/\b(?:based in|located in|located at|on-site in|onsite in|office in|offices in|hybrid in|remote in|working in|residing in)\s+([^.;]{2,60})/i);
  if (prose) carriers.push({ value: prose[1], quote: clean(prose[0]).slice(0, 200) });
  for (const carrier of carriers) {
    const place = placeFragment(carrier.value);
    if (place) return { value: place, quote: carrier.quote };
  }
  return null;
}

// The page states that the advertisement it shows is closed. The employer's
// own wording and the wording an aggregator uses for the advertisement it
// mirrors — "This listing expired on 05 Mar. Applications are no longer
// accepted." — are the same statement, and both are read here: a page that
// says so is not left looking like a live vacancy.
const ADVERTISEMENT_SUBJECT = 'job|position|vacancy|role|listing|advertisement|advert|ad|posting';
export const CLOSED_NOTICE = new RegExp([
  `this (?:${ADVERTISEMENT_SUBJECT}) (?:has expired|expired)(?:\\s+on\\s+[^.]{0,24})?`,
  `this (?:${ADVERTISEMENT_SUBJECT}) (?:is no longer available|is no longer advertised|is now closed|has been closed|has been filled)`,
  // A delivery channel that is closed is not a vacancy that is closed.
  // "We are no longer accepting applications by email" closes the email
  // route only; the same posting can still invite applications online.
  'no longer accept(?:ing|s)? applications(?!\\s+(?:by|via|through|over|per|in)\\s+(?:e-?mail|email|mail|post|sent|submitted))',
  'applications? (?:are|have) (?:now )?closed',
  'applications? (?:are|have) no longer accepted'
].join('|'), 'i');

// The claims a page makes about the vacancy, applied to the record with the
// page's own origin.
//
// The employer's own page is read and evaluated even when an inventory
// already filled every field: a page can state a closing value, a
// publication date or a plain fact that the inventory does not carry, and a
// page that was just read is never ignored.
export function applyPageClaims(record, response, prepared = null) {
  const $ = prepared?.$ ?? load(response.body);
  const f = record.fields;
  const main = prepared?.main ?? ($('main').length ? $('main').clone() : $('body').clone());
  if (!prepared) main.find('script,style,nav,footer,aside').remove();
  const text = prepared?.text ?? normaliseText(main.text());
  const h1 = prepared?.h1 ?? clean($('h1').first().text());
  const responseId = new URL(response.url).pathname.split('/');
  const responseCanonical = canonicalLocal(response.url);
  if (!record.aliases.includes(responseCanonical) && !(record.ids.advertisement && responseId.includes(record.ids.advertisement))) return false;
  const expectedTitle = f.title?.value ?? record.lead.title;
  if (expectedTitle && h1 && !key(h1).includes(key(expectedTitle)) && !key(expectedTitle).includes(key(h1))) return false;
  // The record's own page speaks for the employer's posting; any other
  // document only speaks for the advertisement it mirrors.
  const ownPage = responseCanonical === canonicalLocal(record.detailUrl ?? record.canonicalUrl);
  if (ownPage) record.primaryRead = { url: response.url, observedAt: response.observedAt, snapshot: response.snapshot };
  const posting = jobPostings($).find(j => !f.title?.value || key(j.title) === key(f.title.value));
  if (posting) {
    f.title = fact(posting.title, response);
    f.employer = fact(typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name, response);
    // A JobPosting's datePosted is the date the employer first put the job up
    // (Google's schema: "the original date that employer posted the job"), so
    // it states the first appearance rather than one posting of it.
    if (posting.datePosted) setPostedAt(f, posting.datePosted, response, posting.datePosted, 'first-published');
    // A JSON-LD validThrough is the posting's validity window. The page does
    // not call it a deadline, so it is not recorded as one: its meaning stays
    // unestablished until the employer's own posting says otherwise. On the
    // employer's own page it governs the closing value, even when an
    // inventory stated a later one.
    if (posting.validThrough) {
      if (ownPage) governClosing(record, response, posting.validThrough, posting.validThrough, 'valid-through');
      else if (!f.closesAt?.value) f.closesAt = fact(posting.validThrough, response, posting.validThrough, 'valid-through');
    }
    const locations = [].concat(posting.jobLocation ?? []).map(x => typeof x === 'string' ? x : [x.address?.addressLocality, x.address?.addressRegion, x.address?.addressCountry].filter(Boolean).join(', '));
    if (locations.length && !f.location?.value) f.location = fact(locations.join(' | '), response);
    // JobPosting.identifier is not universally the employer's requisition number.
    if (posting.identifier?.value) record.ids.platformIdentifier = String(posting.identifier.value);
  }
  if (!f.title?.value && h1) f.title = fact(h1, response);
  if (!f.employer?.value && record.authority === 'registered-official' && record.lead.employer) f.employer = fact(record.lead.employer, response, record.lead.employer);
  observeText(record, text, response, ownPage ? 'page' : 'other');
  if (!f.location?.value) {
    const candidate = locationCandidate($, text, response.body);
    if (candidate) f.location = fact(candidate.value, response, candidate.quote);
  }
  const req = text.match(/(?:Requisition(?: ID)?|Job (?:reference|number)|Position Number|Reference|REF)\s*:?\s*([\w-]{4,30})/i);
  if (req && !record.ids.requisition) record.ids.requisition = req[1];
  return true;
}

export function fromHtml(record, response) {
  const $ = load(response.body);
  const main = $('main').length ? $('main').clone() : $('body').clone();
  main.find('script,style,nav,footer,aside').remove();
  const text = normaliseText(main.text());
  const h1 = clean($('h1').first().text()), expectedTitle = record.fields.title?.value ?? record.lead.title;
  const responseId = new URL(response.url).pathname.split('/');
  const responseCanonical = canonicalLocal(response.url);
  if (!record.aliases.includes(responseCanonical) && !(record.ids.advertisement && responseId.includes(record.ids.advertisement))) {
    record.readState = 'unreadable'; record.detailError = 'Redirect target is not bound to the original advertisement'; return record;
  }
  if (expectedTitle && h1 && !key(h1).includes(key(expectedTitle)) && !key(expectedTitle).includes(key(h1))) {
    record.readState = 'unreadable'; record.detailError = 'Page heading does not match vacancy; possible generic redirect/soft 404'; return record;
  }
  const closed = text.match(CLOSED_NOTICE);
  if (closed) {
    record.closure = { scope: closureScope(text), observedAt: response.observedAt, ...fact(true, response, closed[0]) };
    record.readState = 'closed-stated';
    // The employer's own posting ends the read: there is nothing left to read.
    // A mirror that says its advertisement expired keeps the facts it printed:
    // the record stays a usable historical lookup entry — with its own
    // publication date — while the employer's own posting stays unknown.
    if (isEmployerPosting(record)) return stampOrigin(record);
  }
  applyPageClaims(record, response, { $, main, text, h1 });
  record.applyLinks = [];
  $('a[href]').each((_, e) => {
    const a = $(e), label = clean(a.text());
    if (/^(?:apply(?: (?:now|for this (?:job|role)|via \w+))?|i.m interested|submit application|start application)$/i.test(label)) {
      try { record.applyLinks.push({ url: new URL(a.attr('href'), response.url).href, label }); } catch {}
    }
  });
  const email = emailRoute(text, response.body, response);
  if (email) record.emailRoute = email;
  record.readState = h1 && text.length >= 100 ? 'read' : 'unreadable';
  record.observedHtml = { url: response.url, snapshot: response.snapshot, observedAt: response.observedAt };
  return stampOrigin(record);
}

// Advertisement closure and employer-posted closure are different statements.
export function closureScope(text) {
  return /(?:employer(?:'s)?|our|this)\s+(?:careers?\s+)?(?:page|posting|site)\b[^.]{0,80}\b(?:role|position|job)\b[^.]{0,40}\b(?:closed|no longer|not available)\b/i.test(text)
    ? 'employer-posting' : 'advertisement';
}

// A record read from an ATS tenant is the employer's own posting. A record
// read from a plain web page is only the employer's posting once this run has
// verified that employer's careers page and linked it to this record; until
// then the page is a mirror or an aggregator, and what it says speaks for
// that advertisement alone. A discovery-only entry — a LinkedIn posting, a
// search result — is never the employer's own posting, whatever else it says.
export const EMPLOYER_PLATFORMS = new Set(['greenhouse', 'lever', 'smartrecruiters', 'ashby', 'asb']);
export const isEmployerPosting = record => {
  if (!record) return false;
  if (EMPLOYER_PLATFORMS.has(record.provider)) return true;
  return record.provider === 'html' && record.authority === 'registered-official';
};
// Where a fact came from. A fact keeps the authority of the page it was read
// from, so that a fact read from a mirror keeps speaking for the mirror after
// the record is later joined to the employer's own posting.
export function stampOrigin(record) {
  const origin = { provider: record.provider ?? null, authority: record.authority ?? 'discovery-only', employerPosting: isEmployerPosting(record) };
  for (const field of Object.values(record.fields ?? {})) {
    if (!field || typeof field !== 'object') continue;
    if (!field.origin) field.origin = origin;
    for (const alt of field.ambiguity ?? []) if (!alt.origin) alt.origin = origin;
  }
  return record;
}
// Whether a fact speaks for the employer's own posting.
//
// The answer is a property of the fact's own origin, not of the record it
// happens to sit in now. A fact read from an ATS tenant belongs to the
// employer. A fact read from a plain web page belongs to the employer only
// when this run verified that employer's careers page and linked it to this
// record, and the fact was read from that verified link. A fact read from a
// mirror stays the mirror's, even after the record is joined to the employer's
// own posting — the mirror's words never become the employer's.
export function fieldIsEmployerPosting(field, record = null) {
  const origin = field?.origin ?? null;
  if (origin) {
    if (origin.employerPosting === true) return true;
    if (EMPLOYER_PLATFORMS.has(origin.provider)) return true;
    if (origin.authority === 'registered-official') return true;
  }
  const linked = new Set((record?.association?.linkedUrls ?? []).map(canonicalLocal).filter(Boolean));
  const source = field?.source?.url ?? null;
  if (source && linked.size) {
    try { if (linked.has(canonicalLocal(source))) return true; } catch { /* not a URL */ }
  }
  // A fact that carries no stamp of its own — one recorded outside a page read
  // — is judged by the standing of the record it sits in.
  if (!origin && record) return isEmployerPosting(record);
  return false;
}

// A closure statement only closes the vacancy when the page that made it is
// the employer's own posting, bound to this advertisement. A mirror or
// aggregator that says "this job has expired" proves that advertisement
// expired, and nothing about the employer's role.
//
// A record read from an ATS tenant is the employer's own posting. A record
// read from a plain web page is only the employer's posting once this run has
// verified that employer's careers page and linked it to this record; until
// then the page is a mirror or an aggregator, and its expiry notice speaks
// for that advertisement alone.
export function closureBoundToAdvertisement(record, url) {
  if (!url) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  const employerPosting = isEmployerPosting(record);
  const known = new Set((record.aliases ?? []).map(canonicalLocal).filter(Boolean));
  if (known.has(canonicalLocal(url))) return employerPosting;
  const tenant = tenantOf(url);
  const id = record.ids?.advertisement;
  if (tenant && tenant.account) {
    const ownProvider = record.provider && record.provider !== 'html';
    const ownAccount = String(record.account ?? '').toLowerCase();
    if (ownProvider && ownProvider !== tenant.provider) return false;
    if (ownAccount && tenant.account.toLowerCase() !== ownAccount) return false;
    if (id && !u.pathname.split('/').includes(String(id))) return false;
    return true;
  }
  if (id && u.pathname.split('/').includes(String(id))) return employerPosting;
  return false;
}

// A form that belongs to a general talent community rather than to one
// vacancy. It collects sign-ups, not applications for this advertisement, so
// it is never the route to this role.
const POOL_FORM_TEXT = /\b(?:talent[\s-]?(?:pool|community|register|network)|speculative applications?|general applications?|expressions? of interest|register your interest)\b/i;
// The same declaration in the form's own name or in the address it posts to.
const POOL_FORM_NAME = /\b(?:talent[-_ ]?(?:pool|community|register|network)|speculative|general[-_ ]?application|job[-_ ]?alerts?|expressions?[-_ ]?of[-_ ]?interest|register[-_ ]?your[-_ ]?interest|eoi|newsletter|subscribe)\b/i;
// The numeric job id a plain site's own path names. It is the only
// advertisement identity such a page carries.
const PLAIN_JOB_ID = /\/(?:jobs?|requisitions?|positions?|vacancies|advertisements?)\/(\d+)(?:\/|$)/i;
// The advertisement a form action names, with the tenant that owns it. An ATS
// URL names its advertisement whatever shape the id has: a Greenhouse number
// or a Lever UUID.
function actionIdentity(action) {
  const identity = adIdentity(action.href);
  if (identity?.advertisement) return { provider: identity.provider, account: identity.account, advertisement: String(identity.advertisement) };
  const plain = action.pathname.match(PLAIN_JOB_ID)?.[1];
  return plain ? { provider: null, account: null, advertisement: plain } : null;
}
// The advertisements a record can be known by: the id it carries, and the
// ids its own page and its aliases name.
function recordAdvertisements(record) {
  const ids = new Set();
  if (record.ids?.advertisement) ids.add(String(record.ids.advertisement));
  for (const url of [record.canonicalUrl, ...(record.aliases ?? [])]) {
    const identity = adIdentity(url);
    if (identity?.advertisement) ids.add(String(identity.advertisement));
    const plain = (() => { try { return new URL(String(url)).pathname.match(PLAIN_JOB_ID)?.[1] ?? null; } catch { return null; } })();
    if (plain) ids.add(plain);
  }
  return ids;
}
// The tenants a record is known on under one provider. A form that posts to
// another tenant's job page is not this vacancy's form.
function recordTenants(record, provider) {
  const out = new Set();
  for (const url of [record.canonicalUrl, ...(record.aliases ?? [])]) {
    const identity = adIdentity(url);
    if (identity && identity.provider === provider && identity.account) out.add(String(identity.account).toLowerCase());
  }
  if (record.provider === provider && record.account) out.add(String(record.account).toLowerCase());
  return out;
}
// The text of a form with its element boundaries kept: the words of two
// elements do not run together, or "talent community" and "Submit" become one
// word that says neither.
function formText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(formText).join(' ');
}
// Whether a form is a general sign-up form rather than this vacancy's
// application form. The form's own text is read for the pool declaration it
// makes; its name and the address it posts to are read for the pool they
// announce.
function generalPoolForm($, form, action) {
  const f = $(form);
  if (POOL_FORM_NAME.test(f.attr('id') ?? '') || POOL_FORM_NAME.test(f.attr('name') ?? '') || POOL_FORM_NAME.test(action.pathname)) return true;
  return POOL_FORM_TEXT.test(clean(formText(form)));
}
export function formProof(record, response) {
  if (response.status !== 200 || record.authority !== 'registered-official') return null;
  const $ = load(response.body), title = key(record.fields.title?.value);
  if (!title || !$('h1,h2,title').toArray().some(e => key($(e).text()).includes(title))) return null;
  if (CLOSED_NOTICE.test(textOf(response.body))) return null;
  const known = new Set(record.aliases.map(canonicalLocal).filter(Boolean));
  const id = record.ids.advertisement;
  const tied = known.has(canonicalLocal(response.url)) || (id && new URL(response.url).pathname.split('/').includes(String(id)));
  if (!tied) return null;
  const advertisements = recordAdvertisements(record);
  for (const form of $('form').toArray()) {
    const f = $(form);
    let action;
    try { action = publicUrl(new URL(f.attr('action') || response.url, response.url).href); } catch { continue; }
    // The action has to belong to this advertisement. A readable page is not
    // enough: a form that posts to another advertisement's id is that other
    // advertisement's form, whatever heading the page carries.
    const declared = actionIdentity(action);
    if (declared && advertisements.size && !advertisements.has(declared.advertisement)) continue;
    if (declared?.provider) {
      const tenants = recordTenants(record, declared.provider);
      if (tenants.size && declared.account && !tenants.has(String(declared.account).toLowerCase())) continue;
    }
    const hiddenAd = f.find('input[name="job_id"],input[name="jobId"],input[name="gh_jid"]').first().attr('value');
    if (hiddenAd && id && hiddenAd !== String(id)) continue;
    // A general talent-community form is not a route to this vacancy.
    if (generalPoolForm($, form, action)) continue;
    const hasEmail = f.find('input[type="email"],input[name*="email"],input[id*="email"]').length;
    const personal = f.find('input[name*="name"],input[id*="name"],input[type="file"]').length;
    const submit = f.find('button[type="submit"],input[type="submit"],button').toArray().some(e => /apply|submit (?:your )?application|send application/i.test($(e).text() || $(e).attr('value') || ''));
    if (hasEmail && personal && submit) return { kind: 'job-specific-form', url: response.url, observedAt: response.observedAt, snapshot: response.snapshot, quote: clean(f.text()).slice(-400) };
  }
  return null;
}

// --- identity ---------------------------------------------------------------
// IDs are namespaced by platform, tenant and employer. A bare number is never
// treated as an identity on its own.
const EMPLOYER_NOISE = new Set(['ltd', 'limited', 'plc', 'inc', 'incorporated', 'llc', 'llp', 'co', 'company', 'corp', 'corporation', 'group', 'holding', 'holdings', 'the']);
const EMPLOYER_COUNTRY = new Set(['new zealand', 'nz', 'aotearoa']);
export function employerKey(value) {
  const words = key(value ?? '').split(' ').filter(Boolean);
  if (!words.length) return '';
  // A display name is not an identity. Legal-entity suffixes and a trailing
  // country token are dropped, so "Acme Ltd" and "Acme" are one employer and
  // "Westpac New Zealand" is the same brand as "Westpac".
  const tokens = words.filter(w => !EMPLOYER_NOISE.has(w));
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1], pair = tokens.slice(-2).join(' ');
    if (EMPLOYER_COUNTRY.has(last)) tokens.pop();
    else if (EMPLOYER_COUNTRY.has(pair)) tokens.splice(-2, 2);
    else break;
  }
  return tokens.join(' ') || words.join(' ');
}
// A brand alias: one name carries the other as its own leading words. "Acme"
// is the brand of "Acme International", and one name that merely contains
// another ("NotAcme" contains "Acme") is a different employer. Containment
// that ignores the word boundary merges two tenants into one and hides one
// employer's vacancy behind the other's.
function brandAlias(ka, kb) {
  const short = ka.split(' ').filter(Boolean), long = kb.split(' ').filter(Boolean);
  if (short.length > long.length) return brandAlias(kb, ka);
  if (!short.length || short.length === long.length) return false;
  return short.every((word, index) => word === long[index]);
}
export function employerCompatible(a, b) {
  const ka = employerKey(a), kb = employerKey(b);
  if (!ka || !kb) return true;
  if (ka === kb) return true;
  // Same employer written differently ("Contact Energy" / "ContactEnergy").
  if (ka.replace(/\s+/g, '') === kb.replace(/\s+/g, '')) return true;
  // Brand alias: one display name carries the other as its own words
  // (Westpac vs Westpac Group).
  return brandAlias(ka, kb);
}
export function idKeys(record) {
  const keys = [], acct = (record.account ?? '').toLowerCase(), provider = record.provider ?? 'external';
  if (record.ids?.advertisement) keys.push(`ad:${provider}:${acct}:${record.ids.advertisement}`);
  if (record.ids?.apiPosting) keys.push(`api:${provider}:${acct}:${record.ids.apiPosting}`);
  if (record.ids?.platformJob) keys.push(`pj:${provider}:${acct}:${record.ids.platformJob}`);
  if (record.ids?.requisition) keys.push(`req:${employerKey(record.fields?.employer?.value ?? record.lead?.employer)}:${key(record.ids.requisition)}`);
  for (const u of record.aliases ?? []) { const c = canonicalLocal(u); if (c) keys.push(`url:${c}`); }
  return keys;
}
export function sameIdentity(a, b) {
  const reqA = a.ids?.requisition, reqB = b.ids?.requisition;
  // A confirmed, different requisition number is a different vacancy, even if a URL or title is reused.
  if (reqA && reqB && key(reqA) !== key(reqB)) return false;
  const sameBoard = a.provider === b.provider && (a.account ?? '').toLowerCase() === (b.account ?? '').toLowerCase();
  if (sameBoard) {
    if (a.ids?.advertisement && b.ids?.advertisement) return String(a.ids.advertisement) === String(b.ids.advertisement);
    if (a.ids?.platformJob && b.ids?.platformJob) return String(a.ids.platformJob) === String(b.ids.platformJob);
  }
  // The same requisition number seen on two boards: the employer's own
  // identifier agrees, so a display-name difference must not veto it. The
  // names have to be there to agree, though: a record that names no employer
  // says nothing about whose requisition this is, and two tenants number
  // their vacancies from one. The URL comparison below still decides.
  if (reqA && reqB) {
    const ea = a.fields?.employer?.value ?? a.lead?.employer ?? '';
    const eb = b.fields?.employer?.value ?? b.lead?.employer ?? '';
    if (employerKey(ea) && employerKey(eb)) return employerCompatible(ea, eb);
  }
  const urlsA = new Set((a.aliases ?? []).map(canonicalLocal).filter(Boolean));
  return (b.aliases ?? []).map(canonicalLocal).filter(Boolean).some(u => urlsA.has(u));
}
