import { load } from './html.mjs';
import { hash } from './store.mjs';
import { publicUrl, countDetail } from './net.mjs';
import { newRecord, fromApi, fromHtml, canonical, canonicalLocal, clean } from './evidence.mjs';
import { siteKey, tenantOf } from './site.mjs';

export const SOURCES = [
  { id: 'contact', name: 'Contact Energy', provider: 'smartrecruiters', account: 'ContactEnergy', url: 'https://api.smartrecruiters.com/v1/companies/ContactEnergy/postings?limit=100', officialUrl: 'https://contact.co.nz/About-Us/Careers', boardUrl: 'https://jobs.smartrecruiters.com/contactenergy' },
  { id: 'uoa', name: 'University of Auckland', provider: 'smartrecruiters', account: 'TheUniversityOfAuckland', url: 'https://api.smartrecruiters.com/v1/companies/TheUniversityOfAuckland/postings?limit=100', officialUrl: 'https://vacancies.auckland.ac.nz', boardUrl: 'https://jobs.smartrecruiters.com/TheUniversityOfAuckland' },
  { id: 'accesso', name: 'accesso', provider: 'greenhouse', account: 'accesso', url: 'https://boards-api.greenhouse.io/v1/boards/accesso/jobs?content=true', officialUrl: 'https://accesso.com/careers/', boardUrl: 'https://job-boards.greenhouse.io/accesso' },
  { id: 'pushpay', name: 'Pushpay', provider: 'greenhouse', account: 'pushpay', url: 'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=true', officialUrl: 'https://pushpay.com/about-us/careers/new-zealand/', boardUrl: 'https://job-boards.greenhouse.io/pushpay' },
  { id: 'pushpay-nz', name: 'Pushpay NZ official inventory', provider: 'official-links', account: 'pushpay', url: 'https://pushpay.com/about-us/careers/new-zealand/' },
  { id: 'asb', name: 'ASB Bank', provider: 'asb', account: 'asb', url: 'https://careers.asbgroup.co.nz/search', officialUrl: 'https://careers.asbgroup.co.nz', boardUrl: 'https://careers.asbgroup.co.nz/search' }
];

const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Discovery entry points follow the requested role families and location instead
// of a hard-coded "Auckland software engineer" listing.
export function sourcesFor(config) {
  const list = SOURCES.map(s => ({ ...s }));
  const roles = (config.roleFamilies ?? []).map(slug).filter(Boolean).slice(0, 2);
  const places = config.location?.onsiteCities?.length ? config.location.onsiteCities.map(slug) : [slug(config.location?.country ?? 'New Zealand')];
  const entries = [];
  for (const role of roles.length ? roles : ['jobs']) {
    for (const place of places.length ? places : ['new-zealand']) {
      entries.push({ id: `linkedin-${role}-${place}`, name: `LinkedIn public discovery (${role}, ${place})`, provider: 'linkedin', account: 'public', url: `https://nz.linkedin.com/jobs/${role}-jobs-${place}` });
    }
  }
  return [...list, ...entries.slice(0, 2)];
}

const API_HOSTS = new Set(['boards-api.greenhouse.io', 'api.smartrecruiters.com', 'api.lever.co']);

export function recognised(url) {
  const u = new URL(url), p = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'job-boards.greenhouse.io' && p[0]) return { provider: 'greenhouse', account: p[0], ...(p[1] === 'jobs' && /^\d+$/.test(p[2]) ? { advertisement: p[2] } : {}) };
  if (u.hostname === 'jobs.lever.co' && p[0]) return { provider: 'lever', account: p[0], ...(/^[a-f0-9-]{36}$/.test(p[1] ?? '') ? { advertisement: p[1] } : {}) };
  if (u.hostname === 'jobs.smartrecruiters.com' && p[0]) return { provider: 'smartrecruiters', account: p[0], ...(/^\d+(?:-|$)/.test(p[1] ?? '') ? { advertisement: p[1].split('-')[0] } : {}) };
  if (u.hostname === 'jobs.ashbyhq.com' && p[0]) return { provider: 'ashby', account: p[0], ...(p[1] && !/^\d+$/.test(p[1]) ? { advertisement: p[1] } : {}) };
  if (u.hostname === 'careers.asbgroup.co.nz') return { provider: 'asb', account: 'asb' };
  // An ATS inventory endpoint belongs to one tenant, and is attributed to it.
  if (API_HOSTS.has(u.hostname)) {
    const tenant = tenantOf(url);
    if (tenant?.account) return { provider: tenant.provider, account: tenant.account };
  }
  return { provider: 'html', account: '' };
}
export function resolveLead(url, sources = SOURCES) {
  const shape = recognised(url);
  const registered = sources.find(s => s.provider === shape.provider && s.account.toLowerCase() === shape.account.toLowerCase());
  // A discovered lead is charged to the site it lives on, not to a shared
  // search key: one employer's site is one source, and its budget is its own.
  return { ...shape, url: canonical(url), employer: registered?.name, sourceKey: registered?.id ?? siteKey(url), authority: registered ? 'registered-official' : 'discovery-only' };
}

