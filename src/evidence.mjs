import { load, decodeEntities } from './html.mjs';
import { hash } from './store.mjs';
import { publicUrl } from './net.mjs';

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
// order it was read in. A page that states the publication date replaces an
// API timestamp that only says "last published"; two equally strong readings
// never overwrite each other.
const POSTED_STRENGTH = { 'first-published': 4, 'advertised-date': 3, 'last-published': 2, 'platform-created': 1, 'updated': 0 };
export function setPostedAt(fields, value, response, quote, semantics) {
  if (value == null || value === '') return;
  const strength = POSTED_STRENGTH[semantics] ?? 1;
  const current = fields.postedAt;
  if (current?.value && (POSTED_STRENGTH[current.semantics] ?? 1) >= strength) return;
  fields.postedAt = fact(value, response, quote, semantics);
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
    detailUrl: lead.detailUrl ?? null, applicationUrl: lead.applicationUrl ?? null, sourceKey: lead.sourceKey ?? 'web-search',
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
  { re: /\b(fixed[\s-]?term)\s+(?:contract|position|role|employment)\b/i },
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
  { re: /\b(\d{1,2})\s*[-–]?\s*(weeks?|months?)\s+(?:fixed[\s-]?term\s+)?(?:contract|term|placement|programme|program|internship)\b/i },
  { re: /\b(?:fixed[\s-]?term|contract|placement|programme|program|internship)\s*(?:of|for)?\s*(\d{1,2})\s*[-–]?\s*(weeks?|months?)\b/i },
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
  if (kind) record.opportunityKind = fact('talent-pool', response, kind);
  const dates = name => {
    const pattern = name === 'postedAt'
      ? /(?:Posted on|Date posted|Date published)\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2})/i
      : /(?:Closing (?:on|date)|Applications? (?:must be submitted online by|close(?:s)?(?: on)?))\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2})/i;
    const m = body.match(pattern);
    if (m) {
      const date = new Date(m[1].replace(/(\d)(st|nd|rd|th)/, '$1') + ' UTC');
      if (!isNaN(date)) {
        const value = date.toISOString().slice(0, 10);
        if (name === 'postedAt') setPostedAt(fields, value, response, m[0], 'advertised-date');
        else if (!fields[name]?.value) fields[name] = fact(value, response, m[0], 'deadline-date');
      }
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

export function fromApi(record, job, response, company) {
  const f = record.fields, p = record.provider;
  const apiId = job.id ?? record.ids.apiPosting ?? null;
  if (apiId != null) record.ids.apiPosting = String(apiId);
  record.ids.platformJob = job.internal_job_id == null ? record.ids.platformJob : String(job.internal_job_id);
  if (!record.ids.requisition && (job.requisition_id ?? job.refNumber)) record.ids.requisition = job.requisition_id ?? job.refNumber;
  f.title = fact(job.title ?? job.name ?? job.text, response);
  f.employer = fact(job.company_name ?? job.company?.name ?? company, response);
  if (f.employer.source && !job.company_name && !job.company?.name) f.employer.source.kind = 'registered-official-board';
  const parts = Object.values(job.jobAd?.sections ?? {}).map(x => x?.text ?? '').join('\n');
  const text = textOf(job.content ?? job.descriptionHtml ?? job.descriptionPlain ?? [job.description, ...(job.lists ?? []).map(x => `${x.text}: ${x.content}`), parts].filter(Boolean).join('\n'));
  const location = typeof job.location === 'object' ? job.location?.name ?? [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ') : job.location ?? job.categories?.location;
  f.location = fact(location, response);
  const posted = p === 'greenhouse' ? job.first_published : p === 'ashby' ? job.publishedAt : p === 'smartrecruiters' ? job.releasedDate : job.createdAt;
  setPostedAt(f, typeof posted === 'number' ? new Date(posted).toISOString() : posted, response, posted,
    p === 'greenhouse' ? 'first-published' : p === 'lever' ? 'platform-created' : 'last-published');
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
  return record;
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
  const closed = text.match(/(?:this (?:job|position|vacancy|role) (?:has expired|is no longer available|is now closed)|no longer accepting applications|this job is no longer advertised|applications (?:are|have) (?:now )?closed)/i);
  if (closed) {
    record.closure = { scope: closureScope(text), observedAt: response.observedAt, ...fact(true, response, closed[0]) };
    record.readState = 'closed-stated'; return record;
  }
  if (posting) {
    f.title = fact(posting.title, response);
    f.employer = fact(typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name, response);
    if (posting.datePosted) setPostedAt(f, posting.datePosted, response, posting.datePosted, 'advertised-date');
    if (posting.validThrough && !f.closesAt?.value) f.closesAt = fact(posting.validThrough, response, posting.validThrough, 'deadline');
    const locations = [].concat(posting.jobLocation ?? []).map(x => typeof x === 'string' ? x : [x.address?.addressLocality, x.address?.addressRegion, x.address?.addressCountry].filter(Boolean).join(', '));
    if (locations.length && !f.location?.value) f.location = fact(locations.join(' | '), response);
    // JobPosting.identifier is not universally the employer's requisition number.
    if (posting.identifier?.value) record.ids.platformIdentifier = String(posting.identifier.value);
  }
  if (!f.title?.value && h1) f.title = fact(h1, response);
  if (!f.employer?.value && record.authority === 'registered-official' && record.lead.employer) f.employer = fact(record.lead.employer, response, record.lead.employer);
  observeText(record, text, response);
  if (!f.location?.value) {
    const city = text.match(/\b(?:Auckland|Wellington|Christchurch|Hamilton|Tauranga|Dunedin|Napier|Queenstown|Rotorua|Palmerston\s+North|New\s+Plymouth|Whangarei|Invercargill|Hastings|Whanganui)\b/i);
    const meta = clean($('[class*="location"],[data-testid="job-location"],.job-location').first().text());
    if (meta && city) f.location = fact(meta, response);
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
  return record;
}

// Advertisement closure and employer-posted closure are different statements.
export function closureScope(text) {
  return /(?:employer(?:'s)?|our|this)\s+(?:careers?\s+)?(?:page|posting|site)\b[^.]{0,80}\b(?:role|position|job)\b[^.]{0,40}\b(?:closed|no longer|not available)\b/i.test(text)
    ? 'employer-posting' : 'advertisement';
}

export function formProof(record, response) {
  if (response.status !== 200 || record.authority !== 'registered-official') return null;
  const $ = load(response.body), title = key(record.fields.title?.value);
  if (!title || !$('h1,h2,title').toArray().some(e => key($(e).text()).includes(title))) return null;
  if (/no longer accepting applications|this job (?:has expired|is no longer available)|applications are closed/i.test(textOf(response.body))) return null;
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
