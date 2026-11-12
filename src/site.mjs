// Network attribution: which website or ATS tenant a read belongs to.
//
// A read is charged to, and restricted by, the site it went to. Web search is
// a discovery channel, not a shared network origin, so it never carries reads
// that were made against somebody else's website.

// ATS hosts, the provider they belong to, and where the tenant sits in the path.
const ATS_HOSTS = {
  'job-boards.greenhouse.io': { provider: 'greenhouse', tenant: 0 },
  'boards-api.greenhouse.io': { provider: 'greenhouse', tenant: 2 },
  'jobs.lever.co': { provider: 'lever', tenant: 0 },
  'api.lever.co': { provider: 'lever', tenant: 2 },
  'jobs.smartrecruiters.com': { provider: 'smartrecruiters', tenant: 0 },
  'api.smartrecruiters.com': { provider: 'smartrecruiters', tenant: 2 },
  'jobs.ashbyhq.com': { provider: 'ashby', tenant: 0 },
  'careers.asbgroup.co.nz': { provider: 'asb', tenant: 0 }
};

const parts = url => {
  try { return new URL(String(url)).pathname.split('/').filter(Boolean); } catch { return []; }
};

// The provider and tenant a URL belongs to, e.g. greenhouse / privateidentity.
export function tenantOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = ATS_HOSTS[u.hostname];
  if (!host) return null;
  const segments = parts(url);
  const account = segments[host.tenant] ?? '';
  return { provider: host.provider, account, advertisement: segments[host.tenant + 1] ?? null };
}

// The key a read is charged to and restricted by: one ATS tenant, or one
// employer's own website. Two employers on the same platform never share it.
export function siteKey(url) {
  const tenant = tenantOf(url);
  if (tenant && tenant.account) return `${tenant.provider}:${tenant.account.toLowerCase()}`;
  try { return `site:${new URL(String(url)).hostname.toLowerCase()}`; } catch { return 'site:unknown'; }
}

// The key a read is charged to when the reader already knows the record's own
// tenant: the record's own tenant wins over the URL's host.
export function siteKeyFor(record, url) {
  const provider = record?.provider;
  const account = record?.account;
  if (provider && provider !== 'html' && account) return `${provider}:${String(account).toLowerCase()}`;
  return siteKey(url);
}
