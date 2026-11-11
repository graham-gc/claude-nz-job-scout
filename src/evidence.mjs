import { load } from 'cheerio';
import { hash } from './store.mjs';
import { publicUrl } from './net.mjs';

export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const key = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function canonical(value) {
  const u = publicUrl(value); u.hash = '';
  for (const p of [...u.searchParams.keys()]) if (/^(utm_.+|refId|trackingId|position|pageNum|oga|origin|trk)$/i.test(p)) u.searchParams.delete(p);
  if (/^(www|nz)\.linkedin\.com$/.test(u.hostname)) {
    const id = u.pathname.match(/\/jobs\/view\/(?:.*-)?(\d+)\/?$/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
  }
  return u.toString();
}
export const fact = (value, response, quote = value, semantics) => value === null || value === undefined || value === ''
  ? { value: null, absence: 'not-in-this-response', source: { url: response.url, observedAt: response.observedAt, snapshot: response.snapshot } }
  : { value, source: { url: response.url, observedAt: response.observedAt, snapshot: response.snapshot }, quote: clean(typeof quote === 'object' ? JSON.stringify(quote) : quote), ...(semantics ? { semantics } : {}) };
export const textOf = html => { const $ = load(String(html ?? '')); $('script,style,nav,footer').remove(); return clean($.root().text()); };
export function newRecord(lead, run) {
  return { recordId: hash(run + canonical(lead.url)).slice(0, 24), canonicalUrl: canonical(lead.url), aliases: [canonical(lead.url)],
    provider: lead.provider ?? 'html', account: lead.account ?? '', authority: lead.authority ?? 'discovery-only',
    lead: { title: lead.title ?? '', employer: lead.employer ?? '', discoveredFrom: lead.discoveredFrom ?? lead.url },
    ids: { advertisement: lead.advertisement ?? null, platformJob: null, requisition: null },
    fields: {}, readState: 'not-read', closure: null, application: { status: 'unverified', reason: 'Not checked' },
    detailUrl: lead.detailUrl ?? null, applicationUrl: lead.applicationUrl ?? null, sourceKey: lead.sourceKey ?? 'web-search',
  };
}

export function observeText(record, text, response) {
  const fields = record.fields;
  const set = (name, value, quote = value) => { if (!fields[name]?.value) fields[name] = fact(value, response, quote); };
  set('duties', text);
  const workload = text.match(/\b(?:full[ -]?time|part[ -]?time)\b/i);
  set('workload', workload ? /^full/i.test(workload[0]) ? 'full-time' : 'part-time' : null, workload?.[0]);
  const hours = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per\s*(?:week|wk)|\/\s*(?:week|wk)|p\.?\s*w\.?\b)/i);
  set('hoursPerWeek', hours ? Number(hours[1]) : null, hours?.[0]);
  const duration = text.match(/\b(\d{1,2})[ -]?(weeks?|months?)(?:[ -](?:fixed|contract|internship)|\s+(?:fixed|contract|internship|placement|programme))/i);
  set('durationWeeks', duration ? Number(duration[1]) * (/month/i.test(duration[2]) ? 4.35 : 1) : null, duration?.[0]);
  set('contractType', /\bpermanent\b/i.test(text) ? 'permanent' : /\bfixed[ -]term\b/i.test(text) ? 'fixed-term' : null);
  set('workArrangement', /\bhybrid\b/i.test(text) ? 'hybrid' : /\b(?:fully remote|remote.only|work from anywhere)\b/i.test(text) ? 'remote' : /\b(?:on.site|in.person)\b/i.test(text) ? 'on-site' : null);
  const engagement = text.match(/\b(?:independent contractor|self.employed|employment agreement|fixed.term employee|permanent employee|volunteer)\b/i);
  set('engagement', engagement ? /contractor|self.employed/i.test(engagement[0]) ? 'independent-contractor' : /volunteer/i.test(engagement[0]) ? 'volunteer' : 'employee' : null, engagement?.[0]);
  const pay = text.match(/\b(?:unpaid|paid internship|paid volunteer|expenses (?:are )?reimbursed|reimbursed expenses)\b/i);
  set('payStatus', pay ? /unpaid/i.test(pay[0]) ? 'unpaid' : /reimburs/i.test(pay[0]) ? 'reimbursed' : 'paid' : null, pay?.[0]);
  set('salary', text.match(/(?:NZ\$|\$)\s*[\d,]+(?:\s*[–-]\s*(?:NZ\$|\$)?\s*[\d,]+)?\s*(?:per (?:annum|year|hour)|p\.?a\.?|\/hr)/i)?.[0] ?? null);
  const pool = text.match(/expressions? of interest|talent (?:pool|register)|register (?:your )?interest/i);
  if (pool) record.opportunityKind = fact('talent-pool', response, pool[0]);
  if (!fields.engagement?.value && /\bsalary\b/i.test(text) && /\b(?:annual leave|kiwisaver|employee benefits)\b/i.test(text)) set('engagement', 'employee', text.match(/.{0,45}\bsalary\b.{0,100}/i)?.[0]);
  const dates = name => {
    const pattern = name === 'postedAt'
      ? /(?:Posted on|Date posted|Date published)\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2})/i
      : /(?:Closing (?:on|date)|Applications? (?:must be submitted online by|close(?:s)?(?: on)?))\s*:?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2})/i;
    const m = text.match(pattern);
    if (m && !fields[name]?.value) {
      const date = new Date(m[1].replace(/(\d)(st|nd|rd|th)/, '$1') + ' UTC');
      if (!isNaN(date)) fields[name] = fact(date.toISOString().slice(0, 10), response, m[0], name === 'postedAt' ? 'advertised-date' : 'deadline-date');
    }
  };
  dates('postedAt'); dates('closesAt');
}

