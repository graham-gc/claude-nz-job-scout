import { load, decodeEntities } from './html.mjs';
import { hash } from './store.mjs';
import { isoDay, looksLikeTimestamp, parseMoment, parseNumeric } from './dates.mjs';
import { publicUrl } from './net.mjs';
import { placeFragment } from './places.mjs';
import { tenantOf } from './site.mjs';

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
const REJECTED_PHRASES = { engagement: /\bvolunteer\s+(?:time\s+off|leave|day|days|hours|programme|opportunity|opportunities|break)\b/i, contractType: /\b(?:permanent|fixed[\s-]?term|temporary)\s+(?:employees?|staff|candidates?)\s+(?:receive|enjoy|benefit|are eligible|get)\b/i, workload: /\b(?:full[\s-]?time|part[\s-]?time)\s+(?:employees?|staff|workers?|colleagues?)\s+(?:receive|enjoy|benefit|get|are eligible)\b/i, duration: /\b(?:sick leave|annual leave|parental leave|unpaid leave|long service leave|wait(?:ing)? period|notice period|probation period|focus areas?)\b/i };

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
  const hours = body.match(/\b(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per\s*(?:week|wk)|\/\s*(?:week|wk)|p\.?\s*w\.?\b)/i);
  if (hours && Number(hours[1]) > 0 && Number(hours[1]) <= 60) out.hoursPerWeek = { value: Number(hours[1]) };
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

