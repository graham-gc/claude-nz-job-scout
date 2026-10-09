const text = (value) => String(value ?? '').trim();
const array = (value) => Array.isArray(value) ? value : [];
async function requestJson(fetcher, url, init) {
    const response = await fetcher(url, {
        ...init,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok)
        throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return response.json();
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
            location: text(job.categories?.location) || undefined,
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
        listings: array(body?.content).map((job) => ({
            id: text(job.id) || undefined, title: text(job.name),
            location: text(job.location?.city
                ?? job.location?.country) || undefined,
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
            id: text(job.id) || undefined, title: text(job.title), location: text(job.location) || undefined,
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
        listings: array(body?.results ?? body?.jobs).map((job) => ({
            id: text(job.shortcode ?? job.id) || undefined, title: text(job.title),
            location: text(job.location?.city
                ?? job.location?.country) || undefined,
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
            location: text(job.location?.city ?? job.location) || undefined,
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
        listings: array(body?.jobPostings).map((job) => ({
            id: text(job.bulletFields && array(job.bulletFields)[0]) || undefined,
            title: text(job.title), location: text(job.locationsText) || undefined,
            detailUrl: absoluteUrl(job.externalPath, `https://${host}/${site}`),
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
        return greenhouse(await requestJson(fetcher, url), target);
    }
    if (target.provider === 'lever') {
        const url = `https://api.lever.co/v0/postings/${encodeURIComponent(target.account)}?mode=json`;
        return lever(await requestJson(fetcher, url), target);
    }
    if (target.provider === 'smartrecruiters') {
        const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.account)}/postings?limit=100`;
        return smartrecruiters(await requestJson(fetcher, url), target);
    }
    if (target.provider === 'ashby') {
        const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.account)}`;
        return ashby(await requestJson(fetcher, url), target);
    }
    if (target.provider === 'workable') {
        const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(target.account)}/jobs`;
        const data = await requestJson(fetcher, url, { method: 'POST', body: JSON.stringify({ query: target.query ?? '', location: [], department: [], worktype: [], remote: [] }) });
        return workable(data, target);
    }
    if (target.provider === 'bamboohr') {
        const url = `https://${target.account}.bamboohr.com/careers/list`;
        return bamboohr(await requestJson(fetcher, url), target);
    }
    const tenant = target.tenant ?? target.account;
    const site = target.site ?? 'External_Career_Site';
    const host = target.host ?? `${target.account}.wd5.myworkdayjobs.com`;
    const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
    const data = await requestJson(fetcher, url, { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 100, offset: 0, searchText: target.query ?? '' }) });
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
