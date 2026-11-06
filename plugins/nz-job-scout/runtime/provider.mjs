const text = (value) => String(value ?? '').trim();
const array = (value) => Array.isArray(value) ? value : [];
const locationText = (...parts) => [...new Set(parts.filter((part) => typeof part === 'string').map((part) => part.trim()).filter(Boolean))].join(', ') || undefined;
function structuredLocation(value) {
    if (typeof value === 'string')
        return locationText(value);
    if (!value || typeof value !== 'object')
        return undefined;
    const { city, region, state, country, addressLocality, addressRegion, addressCountry } = value;
    const countryValue = country ?? addressCountry;
    const countryLabel = typeof countryValue === 'string' && /^[a-z]{2,3}$/i.test(countryValue.trim())
        ? countryValue.trim().toUpperCase() : countryValue;
    return locationText(city ?? addressLocality, region ?? state ?? addressRegion, countryLabel);
}
function multiLocation(primary, others, primaryLabel = primary) {
    return [...new Set([primary, ...array(others).map(structuredLocation).filter((item) => item !== primaryLabel)].filter(Boolean))].join('; ') || undefined;
}
function sourceMayHaveMore(data, returned, cappedAt) {
    const metadata = data && typeof data === 'object' ? data : {};
    const totals = [metadata.total, metadata.totalFound];
    const numericTotals = totals.filter((total) => typeof total === 'number' || (typeof total === 'string' && /^\d+$/.test(total))).map(Number);
    return numericTotals.some((total) => total > returned)
        || Boolean(metadata.nextPage || metadata.next || metadata.hasMore === true)
        || (cappedAt !== undefined && returned >= cappedAt && numericTotals.length === 0);
}
class InventoryHttpError extends Error {
    status;
    constructor(status, statusText, url) {
        super(`${status} ${statusText} from ${url}`);
        this.status = status;
    }
}
const inventoryFields = {
    greenhouse: ['jobs'],
    smartrecruiters: ['content'],
    ashby: ['jobs'],
    workable: ['results', 'jobs'],
    bamboohr: ['result', 'jobs'],
    workday: ['jobPostings'],
};
async function requestJson(fetcher, provider, url, init) {
    const response = await fetcher(url, {
        ...init,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok)
        throw new InventoryHttpError(response.status, response.statusText, url);
    const data = await response.json().catch(() => { throw new Error('ATS did not return public inventory JSON'); });
    const rows = provider === 'lever' ? data : data !== null && typeof data === 'object'
        ? inventoryFields[provider].map((field) => data[field]).find((value) => value != null)
        : undefined;
    if (!Array.isArray(rows))
        throw new Error('ATS response did not contain an inventory list');
    return data;
}
function absoluteUrl(value, base) {
    const raw = text(value);
    if (!raw)
        return base;
    try {
        return new URL(raw, base).toString();
    }
    catch {
        return base;
    }
}
function greenhouse(data, target) {
    const inventoryUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.account)}/jobs?content=true`;
    const body = data;
    return {
        provider: 'greenhouse', inventoryUrl,
        listings: array(body?.jobs).map((job) => ({
            id: text(job.id) || undefined, title: text(job.title),
            location: text(job.location?.name) || undefined,
            detailUrl: absoluteUrl(job.absolute_url, inventoryUrl),
            updatedAt: text(job.updated_at) || undefined, description: text(job.content) || undefined,
        })),
    };
}
function lever(data, target) {
    const inventoryUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(target.account)}?mode=json`;
    return {
        provider: 'lever', inventoryUrl,
        listings: array(data).map((job) => ({
            id: text(job.id) || undefined, title: text(job.text),
            location: multiLocation(locationText(job.categories?.location, job.country), job.categories?.allLocations, locationText(job.categories?.location)),
            remote: job.workplaceType === 'remote' || undefined,
            detailUrl: absoluteUrl(job.hostedUrl, inventoryUrl),
            updatedAt: text(job.updatedAt) || undefined,
            description: text(job.descriptionPlain ?? job.description) || undefined,
        })),
    };
}
function smartrecruiters(data, target) {
    const inventoryUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.account)}/postings?limit=100`;
    const body = data;
    return {
        provider: 'smartrecruiters', inventoryUrl,
        sourceMayHaveMore: sourceMayHaveMore(data, array(body?.content).length, 100),
        listings: array(body?.content).map((job) => ({
            id: text(job.id) || undefined, title: text(job.name),
            location: structuredLocation(job.location),
            remote: job.location?.remote === true || undefined,
            detailUrl: absoluteUrl(job.ref, inventoryUrl),
            updatedAt: text(job.releasedDate) || undefined,
        })),
    };
}
function ashby(data, target) {
    const inventoryUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.account)}`;
    const body = data;
    return {
        provider: 'ashby', inventoryUrl,
        listings: array(body?.jobs).map((job) => ({
            id: text(job.id) || undefined, title: text(job.title),
            location: multiLocation(locationText(job.location, structuredLocation(job.address?.postalAddress)), array(job.secondaryLocations).map((entry) => locationText(entry?.location, structuredLocation(entry?.address)))),
            remote: job.isRemote === true || job.workplaceType === 'Remote' || undefined,
            detailUrl: absoluteUrl(job.jobUrl ?? job.applyUrl, inventoryUrl),
            postedAt: text(job.publishedAt) || undefined, description: text(job.descriptionPlain ?? job.description) || undefined,
        })),
    };
}
function workable(data, target) {
    const inventoryUrl = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(target.account)}/jobs`;
    const body = data;
    return {
        provider: 'workable', inventoryUrl,
        sourceMayHaveMore: sourceMayHaveMore(data, array(body?.results ?? body?.jobs).length),
        listings: array(body?.results ?? body?.jobs).map((job) => ({
            id: text(job.shortcode ?? job.id) || undefined, title: text(job.title),
            location: structuredLocation(job.location),
            remote: job.location?.telecommuting === true || undefined,
            detailUrl: absoluteUrl(job.url ?? job.shortlink, `https://apply.workable.com/${target.account}/`),
            postedAt: text(job.published) || undefined, description: text(job.description) || undefined,
        })),
    };
}
function bamboohr(data, target) {
    const inventoryUrl = `https://${target.account}.bamboohr.com/careers/list`;
    const body = data;
    return {
        provider: 'bamboohr', inventoryUrl,
        listings: array(body?.result ?? body?.jobs).map((job) => ({
            id: text(job.id) || undefined, title: text(job.jobOpeningName ?? job.title),
            location: structuredLocation(job.location),
            detailUrl: absoluteUrl(job.url ?? (job.id ? `/careers/${job.id}` : ''), `https://${target.account}.bamboohr.com`),
            postedAt: text(job.datePosted) || undefined,
        })),
    };
}
function workday(data, target) {
    const tenant = target.tenant ?? target.account;
    const site = target.site ?? 'External_Career_Site';
    const host = target.host ?? `${target.account}.wd5.myworkdayjobs.com`;
    const inventoryUrl = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    const body = data;
    return {
        provider: 'workday', inventoryUrl,
        sourceMayHaveMore: sourceMayHaveMore(data, array(body?.jobPostings).length, 100),
        listings: array(body?.jobPostings).map((job) => ({
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
export async function discoverPublicAtsJobs(target, fetcher = fetch) {
    if (!target.account.trim())
        throw new Error('ATS account/board identifier is required');
    if (target.provider === 'workday' && !target.host?.trim())
        throw new Error('Workday inventory requires the exact public --host, including its wdN shard');
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
];
const boardHosts = new Map([
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
function parsePublicBoardUrl(input) {
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
const NZ_COUNTRY = /\b(?:new zealand|aotearoa|nz|nzl)\b/;
const NZ_PLACES = /\b(?:auckland|tamaki makaurau|wellington|te whanganui[- ]a[- ]tara|christchurch|otautahi|dunedin|otepoti|tauranga|queenstown|invercargill|palmerston north|new plymouth|whangarei|whakatane|whanganui|rotorua|taupo|te awamutu|te anau|wanaka|napier|lower hutt|upper hutt|porirua|waikato|canterbury|otago|southland|northland|manawatu|bay of plenty|hawke'?s bay)\b/;
const OVERSEAS_PLACES = /\b(?:australia|united states(?: of america)?|united kingdom|canada|india|china|japan|singapore|germany|france|netherlands|ireland|spain|philippines|indonesia|malaysia|vietnam|thailand|south africa|hong kong|europe|sydney|melbourne|brisbane|adelaide|perth|london|new york|san francisco|california|florida|toronto|bengaluru)\b/;
const OVERSEAS_CODE = /(?:^|[,(]\s*)(?:AU|AUS|US|USA|UK|GB|GBR|CA|CAN|IN|IND|SG|SGP|CN|CHN|JP|DE|FR|NL|IE|PH|ID|MY|VN|TH|ZA|HK|FL|NY|TX|MA|NSW|QLD|VIC)(?=\s*(?:[,)]|$))/;
const UNCLEAR_REGION = /\b(?:remote|worldwide|global|anywhere|apac|asia[- ]pacific|anz|oceania)\b/;
const BATCH_LISTING_BUDGET = 30;
function locationScope(listing) {
    if (!listing.location)
        return 'unknown';
    const locations = listing.location.normalize('NFD').replace(/\p{M}/gu, '').split(/[;|/\n]+/).map((part) => part.trim()).filter(Boolean);
    if (locations.some((part) => NZ_COUNTRY.test(part.toLowerCase())))
        return 'new-zealand';
    const isOverseas = (part) => OVERSEAS_PLACES.test(part.toLowerCase()) || OVERSEAS_CODE.test(part);
    if (locations.some((part) => NZ_PLACES.test(part.toLowerCase()) && !isOverseas(part)))
        return 'new-zealand';
    // A foreign home office does not prove an explicitly remote role excludes NZ.
    if (listing.remote || UNCLEAR_REGION.test(listing.location.toLowerCase()) || locations.some((part) => NZ_PLACES.test(part.toLowerCase())))
        return 'unknown';
    return locations.length > 0 && locations.every(isOverseas) ? 'overseas' : 'unknown';
}
export async function discoverPublicAtsBatch(boards, fetcher = fetch) {
    if (boards.length < 1 || boards.length > MAX_BATCH_BOARDS) {
        throw new Error(`Provide 1 to ${MAX_BATCH_BOARDS} public ATS board URLs with --board`);
    }
    const inputs = boards.map((board) => typeof board === 'string' ? { url: board, offset: 0 } : board);
    if (inputs.some(({ offset }) => !Number.isSafeInteger(offset) || offset < 0))
        throw new Error('--offset must be a non-negative integer');
    const seen = new Set();
    async function scan({ url, offset }, inputIndex) {
        let parsed;
        try {
            parsed = parsePublicBoardUrl(url);
        }
        catch (error) {
            return { inputIndex, status: 'unsupported', reason: error instanceof TypeError ? 'Invalid ATS board URL' : error.message };
        }
        const { boardUrl, target } = parsed;
        const key = JSON.stringify([target.provider, target.account, target.host, target.site]);
        if (seen.has(key))
            return { inputIndex, boardUrl, status: 'duplicate', reason: 'This board was already included in the batch' };
        seen.add(key);
        try {
            const result = await discoverPublicAtsJobs(target, (url, init) => fetcher(url, {
                ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(BATCH_REQUEST_TIMEOUT_MS),
            }));
            const nz = [];
            const unknown = [];
            for (const item of result.listings) {
                const scope = locationScope(item);
                if (scope === 'overseas')
                    continue;
                const { description: _description, remote: _remote, ...listing } = item;
                (scope === 'new-zealand' ? nz : unknown).push({ ...listing, locationScope: scope });
            }
            return {
                inputIndex, boardUrl, status: 'ok', offset, provider: result.provider, inventoryUrl: result.inventoryUrl,
                sourceMayHaveMore: result.sourceMayHaveMore ?? false,
                counts: { received: result.listings.length, newZealand: nz.length, unknown: unknown.length, overseas: result.listings.length - nz.length - unknown.length },
                listings: [...nz, ...unknown].slice(offset),
            };
        }
        catch (error) {
            const blocked = error instanceof InventoryHttpError && [401, 403, 429].includes(error.status);
            return { inputIndex, boardUrl, status: blocked ? 'blocked' : 'unavailable', reason: error instanceof Error ? error.message : String(error) };
        }
    }
    const scanned = [];
    for (let start = 0; start < inputs.length; start += BATCH_CONCURRENCY) {
        scanned.push(...await Promise.all(inputs.slice(start, start + BATCH_CONCURRENCY).map((board, index) => scan(board, start + index + 1))));
    }
    // Allocate a shared output budget fairly, without wasting slots on empty boards.
    const pages = new Map();
    for (const item of scanned)
        if (item.status === 'ok')
            pages.set(item, 0);
    let remaining = BATCH_LISTING_BUDGET;
    while (remaining > 0) {
        let allocated = false;
        for (const [item, count] of pages) {
            if (count >= item.listings.length)
                continue;
            pages.set(item, count + 1);
            allocated = true;
            if (--remaining === 0)
                break;
        }
        if (!allocated)
            break;
    }
    const results = scanned.map((item) => {
        if (item.status !== 'ok')
            return item;
        const count = pages.get(item) ?? 0;
        return {
            ...item, listings: item.listings.slice(0, count),
            ...(item.listings.length > count ? { nextOffset: item.offset + count } : {}),
        };
    });
    return { results };
}
export async function runInventoryBatchCli(argv) {
    const boards = [];
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        const last = boards.at(-1);
        if (flag === '--board' && value && !value.startsWith('--')) {
            boards.push({ url: value, offset: 0 });
        }
        else if (flag === '--offset' && last?.offset === 0 && value && /^[1-9]\d*$/.test(value)) {
            last.offset = Number(value);
        }
        else {
            throw new Error('Usage: nz-job-scout inventory-batch --board HTTPS_BOARD_URL [--offset NEXT_OFFSET] [--board HTTPS_BOARD_URL ...]');
        }
    }
    const { results } = await discoverPublicAtsBatch(boards);
    process.stdout.write(`{"results":[\n${results.map((item) => JSON.stringify(item)).join(',\n')}\n]}\n`);
}
export async function runInventoryCli(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token?.startsWith('--'))
            throw new Error(`Unknown inventory argument: ${token}`);
        const value = argv[index + 1];
        if (!value || value.startsWith('--'))
            throw new Error(`${token} requires a value`);
        values[token.slice(2)] = value;
        index += 1;
    }
    const provider = values.provider;
    if (!provider || !providerCatalogue.some((item) => item.id === provider))
        throw new Error('--provider must be workable, greenhouse, lever, smartrecruiters, ashby, bamboohr, or workday');
    if (!values.account)
        throw new Error('--account is required');
    const target = { provider, account: values.account };
    if (values.site)
        target.site = values.site;
    if (values.tenant)
        target.tenant = values.tenant;
    if (values.host)
        target.host = values.host;
    if (values.query)
        target.query = values.query;
    const result = await discoverPublicAtsJobs(target);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
}