export function parseListing(source, response, run) {
  const records = [], leads = [];
  const employer = Object.hasOwn(source, 'employer') ? source.employer : source.name;
  if (['greenhouse', 'smartrecruiters', 'lever', 'ashby'].includes(source.provider)) {
    let data; try { data = JSON.parse(response.body); } catch { throw new Error('Expected ATS JSON, not an empty board; parser/input format error'); }
    const jobs = source.provider === 'lever' ? data : data.jobs ?? data.content;
    if (!Array.isArray(jobs)) throw new Error('Missing ATS job array; not an empty board');
    for (const job of jobs) {
      const url = job.absolute_url ?? job.hostedUrl ?? job.jobUrl ?? (source.provider === 'smartrecruiters' ? `https://jobs.smartrecruiters.com/${source.account}/${job.id}-${String(job.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null);
      if (!url) continue;
      const lead = { url, title: job.title ?? job.name ?? job.text, employer, provider: source.provider, account: source.account, advertisement: String(job.id ?? ''), authority: 'registered-official', sourceKey: source.id, discoveredFrom: response.url };
      const record = fromApi(newRecord(lead, run), job, response, employer);
      // A pre-registered association is a seed, not a verification made in this run.
      record.association = source.association ?? { basis: 'curated-seed', officialUrl: source.officialUrl ?? null, boardUrl: source.boardUrl ?? null, evidence: 'docs/v1-scan-spec.md: confirmed seed associations; re-verified on demand via inventory --official' };
      if (!record.fields.title.value) throw new Error('ATS schema not recognised: titles missing');
      records.push(record);
    }
    return { records, leads, total: Number(data.totalFound ?? data.totalElements ?? data.meta?.total ?? jobs.length), returned: jobs.length };
  }
  const $ = load(response.body);
  if (source.provider === 'official-links') {
    $('a[href]').each((_, e) => {
      try {
        const url = new URL($(e).attr('href'), response.url).href, lead = resolveLead(url);
        if (lead.advertisement && lead.account.toLowerCase() === source.account.toLowerCase()) leads.push({ ...lead, title: clean($(e).text()), discoveredFrom: response.url });
      } catch {}
    });
  } else if (source.provider === 'linkedin') {
    $('a[href*="/jobs/view/"]').each((_, e) => {
      const a = $(e), href = a.attr('href');
      try {
        const item = a.closest('li,.base-card');
        const relativeAge = clean(item.find('time').text());
        leads.push({ url: canonical(new URL(href, response.url).href), title: clean(item.find('h3').text() || a.text()), employer: clean(item.find('h4').text()), provider: 'linkedin', account: 'public', sourceKey: source.id, discoveredFrom: response.url, relativeAge,
          // The wording is kept with its source and observation time; no exact
          // first-publication date is invented from it.
          relativePublication: relativeAge ? { text: relativeAge, source: { url: response.url, observedAt: response.observedAt } } : null });
      } catch {}
    });
  } else {
    $('a[href*="/jobdetails/"]').each((_, e) => {
      try { leads.push({ url: new URL($(e).attr('href'), response.url).href, title: clean($(e).text()), employer: source.name, provider: 'asb', account: 'asb', sourceKey: source.id, authority: 'registered-official', discoveredFrom: response.url }); } catch {}
    });
  }
  const unique = [...new Map(leads.map(l => [canonical(l.url), l])).values()];
  if (!unique.length && !/no (?:jobs|results|vacancies)|0 (?:jobs|results)/i.test($.text())) throw new Error('No recognised listing structure; unreadable, not a proven empty list');
  return { records, leads: unique, total: null, returned: unique.length };
}

// The HTML job page is the primary vacancy document. The JSON API only fills
// what the page does not state.
export async function readDetail(record, reader, { gaps = null } = {}) {
  const wanted = gaps ?? [];
  if (!countDetail(reader.state, record.sourceKey)) {
    record.detailError = 'Per-source detail-read ceiling reached; this record keeps its remaining gaps';
    record.gaps = wanted;
    return record;
  }
  const url = record.detailUrl ?? record.canonicalUrl;
  try {
    const response = await reader.get(url, 'detail', record.sourceKey);
    if (response.status !== 200) { record.detailError = `HTTP ${response.status}; not proof of vacancy closure`; return record; }
    if (response.headers?.['content-type']?.includes('json') || response.body.trim().startsWith('{')) {
      let job; try { job = JSON.parse(response.body); } catch { throw new Error('Invalid ATS JSON'); }
      fromApi(record, job, response, record.fields.employer?.value ?? record.lead.employer);
    } else fromHtml(record, response);
    record.detailReadUrl = response.url;
    record.detailSnapshot = response.snapshot;
  } catch (error) { record.detailError = error.message; }
  return record;
}
