import type { SearchPreferences } from '../schemas/types.js';

export type PublicAtsId = 'workable' | 'greenhouse' | 'lever' | 'smartrecruiters' | 'ashby' | 'bamboohr' | 'workday';

export interface ProviderSearchContext {
  preferences: SearchPreferences;
  candidateKeywords: string[];
}

export interface PublicInventoryTarget {
  provider: PublicAtsId;
  /** Board/account/company slug, depending on the ATS. */
  account: string;
  /** Workday career-site name. */
  site?: string;
  /** Workday tenant, when different from account. */
  tenant?: string;
  /** Exact public Workday hostname, including the wdN shard, when known. */
  host?: string;
  query?: string;
}

export interface PublicInventoryListing {
  id?: string | undefined;
  title: string;
  location?: string | undefined;
  detailUrl: string;
  postedAt?: string | undefined;
  updatedAt?: string | undefined;
  description?: string | undefined;
}

export interface PublicInventoryResult {
  provider: PublicAtsId;
  inventoryUrl: string;
  listings: PublicInventoryListing[];
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const text = (value: unknown): string => String(value ?? '').trim();
const array = <T = unknown>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

class InventoryHttpError extends Error {
  constructor(readonly status: number, statusText: string, url: string) {
    super(`${status} ${statusText} from ${url}`);
  }
}

const inventoryFields: Record<Exclude<PublicAtsId, 'lever'>, string[]> = {
  greenhouse: ['jobs'],
  smartrecruiters: ['content'],
  ashby: ['jobs'],
  workable: ['results', 'jobs'],
  bamboohr: ['result', 'jobs'],
  workday: ['jobPostings'],
};

async function requestJson(fetcher: FetchLike, provider: PublicAtsId, url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new InventoryHttpError(response.status, response.statusText, url);
  const data: unknown = await response.json().catch(() => { throw new Error('ATS did not return public inventory JSON'); });
  const rows = provider === 'lever' ? data : data !== null && typeof data === 'object'
    ? inventoryFields[provider].map((field) => (data as Record<string, unknown>)[field]).find((value) => value != null)
    : undefined;
  if (!Array.isArray(rows)) throw new Error('ATS response did not contain an inventory list');
  return data;
}

function absoluteUrl(value: unknown, base: string): string {
  const raw = text(value);
  if (!raw) return base;
  try { return new URL(raw, base).toString(); }
  catch { return base; }
}

function greenhouse(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.account)}/jobs?content=true`;
  const body = data as { jobs?: unknown[] };
  return {
    provider: 'greenhouse', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.jobs).map((job) => ({
      id: text(job.id) || undefined, title: text(job.title),
      location: text((job.location as { name?: unknown } | undefined)?.name) || undefined,
      detailUrl: absoluteUrl(job.absolute_url, inventoryUrl),
      updatedAt: text(job.updated_at) || undefined, description: text(job.content) || undefined,
    })),
  };
}

function lever(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(target.account)}?mode=json`;
  return {
    provider: 'lever', inventoryUrl,
    listings: array<Record<string, unknown>>(data).map((job) => ({
      id: text(job.id) || undefined, title: text(job.text),
      location: text((job.categories as { location?: unknown } | undefined)?.location) || undefined,
      detailUrl: absoluteUrl(job.hostedUrl, inventoryUrl),
      updatedAt: text(job.updatedAt) || undefined,
      description: text(job.descriptionPlain ?? job.description) || undefined,
    })),
  };
}

function smartrecruiters(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.account)}/postings?limit=100`;
  const body = data as { content?: unknown[] };
  return {
    provider: 'smartrecruiters', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.content).map((job) => ({
      id: text(job.id) || undefined, title: text(job.name),
      location: text((job.location as { city?: unknown; country?: unknown } | undefined)?.city
        ?? (job.location as { country?: unknown } | undefined)?.country) || undefined,
      detailUrl: absoluteUrl(job.ref, inventoryUrl),
      updatedAt: text(job.releasedDate) || undefined,
    })),
  };
}

function ashby(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.account)}`;
  const body = data as { jobs?: unknown[] };
  return {
    provider: 'ashby', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.jobs).map((job) => ({
      id: text(job.id) || undefined, title: text(job.title), location: text(job.location) || undefined,
      detailUrl: absoluteUrl(job.jobUrl ?? job.applyUrl, inventoryUrl),
      postedAt: text(job.publishedAt) || undefined, description: text(job.descriptionPlain ?? job.description) || undefined,
    })),
  };
}

function workable(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(target.account)}/jobs`;
  const body = data as { results?: unknown[]; jobs?: unknown[] };
  return {
    provider: 'workable', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.results ?? body?.jobs).map((job) => ({
      id: text(job.shortcode ?? job.id) || undefined, title: text(job.title),
      location: text((job.location as { city?: unknown; country?: unknown } | undefined)?.city
        ?? (job.location as { country?: unknown } | undefined)?.country) || undefined,
      detailUrl: absoluteUrl(job.url ?? job.shortlink, `https://apply.workable.com/${target.account}/`),
      postedAt: text(job.published) || undefined, description: text(job.description) || undefined,
    })),
  };
}

