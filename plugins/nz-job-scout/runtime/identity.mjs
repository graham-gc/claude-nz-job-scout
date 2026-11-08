// @ts-nocheck
// Independent, bounded public-page checks. No cookies, browser state or login.
import { get } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
const SHORT_HOSTS = new Set(['lnkd.in', 'bit.ly', 't.co', 'tinyurl.com', 'goo.gl']);
const LIMIT = 768 * 1024;
const key = (value) => String(value ?? '').toLowerCase().replace(/\b(limited|ltd|inc|llc|plc|pty)\b/g, '').replace(/[^a-z0-9]/g, '');
const unescape = (value) => String(value ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = (value) => unescape(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
export function isShortVacancyUrl(value) {
    try {
        return SHORT_HOSTS.has(new URL(value).hostname.toLowerCase());
    }
    catch {
        return false;
    }
}
function publicAddress(address) {
    if (isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
    }
    const lower = address.toLowerCase();
    return isIP(address) === 6 && !/^(?:::|fc|fd|fe[89ab]|ff)/.test(lower) && !lower.includes('.');
}
function publicUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname)
        || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) {
        throw new Error('Only public HTTPS vacancy URLs without credentials or ports are permitted');
    }
    return url;
}
export function requestPublicDocument(value, timeoutMs = 4000) {
    const url = publicUrl(value);
    return new Promise((resolve, reject) => {
        // Pin each connection to a checked address, rather than validating DNS and
        // allowing a second resolution to reach a private address.
        const request = get(url, {
            headers: { 'User-Agent': 'NZJobScout/0.8.8', Accept: 'text/html,application/json', 'Accept-Encoding': 'identity' },
            lookup(host, options, callback) {
                lookup(host, { all: true }, (error, addresses) => {
                    if (error)
                        return callback(error);
                    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
                        return callback(new Error('Non-public network target refused'));
                    callback(null, options.all ? addresses : addresses[0].address, addresses[0].family);
                });
            },
        }, (response) => {
            const chunks = [];
            let bytes = 0;
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > LIMIT)
                    request.destroy(new Error('Public page exceeds verification size limit'));
                else
                    chunks.push(chunk);
            });
            response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
            response.on('error', (error) => { clearTimeout(timer); reject(error); });
        });
        const timer = setTimeout(() => request.destroy(new Error('Public identity verification timed out')), timeoutMs);
        request.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
}
function robotsAllows(body, pathname) {
    let applies = false;
    let hasRules = false;
    const matches = [];
    for (const line of String(body).split(/\r?\n/)) {
        const match = line.replace(/#.*$/, '').trim().match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
        if (!match)
            continue;
        const [, directive, value] = match;
        if (directive.toLowerCase() === 'user-agent') {
            if (hasRules) {
                applies = false;
                hasRules = false;
            }
            applies ||= value === '*' || value.toLowerCase().includes('nzjobscout');
        }
        else {
            hasRules = true;
            if (!applies || !value)
                continue;
            const pattern = '^' + value.split('*').map((part) => part.replace(/[.+?^{}()|[\]\\]/g, '\\$&')).join('.*').replace(/\$$/, '$');
            if (new RegExp(pattern).test(pathname))
                matches.push({ length: value.length, allow: directive.toLowerCase() === 'allow' });
        }
    }
    matches.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
    return matches[0]?.allow !== false;
}
function postingIdentities(body) {
    const identities = [];
    let visited = 0;
    const walk = (item) => {
        if (++visited > 1000 || !item || typeof item !== 'object')
            return;
        if ([].concat(item['@type'] ?? []).some((type) => /(?:^|\/)JobPosting$/.test(type))) {
            const employer = typeof item.hiringOrganization === 'string' ? item.hiringOrganization : item.hiringOrganization?.name;
            if (item.title && employer)
                identities.push({ title: plain(item.title), employer: plain(employer) });
        }
        if (Array.isArray(item))
            item.forEach(walk);
        else if (item['@graph'])
            walk(item['@graph']);
    };
    for (const match of String(body).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            walk(JSON.parse(match[1]));
        }
        catch { /* A malformed block is not evidence. */ }
    }
    return identities;
}
function metadata(body, name) {
    for (const match of body.matchAll(/<meta\b[^>]*>/gi)) {
        const attributes = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((item) => [item[1].toLowerCase(), unescape(item[2])]));
        if ((attributes.property || attributes.name)?.toLowerCase() === name)
            return attributes.content;
    }
}
function htmlIdentity(body, expected) {
    const title = plain(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const brand = metadata(body, 'og:site_name');
    const heading = [...body.matchAll(/<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/gi)].map((match) => plain(match[1]))
        .find((value) => key(value) === key(expected.title));
    if (!heading)
        return undefined;
    if (brand && key(brand) !== key(expected.employer))
        return { title: heading, employer: brand };
    if (key(brand) === key(expected.employer) || key(title).includes(key(expected.employer)))
        return { title: heading, employer: brand || expected.employer };
}
function apiTarget(value) {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'jobs.smartrecruiters.com' && /^[\w-]+$/.test(parts[0] ?? '') && /^\d+-/.test(parts[1] ?? '')) {
        return { url: `https://api.smartrecruiters.com/v1/companies/${parts[0]}/postings/${parts[1].split('-')[0]}`, employer: parts[0], titleField: 'name' };
    }
    if (url.hostname === 'jobs.lever.co' && /^[\w-]+$/.test(parts[0] ?? '') && /^[\da-f-]{36}$/.test(parts[1] ?? '')) {
        return { url: `https://api.lever.co/v0/postings/${parts[0]}/${parts[1]}`, employer: parts[0], titleField: 'text' };
    }
}
export function createIdentityVerifier(options = {}) {
    const request = options.request ?? requestPublicDocument;
    const robots = new Map();
    return async function verify(job) {
        const checkedAt = new Date().toISOString();
        const result = (status, reason, extra = {}) => ({ status, reason, checkedAt, ...extra });
        const start = Date.now();
        let calls = 0;
        const read = async (value, depth = 0) => {
            const url = publicUrl(value);
            if (isShortVacancyUrl(value))
                throw new Error('Short links cannot establish vacancy identity; supply the observed canonical employer/ATS URL');
            if (!robots.has(url.origin))
                robots.set(url.origin, request(`${url.origin}/robots.txt`, 3000));
            const rules = await robots.get(url.origin);
            if (rules.status === 200 && !robotsAllows(rules.body, url.pathname + url.search))
                throw new Error('robots restriction; source not retried');
            if (![200, 404, 410].includes(rules.status))
                throw new Error('robots availability could not be checked; source not retried');
            if (++calls > 4 || Date.now() - start >= 10000)
                throw new Error('Identity verification budget exhausted');
            const response = await request(url.toString(), Math.min(4000, 10000 - (Date.now() - start)));
            if ([401, 403, 429].includes(response.status))
                throw new Error(`Public source restricted (${response.status}); no fallback or bypass attempted`);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                if (depth >= 2 || !response.headers?.location)
                    throw new Error('Unresolved redirect');
                return read(new URL(response.headers.location, url).toString(), depth + 1);
            }
            if (response.status !== 200)
                throw new Error(`Public vacancy returned ${response.status}; not proof of closure`);
            return { ...response, url: url.toString() };
        };
        try {
            const source = await read(job.sourceUrl);
            let identities = postingIdentities(source.body);
            const fallback = htmlIdentity(source.body, job);
            if (!identities.length && fallback)
                identities = [fallback];
            const target = !identities.length ? apiTarget(source.url) : undefined;
            if (target) {
                const response = await read(target.url);
                const json = JSON.parse(response.body);
                if (json[target.titleField])
                    identities = [{ title: json[target.titleField], employer: json.company?.name || target.employer }];
            }
            const identity = identities.find((item) => key(item.title) === key(job.title) && key(item.employer) === key(job.employer));
            if (!identity)
                return result(identities.length ? 'mismatch' : 'unverified', identities.length
                    ? 'Observed vacancy employer/title does not match the claimed role' : 'No independent vacancy identity could be extracted', { observed: identities.slice(0, 4), sourceUrl: source.url });
            const application = job.application;
            if (application?.method === 'email') {
                if (!unescape(source.body).toLowerCase().includes(String(application.email).toLowerCase()))
                    return result('unverified', 'Application email was not observed on the verified primary page');
            }
            else {
                if (!application?.url || isShortVacancyUrl(application.url))
                    return result('unverified', 'A canonical direct application URL is required');
                const from = new URL(source.url);
                const to = publicUrl(application.url);
                const normal = (value) => { const u = new URL(value); u.hash = ''; for (const name of [...u.searchParams.keys()])
                    if (/^(utm_|ref$|tracking|origin$|oga$)/i.test(name))
                        u.searchParams.delete(name); return u.toString().replace(/\/$/, ''); };
                if (normal(from) !== normal(to)) {
                    const linked = [...source.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].some((match) => { try {
                        return normal(new URL(unescape(match[1]), from)) === normal(to);
                    }
                    catch {
                        return false;
                    } });
                    const vacancyId = from.pathname.match(/jid-(\d+)\/?$/)?.[1];
                    if (!(linked && from.origin === to.origin && vacancyId && to.searchParams.get('vacancyId') === vacancyId)) {
                        const page = await read(to.toString());
                        const candidates = [...postingIdentities(page.body), htmlIdentity(page.body, job)].filter(Boolean);
                        if (!candidates.some((item) => key(item.title) === key(job.title) && key(item.employer) === key(job.employer)))
                            return result('unverified', 'Application page did not independently establish the same employer and role');
                    }
                }
            }
            return result('verified', 'Primary vacancy and application identities agree', { ...identity, sourceUrl: source.url, applicationVerified: true });
        }
        catch (error) {
            return result('unverified', error.message);
        }
    };
}