export function fromApi(record, job, response, company) {
  const f = record.fields, p = record.provider;
  record.ids.advertisement = String(job.id ?? record.ids.advertisement ?? '');
  record.ids.platformJob = job.internal_job_id == null ? null : String(job.internal_job_id);
  record.ids.requisition = job.requisition_id ?? job.refNumber ?? null;
  f.title = fact(job.title ?? job.name ?? job.text, response);
  f.employer = fact(job.company_name ?? job.company?.name ?? company, response);
  if (f.employer.source && !job.company_name && !job.company?.name) f.employer.source.kind = 'registered-official-board';
  const parts = Object.values(job.jobAd?.sections ?? {}).map(x => x?.text ?? '').join('\n');
  const text = textOf(job.content ?? job.descriptionHtml ?? job.descriptionPlain ?? [job.description, ...(job.lists ?? []).map(x => `${x.text}: ${x.content}`), parts].filter(Boolean).join('\n'));
  const location = typeof job.location === 'object' ? job.location?.name ?? [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ') : job.location ?? job.categories?.location;
  f.location = fact(location, response);
  const posted = p === 'greenhouse' ? job.first_published : p === 'ashby' ? job.publishedAt : p === 'smartrecruiters' ? job.releasedDate : job.createdAt;
  if (posted) f.postedAt = fact(typeof posted === 'number' ? new Date(posted).toISOString() : posted, response, posted,
    p === 'greenhouse' ? 'first-published' : p === 'lever' ? 'platform-created' : 'last-published');
  if (job.updated_at) f.updatedAt = fact(job.updated_at, response, job.updated_at, 'updated');
  if (job.application_deadline) f.closesAt = fact(job.application_deadline, response, job.application_deadline, 'deadline');
  const employment = job.employmentType ?? job.categories?.commitment ?? job.typeOfEmployment?.label;
  if (employment) f.workload = fact(/part/i.test(employment) ? 'part-time' : /full/i.test(employment) ? 'full-time' : null, response, employment);
  if (job.workplaceType) f.workArrangement = fact(job.workplaceType.toLowerCase().replace('onsite', 'on-site'), response);
  if (job.applyUrl) record.applicationUrl = job.applyUrl;
  observeText(record, text, response);
  record.readState = text.length >= 100 ? 'read' : 'partial';
  record.detailUrl = p === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${record.account}/jobs/${record.ids.advertisement}`
    : p === 'smartrecruiters' ? `https://api.smartrecruiters.com/v1/companies/${record.account}/postings/${record.ids.advertisement}` : null;
  record.aliases = [...new Set([...record.aliases, ...[job.absolute_url, job.hostedUrl, job.jobUrl, job.applyUrl].filter(Boolean).map(canonical)])];
  return record;
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
export function fromHtml(record, response) {
  const $ = load(response.body), f = record.fields;
  const main = $('main').length ? $('main').clone() : $('body').clone();
  main.find('script,style,nav,footer,aside').remove();
  const text = clean(main.text());
  const h1 = clean($('h1').first().text()), expectedTitle = f.title?.value ?? record.lead.title;
  const responseId = new URL(response.url).pathname.split('/');
  if (!record.aliases.includes(canonical(response.url)) && !(record.ids.advertisement && responseId.includes(record.ids.advertisement))) {
    record.readState = 'unreadable'; record.detailError = 'Redirect target is not bound to the original advertisement'; return record;
  }
  if (expectedTitle && h1 && !key(h1).includes(key(expectedTitle)) && !key(expectedTitle).includes(key(h1))) {
    record.readState = 'unreadable'; record.detailError = 'Page heading does not match vacancy; possible generic redirect/soft 404'; return record;
  }
  const posting = jobPostings($).find(j => !f.title?.value || key(j.title) === key(f.title.value));
  const closed = text.match(/(?:this (?:job|position|vacancy) (?:has expired|is no longer available|is now closed)|no longer accepting applications|this job is no longer advertised|applications (?:are|have) (?:now )?closed)/i);
  if (closed) {
    record.closure = { scope: 'advertisement', ...fact(true, response, closed[0]) };
    record.readState = 'closed-stated'; return record;
  }
  if (posting) {
    f.title = fact(posting.title, response);
    f.employer = fact(typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name, response);
    if (posting.datePosted) f.postedAt = fact(posting.datePosted, response, posting.datePosted, 'advertised-date');
    if (posting.validThrough) f.closesAt = fact(posting.validThrough, response, posting.validThrough, 'deadline');
    const locations = [].concat(posting.jobLocation ?? []).map(x => typeof x === 'string' ? x : [x.address?.addressLocality, x.address?.addressRegion, x.address?.addressCountry].filter(Boolean).join(', '));
    if (locations.length) f.location = fact(locations.join(' | '), response);
    // JobPosting.identifier is not universally the employer's requisition number.
    if (posting.identifier?.value) record.ids.platformIdentifier = String(posting.identifier.value);
  }
  if (!f.title?.value && h1) f.title = fact(h1, response);
  if (!f.employer?.value && record.authority === 'registered-official' && record.lead.employer) f.employer = fact(record.lead.employer, response, record.lead.employer);
  observeText(record, text, response);
  if (!f.location?.value) {
    const city = text.match(/\b(?:Auckland(?: City Campus|, New Zealand)?|Wellington|Christchurch|Hamilton|Tauranga)\b/i);
    // Only explicit job metadata, not a company's headquarters in its footer.
    const meta = clean($('[class*="location"],[data-testid="job-location"],.job-location').first().text());
    if (meta && city) f.location = fact(meta, response);
  }
  const req = text.match(/(?:Requisition(?: ID)?|Job (?:reference|number)|Position Number|Reference)\s*:?\s*([\w-]{4,30})/i);
  if (req) record.ids.requisition ??= req[1];
  record.applyLinks = [];
  $('a[href]').each((_, e) => {
    const a = $(e), label = clean(a.text());
    if (/^(?:apply(?: (?:now|for this (?:job|role)|via \w+))?|i.m interested|submit application)$/i.test(label)) {
      try { record.applyLinks.push({ url: new URL(a.attr('href'), response.url).href, label }); } catch {}
    }
  });
  const email = text.match(/(?:apply|send|submit)[\s\S]{0,140}?(?:CV|resume|application|cover letter)[\s\S]{0,100}?([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i);
  if (email && !/(?:do not|not accept|cannot accept)[^.]{0,50}(?:by email|via email|email applications)/i.test(text)) {
    record.emailRoute = { email: email[1], instruction: email[0], source: { url: response.url, observedAt: response.observedAt, snapshot: response.snapshot } };
  }
  record.readState = h1 && text.length >= 100 ? 'read' : 'unreadable';
  record.observedHtml = { url: response.url, snapshot: response.snapshot, observedAt: response.observedAt };
  return record;
}

export function formProof(record, response) {
  if (response.status !== 200 || record.authority !== 'registered-official') return null;
  const $ = load(response.body), title = key(record.fields.title?.value);
  if (!title || !$('h1,h2,title').toArray().some(e => key($(e).text()).includes(title))) return null;
  if (/no longer accepting applications|this job (?:has expired|is no longer available)|applications are closed/i.test(textOf(response.body))) return null;
  const known = new Set(record.aliases.map(canonical));
  const id = record.ids.advertisement;
  const tied = known.has(canonical(response.url)) || (id && new URL(response.url).pathname.split('/').includes(String(id)));
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

export function sameIdentity(a, b) {
  if (a.fields.employer?.value && b.fields.employer?.value && key(a.fields.employer.value) !== key(b.fields.employer.value)) return false;
  if (a.ids.requisition && b.ids.requisition) return key(a.ids.requisition) === key(b.ids.requisition);
  if (a.provider === b.provider && a.account.toLowerCase() === b.account.toLowerCase()) {
    if (a.ids.advertisement && b.ids.advertisement && a.ids.advertisement === b.ids.advertisement) return true;
    if (a.ids.platformJob && b.ids.platformJob && a.ids.platformJob === b.ids.platformJob) return true;
  }
  return a.aliases.some(u => b.aliases.includes(u));
}