function bamboohr(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const inventoryUrl = `https://${target.account}.bamboohr.com/careers/list`;
  const body = data as { result?: unknown[]; jobs?: unknown[] };
  return {
    provider: 'bamboohr', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.result ?? body?.jobs).map((job) => ({
      id: text(job.id) || undefined, title: text(job.jobOpeningName ?? job.title),
      location: text((job.location as { city?: unknown } | undefined)?.city ?? job.location) || undefined,
      detailUrl: absoluteUrl(job.url ?? (job.id ? `/careers/${job.id}` : ''), `https://${target.account}.bamboohr.com`),
      postedAt: text(job.datePosted) || undefined,
    })),
  };
}

function workday(data: unknown, target: PublicInventoryTarget): PublicInventoryResult {
  const tenant = target.tenant ?? target.account;
  const site = target.site ?? 'External_Career_Site';
  const host = target.host ?? `${target.account}.wd5.myworkdayjobs.com`;
  const inventoryUrl = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const body = data as { jobPostings?: unknown[] };
  return {
    provider: 'workday', inventoryUrl,
    listings: array<Record<string, unknown>>(body?.jobPostings).map((job) => ({
      id: text(job.bulletFields && array(job.bulletFields)[0]) || undefined,
      title: text(job.title), location: text(job.locationsText) || undefined,
      detailUrl: absoluteUrl(text(job.externalPath).replace(/^\/job\//, `/${site}/job/`), `https://${host}/${site}/`),
      postedAt: text(job.postedOn) || undefined,
    })),
  };
}

/**
 * Fetch a public ATS inventory without credentials. Callers must stop on 401/403/429/CAPTCHA
 * and record the source as restricted; this helper never retries or bypasses access controls.
 */
export async function discoverPublicAtsJobs(
  target: PublicInventoryTarget,
  fetcher: FetchLike = fetch,
): Promise<PublicInventoryResult> {
  if (!target.account.trim()) throw new Error('ATS account/board identifier is required');
  if (target.provider === 'workday' && !target.host?.trim()) throw new Error('Workday inventory requires the exact public --host, including its wdN shard');
  if (target.provider === 'greenhouse') {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.account)}/jobs?content=true`;
    return greenhouse(await requestJson(fetcher, target.provider, url), target);
  }
  if (target.provider === 'lever') {
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(target.account)}?mode=json`;
    return lever(await requestJson(fetcher, target.provider, url), target);
  }
  if (target.provider === 'smartrecruiters') {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.account)}/postings?limit=100`;
    return smartrecruiters(await requestJson(fetcher, target.provider, url), target);
  }
  if (target.provider === 'ashby') {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.account)}`;
    return ashby(await requestJson(fetcher, target.provider, url), target);
  }
  if (target.provider === 'workable') {
    const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(target.account)}/jobs`;
    const data = await requestJson(fetcher, target.provider, url, { method: 'POST', body: JSON.stringify({ query: target.query ?? '', location: [], department: [], worktype: [], remote: [] }) });
    return workable(data, target);
  }
  if (target.provider === 'bamboohr') {
    const url = `https://${target.account}.bamboohr.com/careers/list`;
    return bamboohr(await requestJson(fetcher, target.provider, url), target);
  }
  const tenant = target.tenant ?? target.account;
  const site = target.site ?? 'External_Career_Site';
  const host = target.host ?? `${target.account}.wd5.myworkdayjobs.com`;
  const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const data = await requestJson(fetcher, target.provider, url, { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 100, offset: 0, searchText: target.query ?? '' }) });
  return workday(data, target);
}

export const providerCatalogue = [
  { id: 'workable', displayName: 'Workable public job boards', baseUrl: 'https://apply.workable.com', publicAccessOnly: true },
  { id: 'greenhouse', displayName: 'Greenhouse job boards', baseUrl: 'https://boards.greenhouse.io', publicAccessOnly: true },
  { id: 'lever', displayName: 'Lever job boards', baseUrl: 'https://jobs.lever.co', publicAccessOnly: true },
  { id: 'smartrecruiters', displayName: 'SmartRecruiters job boards', baseUrl: 'https://jobs.smartrecruiters.com', publicAccessOnly: true },
  { id: 'ashby', displayName: 'Ashby public job boards', baseUrl: 'https://jobs.ashbyhq.com', publicAccessOnly: true },
  { id: 'bamboohr', displayName: 'BambooHR public career sites', baseUrl: 'https://bamboohr.com/careers', publicAccessOnly: true },
  { id: 'workday', displayName: 'Public Workday career sites', baseUrl: 'https://myworkdayjobs.com', publicAccessOnly: true },
] as const;

const boardHosts = new Map<string, PublicAtsId>([
  ['boards.greenhouse.io', 'greenhouse'],
  ['job-boards.greenhouse.io', 'greenhouse'],
  ['jobs.lever.co', 'lever'],
  ['jobs.smartrecruiters.com', 'smartrecruiters'],
  ['jobs.ashbyhq.com', 'ashby'],
  ['apply.workable.com', 'workable'],
]);
const boardSlug = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BATCH_BOARDS = 10;
const BATCH_CONCURRENCY = 3;
const BATCH_REQUEST_TIMEOUT_MS = 8_000;

