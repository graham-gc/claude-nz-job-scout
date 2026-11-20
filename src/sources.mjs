import { load } from './html.mjs';
import { hash } from './store.mjs';
import { publicUrl, countDetail } from './net.mjs';
import { newRecord, fromApi, fromHtml, canonical, canonicalLocal, clean } from './evidence.mjs';
import { siteKey, adIdentity } from './site.mjs';

export const SOURCES = [
  { id: 'contact', name: 'Contact Energy', provider: 'smartrecruiters', account: 'ContactEnergy', url: 'https://api.smartrecruiters.com/v1/companies/ContactEnergy/postings?limit=100', officialUrl: 'https://contact.co.nz/About-Us/Careers', boardUrl: 'https://jobs.smartrecruiters.com/contactenergy' },
  { id: 'uoa', name: 'University of Auckland', provider: 'smartrecruiters', account: 'TheUniversityOfAuckland', url: 'https://api.smartrecruiters.com/v1/companies/TheUniversityOfAuckland/postings?limit=100', officialUrl: 'https://vacancies.auckland.ac.nz', boardUrl: 'https://jobs.smartrecruiters.com/TheUniversityOfAuckland' },
  { id: 'accesso', name: 'accesso', provider: 'greenhouse', account: 'accesso', url: 'https://boards-api.greenhouse.io/v1/boards/accesso/jobs?content=true', officialUrl: 'https://accesso.com/careers/', boardUrl: 'https://job-boards.greenhouse.io/accesso' },
  { id: 'pushpay', name: 'Pushpay', provider: 'greenhouse', account: 'pushpay', url: 'https://boards-api.greenhouse.io/v1/boards/pushpay/jobs?content=true', officialUrl: 'https://pushpay.com/about-us/careers/new-zealand/', boardUrl: 'https://job-boards.greenhouse.io/pushpay' },
  { id: 'pushpay-nz', name: 'Pushpay NZ official inventory', provider: 'official-links', account: 'pushpay', url: 'https://pushpay.com/about-us/careers/new-zealand/' },
  { id: 'asb', name: 'ASB Bank', provider: 'asb', account: 'asb', url: 'https://careers.asbgroup.co.nz/search', officialUrl: 'https://careers.asbgroup.co.nz', boardUrl: 'https://careers.asbgroup.co.nz/search' }
];

const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// The number of public discovery entry points one run may open. The cap is
// unchanged; what changes is which criteria the cap is spent on.
export const DISCOVERY_ENTRY_CAP = 2;
// Discovery entry points follow the requested role families and location instead
// of a hard-coded "Auckland software engineer" listing.
//
// The cap is spent fairly: the role families are taken in turn, and the place
// rotates with them, so a later requested role family is not starved by an
// earlier one and the entries of one run cover more than one requested city.
// Whatever the cap leaves out is disclosed, because a request that was only
// partly searched must say so.
export function discoveryPlan(config, cap = DISCOVERY_ENTRY_CAP) {
  const roleNames = (config.roleFamilies ?? []).map(name => String(name).trim()).filter(Boolean);
  const placeNames = config.location?.onsiteCities?.length ? config.location.onsiteCities.map(name => String(name).trim()).filter(Boolean)
    : [String(config.location?.country ?? 'New Zealand')];
  const roles = roleNames.map(name => ({ name, slug: slug(name) })).filter(r => r.slug);
  const places = placeNames.map(name => ({ name, slug: slug(name) })).filter(p => p.slug);
  const roleList = roles.length ? roles : [{ name: 'jobs', slug: 'jobs' }];
  const placeList = places.length ? places : [{ name: 'New Zealand', slug: 'new-zealand' }];
  const entries = [];
  const usedRoles = new Set(), usedPlaces = new Set();
  for (let i = 0; i < roleList.length && entries.length < cap; i++) {
    const role = roleList[i].slug, place = placeList[i % placeList.length].slug;
    entries.push({ id: `linkedin-${role}-${place}`, name: `LinkedIn public discovery (${role}, ${place})`, provider: 'linkedin', account: 'public', url: `https://nz.linkedin.com/jobs/${role}-jobs-${place}` });
    usedRoles.add(i);
    usedPlaces.add(i % placeList.length);
  }
  // Spare capacity goes to the cities that no entry covers yet, under the
  // first role family: one requested city must not go unsearched while the
  // cap still has room.
  for (let p = 0; p < placeList.length && entries.length < cap; p++) {
    if (usedPlaces.has(p)) continue;
    const role = roleList[0].slug, place = placeList[p].slug;
    entries.push({ id: `linkedin-${role}-${place}`, name: `LinkedIn public discovery (${role}, ${place})`, provider: 'linkedin', account: 'public', url: `https://nz.linkedin.com/jobs/${role}-jobs-${place}` });
    usedPlaces.add(p);
  }
  const omittedRoles = roleList.filter((_, i) => !usedRoles.has(i)).map(r => r.name);
  const omittedPlaces = placeList.filter((_, i) => !usedPlaces.has(i)).map(p => p.name);
  return { entries, omittedRoles, omittedPlaces };
}
export function sourcesFor(config) {
  const list = SOURCES.map(s => ({ ...s }));
  const { entries } = discoveryPlan(config);
  return [...list, ...entries];
}
// The coverage the cap could not cover, said out loud. A request whose role
// families or cities were partly left out of discovery is disclosed in the
// report, so that a thin search cannot pass for a full one.
export function discoveryDisclosure(config) {
  const { omittedRoles, omittedPlaces } = discoveryPlan(config);
  const parts = [];
  if (omittedRoles.length) parts.push(`role ${omittedRoles.length === 1 ? 'family' : 'families'} ${omittedRoles.map(r => `"${r}"`).join(', ')}`);
  if (omittedPlaces.length) parts.push(`${omittedPlaces.length === 1 ? 'city' : 'cities'} ${omittedPlaces.map(p => `"${p}"`).join(', ')}`);
  if (!parts.length) return null;
  return `Public discovery is capped at ${DISCOVERY_ENTRY_CAP} entry points per run, so this run did not open a discovery entry of its own for the requested ${parts.join(' and ')}. Those criteria are covered only by the other sources of this run.`;
}

export function recognised(url) {
  // One parser names the provider, the tenant and the advertisement of a URL,
  // so a job page and the form that posts to it are read the same way.
  const identity = adIdentity(url);
  if (identity) return identity;
  return { provider: 'html', account: '' };
}
export function resolveLead(url, sources = SOURCES) {
  const shape = recognised(url);
  const registered = sources.find(s => s.provider === shape.provider && s.account.toLowerCase() === shape.account.toLowerCase());
  // A discovered lead is charged to the site it lives on, not to a shared
  // search key: one employer's site is one source, and its budget is its own.
  return { ...shape, url: canonical(url), employer: registered?.name, sourceKey: registered?.id ?? siteKey(url), authority: registered ? 'registered-official' : 'discovery-only' };
}

export function inventoryComplete({ advertisedTotal, returned, reviewed, note }) {
  // Older runs have no returned count. Their notes identify a clipped listing.
  return Number.isSafeInteger(advertisedTotal) && advertisedTotal >= 0 && reviewed >= advertisedTotal
    && (returned == null ? !note : reviewed === returned);
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
    // A read that succeeded clears the failure of an earlier attempt: the
    // error of a transient attempt must not outlive the answer that replaced
    // it.
    delete record.detailError;
    record.detailReadUrl = response.url;
    record.detailSnapshot = response.snapshot;
  } catch (error) { record.detailError = error.message; }
  return record;
}