export function observeText(record, text, response) {
  const fields = record.fields;
  const set = (name, value, quote = value) => { if (!fields[name]?.value && value !== null && value !== undefined && value !== '') fields[name] = fact(value, response, quote); };
  const body = normaliseText(text);
  set('duties', body);
  const workload = declaration(body, WORKLOAD_PATTERNS, { reject: REJECTED_PHRASES.workload });
  set('workload', workload ? (workload.value.toLowerCase().startsWith('full') ? 'full-time' : 'part-time') : null, workload?.quote);
  const hours = body.match(/\b(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per\s*(?:week|wk)|\/\s*(?:week|wk)|p\.?\s*w\.?\b)/i);
  set('hoursPerWeek', hours && Number(hours[1]) > 0 && Number(hours[1]) <= 60 ? Number(hours[1]) : null, hours?.[0]);
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
  const kind = poolKind(record, body);
  // A channel that recruits employers is neither a vacancy nor a talent pool:
  // the page itself is the employer-facing side, and the candidate-side entry
  // point on it is not a verified application route.
  const channel = channelKind(body);
  if (channel) record.opportunityKind = fact('employer-channel', response, channel);
  else if (kind) record.opportunityKind = fact('talent-pool', response, kind);
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
      if (!fields[name]?.value) fields[name] = fact(closing.value, response, `${phrase[0]}${closing.quote}`, 'deadline-date');
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
  { re: /\bwe(?:'ll|\s+will)\s+add\s+you\s+to\s+our\s+[^.]{0,40}(?:careers\s+newsletter|talent\s+(?:pool|community))\b/i },
  { re: /\bdon'?t\s+see\s+the\s+right\s+(?:opportunity|role|position)\b/i },
];
export function poolKind(record, body) {
  const title = key(record.fields.title?.value ?? record.lead.title ?? '');
  if (POOL_TITLE.test(title)) return title;
  for (const sentence of sentences(body)) {
    for (const pattern of POOL_SUBJECT) {
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
export function channelKind(body) {
  const text = String(body ?? '');
  if (!text) return null;
  if (CANDIDATE_ROUTE.test(text)) return null;
  const hits = CHANNEL_SUBJECT.filter(p => p.re.test(text));
  if (hits.length < 2) return null;
  for (const sentence of sentences(text)) {
    if (hits.some(h => h.re.test(sentence))) return clean(sentence).slice(0, 300);
  }
  return hits.map(h => h.re.source).join('；').slice(0, 300);
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
  observeText(record, text, response);
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
function mailtoAddresses($) {
  const out = [];
  $('a[href]').each((_, el) => {
    const href = String(el.attribs?.href ?? '').trim();
    if (!/^mailto:/i.test(href)) return;
    const addr = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0]).trim();
    if (addr && !out.includes(addr)) out.push(addr);
  });
  return out;
}
// The prose of the posting with mailto link labels removed: a link label is
// not a delivery instruction written by the employer.
function proseWithoutMailto(body) {
  const $ = load(String(body ?? ''));
  const main = $('main').length ? $('main').clone() : $('body').clone();
  main.find('script,style,nav,footer,aside').remove();
  for (const el of main.find('a[href]').toArray()) {
    if (!/^mailto:/i.test(String(el.attribs?.href ?? '').trim())) continue;
    const parent = el.parent;
    if (!parent) continue;
    const index = parent.children.indexOf(el);
    if (index >= 0) parent.children.splice(index, 1);
  }
  return normaliseText(main.text());
}
export function emailRoute(text, body, response) {
  if (/(?:do not|not accept|cannot accept)[^.]{0,50}(?:by email|via email|email applications)/i.test(text)) return null;
  const prose = proseWithoutMailto(body);
  // Instructions are read sentence by sentence, so a period inside an address
  // ("careers@acme.example") does not cut the sentence short.
  const sentences = prose.split(/(?<=[.!?])\s+/).map(s => clean(s)).filter(Boolean);
  const written = String(text ?? '').split(/(?<=[.!?])\s+/).map(s => clean(s)).filter(Boolean);
  for (const sentence of sentences) {
    if (!EMAIL_INSTRUCTIONS.some(pattern => pattern.test(sentence))) continue;
    const inline = sentence.match(/([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/);
    const email = inline ? inline[1] : (mailtoAddresses(load(String(body ?? '')))[0] ?? null);
    if (!email) continue;
    // The instruction shown is the employer's own wording. When the address is
    // written next to the instruction, that sentence is used; a link label alone
    // is not a delivery instruction.
    const withAddress = written.find(s => s.includes(email) && EMAIL_INSTRUCTIONS.some(pattern => pattern.test(s)));
    const instruction = withAddress ?? sentence;
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
  'no longer accepting applications',
  'applications? (?:are|have) (?:now )?closed',
  'applications? (?:are|have) no longer accepted'
].join('|'), 'i');

export function fromHtml(record, response) {
  const $ = load(response.body), f = record.fields;
  const main = $('main').length ? $('main').clone() : $('body').clone();
  main.find('script,style,nav,footer,aside').remove();
  const text = normaliseText(main.text());
  const h1 = clean($('h1').first().text()), expectedTitle = f.title?.value ?? record.lead.title;
  const responseId = new URL(response.url).pathname.split('/');
  const responseCanonical = canonicalLocal(response.url);
  if (!record.aliases.includes(responseCanonical) && !(record.ids.advertisement && responseId.includes(record.ids.advertisement))) {
    record.readState = 'unreadable'; record.detailError = 'Redirect target is not bound to the original advertisement'; return record;
  }
  if (expectedTitle && h1 && !key(h1).includes(key(expectedTitle)) && !key(expectedTitle).includes(key(h1))) {
    record.readState = 'unreadable'; record.detailError = 'Page heading does not match vacancy; possible generic redirect/soft 404'; return record;
  }
  const posting = jobPostings($).find(j => !f.title?.value || key(j.title) === key(f.title.value));
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
  if (posting) {
    f.title = fact(posting.title, response);
    f.employer = fact(typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name, response);
    // A JobPosting's datePosted is the date the employer first put the job up
    // (Google's schema: "the original date that employer posted the job"), so
    // it states the first appearance rather than one posting of it.
    if (posting.datePosted) setPostedAt(f, posting.datePosted, response, posting.datePosted, 'first-published');
    // A JSON-LD validThrough is the posting's validity window. The page does
    // not call it a deadline, so it is not recorded as one: its meaning stays
    // unestablished until the employer's own posting says otherwise.
    if (posting.validThrough && !f.closesAt?.value) f.closesAt = fact(posting.validThrough, response, posting.validThrough, 'valid-through');
    const locations = [].concat(posting.jobLocation ?? []).map(x => typeof x === 'string' ? x : [x.address?.addressLocality, x.address?.addressRegion, x.address?.addressCountry].filter(Boolean).join(', '));
    if (locations.length && !f.location?.value) f.location = fact(locations.join(' | '), response);
    // JobPosting.identifier is not universally the employer's requisition number.
    if (posting.identifier?.value) record.ids.platformIdentifier = String(posting.identifier.value);
  }
  if (!f.title?.value && h1) f.title = fact(h1, response);
  if (!f.employer?.value && record.authority === 'registered-official' && record.lead.employer) f.employer = fact(record.lead.employer, response, record.lead.employer);
  observeText(record, text, response);
  if (!f.location?.value) {
    const candidate = locationCandidate($, text, response.body);
    if (candidate) f.location = fact(candidate.value, response, candidate.quote);
  }
  const req = text.match(/(?:Requisition(?: ID)?|Job (?:reference|number)|Position Number|Reference|REF)\s*:?\s*([\w-]{4,30})/i);
  if (req && !record.ids.requisition) record.ids.requisition = req[1];
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

export function formProof(record, response) {
  if (response.status !== 200 || record.authority !== 'registered-official') return null;
  const $ = load(response.body), title = key(record.fields.title?.value);
  if (!title || !$('h1,h2,title').toArray().some(e => key($(e).text()).includes(title))) return null;
  if (CLOSED_NOTICE.test(textOf(response.body))) return null;
  const known = new Set(record.aliases.map(canonicalLocal).filter(Boolean));
  const id = record.ids.advertisement;
  const tied = known.has(canonicalLocal(response.url)) || (id && new URL(response.url).pathname.split('/').includes(String(id)));
  if (!tied) return null;
  for (const form of $('form').toArray()) {
    const f = $(form);
    let action;
    try { action = publicUrl(new URL(f.attr('action') || response.url, response.url).href); } catch { continue; }
    const declaredAd = action.pathname.match(/\/jobs\/(\d+)(?:\/|$)/)?.[1];
    const hiddenAd = f.find('input[name="job_id"],input[name="jobId"],input[name="gh_jid"]').first().attr('value');
    if ((declaredAd && id && declaredAd !== String(id)) || (hiddenAd && id && hiddenAd !== String(id))) continue;
    const hasEmail = f.find('input[type="email"],input[name*="email"],input[id*="email"]').length;
    const personal = f.find('input[name*="name"],input[id*="name"],input[type="file"]').length;
    const submit = f.find('button[type="submit"],input[type="submit"],button').toArray().some(e => /apply|submit (?:your )?application|send application/i.test($(e).text() || $(e).attr('value') || ''));
    if (hasEmail && personal && submit && !/newsletter|subscribe/i.test(f.attr('id') ?? '')) return { kind: 'job-specific-form', url: response.url, observedAt: response.observedAt, snapshot: response.snapshot, quote: clean(f.text()).slice(-400) };
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
export function employerCompatible(a, b) {
  const ka = employerKey(a), kb = employerKey(b);
  if (!ka || !kb) return true;
  if (ka === kb) return true;
  // Same employer written differently ("Contact Energy" / "ContactEnergy").
  if (ka.replace(/\s+/g, '') === kb.replace(/\s+/g, '')) return true;
  // Brand alias: one display name contains the other (Westpac vs Westpac New Zealand).
  return ka.includes(kb) || kb.includes(ka);
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
  // identifier agrees, so a display-name difference must not veto it.
  if (reqA && reqB) return employerCompatible(a.fields?.employer?.value ?? a.lead?.employer, b.fields?.employer?.value ?? b.lead?.employer);
  const urlsA = new Set((a.aliases ?? []).map(canonicalLocal).filter(Boolean));
  return (b.aliases ?? []).map(canonicalLocal).filter(Boolean).some(u => urlsA.has(u));
}