/** Resolve a public board URL to a known adapter. Never fetch the URL supplied as input. */
function parsePublicBoardUrl(input: string): { boardUrl: string; target: PublicInventoryTarget } {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Use a clean HTTPS public ATS board URL without credentials, port, query, or fragment');
  }
  const host = url.hostname;
  const path = url.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
  const [first, second] = path;
  const provider = boardHosts.get(host);
  if (provider && path.length === 1 && first && boardSlug.test(first)) {
    return { boardUrl: `${url.origin}/${first}`, target: { provider, account: first } };
  }
  const bamboo = /^([a-z0-9-]+)\.bamboohr\.com$/.exec(host);
  if (bamboo?.[1] && path.length === 1 && first === 'careers') {
    return { boardUrl: `${url.origin}/careers`, target: { provider: 'bamboohr', account: bamboo[1] } };
  }
  const workdayHost = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  const site = path.length === 1 ? first : path.length === 2 && /^[a-z]{2}-[A-Z]{2}$/.test(first ?? '') ? second : undefined;
  if (workdayHost?.[1] && site && boardSlug.test(site) && !/^(?:login|signin|apply|jobs?|candidate-?home|userhome|wday)$/i.test(site)) {
    return { boardUrl: `${url.origin}/${site}`, target: { provider: 'workday', account: workdayHost[1], host, site } };
  }
  throw new Error('Unsupported ATS board URL; use the public careers page instead');
}

type BatchItem = (
  | (PublicInventoryResult & { status: 'ok'; boardUrl: string })
  | { status: 'duplicate' | 'blocked' | 'unavailable'; boardUrl: string; reason: string }
  | { status: 'unsupported'; reason: string }
) & { inputIndex: number };

export async function discoverPublicAtsBatch(
  boardUrls: string[],
  fetcher: FetchLike = fetch,
): Promise<{ results: BatchItem[] }> {
  if (boardUrls.length < 1 || boardUrls.length > MAX_BATCH_BOARDS) {
    throw new Error(`Provide 1 to ${MAX_BATCH_BOARDS} public ATS board URLs with --board`);
  }
  const seen = new Set<string>();
  async function scan(input: string, inputIndex: number): Promise<BatchItem> {
    let parsed: ReturnType<typeof parsePublicBoardUrl>;
    try { parsed = parsePublicBoardUrl(input); }
    catch (error) {
      return { inputIndex, status: 'unsupported', reason: error instanceof TypeError ? 'Invalid ATS board URL' : (error as Error).message };
    }
    const { boardUrl, target } = parsed;
    const key = JSON.stringify([target.provider, target.account, target.host, target.site]);
    if (seen.has(key)) return { inputIndex, boardUrl, status: 'duplicate', reason: 'This board was already included in the batch' };
    seen.add(key);
    try {
      const result = await discoverPublicAtsJobs(target, (url, init) =>
        fetcher(url, {
          ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(BATCH_REQUEST_TIMEOUT_MS),
        }));
      const listings = result.listings.map(({ description: _description, ...listing }) => listing);
      return { inputIndex, boardUrl, status: 'ok', ...result, listings };
    } catch (error) {
      const blocked = error instanceof InventoryHttpError && [401, 403, 429].includes(error.status);
      return { inputIndex, boardUrl, status: blocked ? 'blocked' : 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const results: BatchItem[] = [];
  for (let start = 0; start < boardUrls.length; start += BATCH_CONCURRENCY) {
    results.push(...await Promise.all(boardUrls.slice(start, start + BATCH_CONCURRENCY).map((url, offset) => scan(url, start + offset + 1))));
  }
  return { results };
}

export async function runInventoryBatchCli(argv: string[]): Promise<void> {
  const boards: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const board = argv[index + 1];
    if (argv[index] !== '--board' || !board || board.startsWith('--')) {
      throw new Error('Usage: nz-job-scout inventory-batch --board HTTPS_BOARD_URL [--board HTTPS_BOARD_URL ...]');
    }
    boards.push(board);
  }
  process.stdout.write(`${JSON.stringify(await discoverPublicAtsBatch(boards), null, 2)}\n`);
}

export async function runInventoryCli(argv: string[]): Promise<number> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) throw new Error(`Unknown inventory argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    values[token.slice(2)] = value;
    index += 1;
  }
  const provider = values.provider as PublicAtsId | undefined;
  if (!provider || !providerCatalogue.some((item) => item.id === provider)) throw new Error('--provider must be workable, greenhouse, lever, smartrecruiters, ashby, bamboohr, or workday');
  if (!values.account) throw new Error('--account is required');
  const target: PublicInventoryTarget = { provider, account: values.account };
  if (values.site) target.site = values.site;
  if (values.tenant) target.tenant = values.tenant;
  if (values.host) target.host = values.host;
  if (values.query) target.query = values.query;
  const result = await discoverPublicAtsJobs(target);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
