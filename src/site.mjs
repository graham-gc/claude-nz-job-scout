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

// The advertisement a URL names, with the provider and tenant that own it.
// An advertisement is only an identity inside its own tenant: a Lever
// advertisement is a UUID, a Greenhouse one is a number, and neither id means
// anything outside the board that issued it. A URL that names no
// advertisement (an inventory endpoint, a plain careers page) says so.
export function adIdentity(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const p = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'job-boards.greenhouse.io' && p[0]) return { provider: 'greenhouse', account: p[0], advertisement: p[1] === 'jobs' && /^\d+$/.test(p[2] ?? '') ? p[2] : null };
  if (u.hostname === 'jobs.lever.co' && p[0]) return { provider: 'lever', account: p[0], advertisement: /^[a-f0-9-]{36}$/i.test(p[1] ?? '') ? p[1] : null };
  if (u.hostname === 'jobs.smartrecruiters.com' && p[0]) return { provider: 'smartrecruiters', account: p[0], advertisement: /^\d+(?:-|$)/.test(p[1] ?? '') ? p[1].split('-')[0] : null };
  if (u.hostname === 'jobs.ashbyhq.com' && p[0]) return { provider: 'ashby', account: p[0], advertisement: p[1] && !/^\d+$/.test(p[1]) ? p[1] : null };
  if (u.hostname === 'careers.asbgroup.co.nz') return { provider: 'asb', account: 'asb', advertisement: null };
  // An inventory endpoint belongs to one tenant, and is attributed to it.
  const tenant = tenantOf(url);
  if (tenant?.account) return { provider: tenant.provider, account: tenant.account, advertisement: null };
  return null;
}

// The key a read is charged to when the reader already knows the record's own
// tenant: the record's own tenant wins over the URL's host.
export function siteKeyFor(record, url) {
  const provider = record?.provider;
  const account = record?.account;
  if (provider && provider !== 'html' && account) return `${provider}:${String(account).toLowerCase()}`;
  return siteKey(url);
}
