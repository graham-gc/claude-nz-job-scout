// Optional authenticated board reads, isolated from public-source verification.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
const ROOT = join(homedir(), '.local', 'share', 'nz-job-scout');
const SESSIONS = join(ROOT, 'sessions');
const requireLocal = createRequire(join(ROOT, 'package.json'));
const MAX_URLS = 5;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_DESCRIPTION = 4500;
const SITES = {
    seek: {
        home: 'https://nz.seek.com/',
        hosts: ['nz.seek.com', 'www.seek.co.nz', 'seek.co.nz'],
        path: /^\/job\/(\d+)\/?$/,
        title: '[data-automation="job-detail-title"]',
        employer: '[data-automation="advertiser-name"]',
        location: '[data-automation="job-detail-location"]',
        description: '[data-automation="jobAdDetails"]',
    },
    linkedin: {
        home: 'https://www.linkedin.com/',
        hosts: ['www.linkedin.com', 'nz.linkedin.com', 'linkedin.com'],
        path: /^\/jobs\/view\/(?:[a-z0-9_-]+-)?(\d+)\/?$/i,
        title: '.job-details-jobs-unified-top-card__job-title h1, h1.top-card-layout__title',
        employer: '.job-details-jobs-unified-top-card__company-name, .topcard__org-name-link',
        location: '.topcard__flavor--bullet',
        description: '#job-details, .jobs-description__content, .show-more-less-html__markup',
    },
};
export function boardJobTarget(value) {
    const invalid = new Error('Expected an exact HTTPS SEEK NZ or LinkedIn vacancy URL');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw invalid;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
        throw invalid;
    for (const source of Object.keys(SITES)) {
        const site = SITES[source];
        if (!site.hosts.includes(url.hostname))
            continue;
        const id = site.path.exec(url.pathname)?.[1];
        if (!id)
            break;
        return { source, id, url: url.origin + url.pathname };
    }
    throw invalid;
}
function scopedCookies(source, cookies) {
    return cookies.filter((cookie) => {
        if (typeof cookie?.domain !== 'string')
            return false;
        const domain = cookie.domain.toLowerCase();
        return SITES[source].hosts.some((host) => domain.startsWith('.') ? host.endsWith(domain) || host === domain.slice(1) : host === domain);
    });
}
async function saveSession(source, cookies) {
    const state = { cookies: scopedCookies(source, cookies), origins: [] };
    if (!state.cookies.length)
        throw new Error('No site cookies were saved. Sign in in the opened browser and try again.');
    await mkdir(SESSIONS, { mode: 0o700, recursive: true });
    const directory = await lstat(SESSIONS);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
        throw new Error('The session directory must be private to the current user.');
    }
    const target = join(SESSIONS, source + '.json');
    const temporary = join(SESSIONS, randomUUID() + '.tmp');
    try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
async function loadSession(source) {
    const file = await open(join(SESSIONS, source + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        if (error.code !== 'ENOENT')
            throw error;
    });
    if (!file)
        return;
    try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 256 * 1024)
            throw new Error('Session file is not private or is invalid');
        const state = JSON.parse(await file.readFile('utf8'));
        if (!Array.isArray(state.cookies))
            throw new Error('Invalid saved session');
        const cookies = scopedCookies(source, state.cookies);
        if (cookies.length)
            return { cookies, origins: [] };
    }
    finally {
        await file.close();
    }
}
async function login(source) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error('Run board-login yourself in a local terminal, not inside a scan.');
    const sdk = optionalPackage('playwright');
    const browser = await sdk.chromium.launch({ headless: false }).catch(() => {
        throw new Error('Could not open the sign-in browser. Install Chromium for the optional SDK first.');
    });
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(SITES[source].home, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
            throw new Error('Could not open the official sign-in site.');
        });
        await terminal.question('Sign in in the opened browser, then press Enter here to save the session (Ctrl+C to cancel). ');
        await saveSession(source, await context.cookies());
        console.log(`Saved the ${source} session locally. The next detail request will use it directly.`);
    }
    finally {
        terminal.close();
        await browser.close();
    }
}
class OptionalSdkMissing extends Error {
}
function optionalPackage(name) {
    try {
        return requireLocal(name);
    }
    catch {
        throw new OptionalSdkMissing('The optional board SDK is not installed in ~/.local/share/nz-job-scout.');
    }
}
function clean(value, limit) {
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}
function extractVacancy(html, target, load) {
    const $ = load(html);
    const site = SITES[target.source];
    const first = (selector) => clean($(selector).first().text(), 240);
    const textOnly = (fragment) => {
        const doc = load(fragment);
        doc('script, style, template, noscript, form, iframe, svg').remove();
        doc('br, p, li, h2, h3, h4, div').append('\n');
        return doc('body').text();
    };
    const postings = [];
    let visited = 0;
    const walk = (value) => {
        if (++visited > 300 || !value || typeof value !== 'object')
            return;
        if (Array.isArray(value)) {
            value.slice(0, 300).forEach(walk);
            return;
        }
        const object = value;
        if ([object['@type']].flat().some((type) => typeof type === 'string' && /(?:^|\/)JobPosting$/.test(type)))
            postings.push(object);
        else if (object['@graph'])
            walk(object['@graph']);
    };
    for (const block of $('script[type="application/ld+json"]').toArray().slice(0, 20)) {
        try {
            walk(JSON.parse($(block).text()));
        }
        catch { /* malformed structured data is not evidence */ }
    }
    const matches = (value) => {
        if (typeof value !== 'string')
            return false;
        try {
            const link = boardJobTarget(new URL(value, target.url).toString());
            return link.source === target.source && link.id === target.id;
        }
        catch {
            return false;
        }
    };
    const posting = postings.find((item) => matches(item.url)) ?? (postings.length === 1 && !postings[0]?.url ? postings[0] : undefined);
    const field = (value) => typeof value === 'string' ? clean(textOnly(value), 240) : '';
    const description = $(site.description).first();
    // Extract only the job description, never full signed-in page text or headers.
    let rawDescription = '';
    if (description.length) {
        description.find('script, style, template, noscript, form, iframe, svg').remove();
        description.find('br, p, li, h2, h3, h4, div').append('\n');
        rawDescription = description.text();
    }
    if (!clean(rawDescription, 1) && typeof posting?.description === 'string')
        rawDescription = textOnly(posting.description);
    const jobDescription = clean(rawDescription, MAX_DESCRIPTION + 1);
    if (!jobDescription)
        return;
    const company = posting?.hiringOrganization;
    const locations = [posting?.jobLocation].flat().map((item) => {
        const address = item?.address;
        return [field(address?.addressLocality), field(address?.addressRegion)].filter(Boolean).join(', ');
    }).filter(Boolean);
    return {
        title: first(site.title) || field(posting?.title),
        employer: first(site.employer) || field(typeof company === 'string' ? company : company?.name),
        location: first(site.location) || locations.join('; ').slice(0, 240),
        postedAt: field(posting?.datePosted),
        closesAt: field(posting?.validThrough),
        description: jobDescription.slice(0, MAX_DESCRIPTION),
        descriptionTruncated: jobDescription.length > MAX_DESCRIPTION,
    };
}
function redirectStatus(location) {
    if (!location)
        return 'unavailable';
    try {
        const url = new URL(location, 'https://example.com');
        if (/captcha|challenge|checkpoint|security-verification/i.test(url.pathname))
            return 'restricted';
        if (/(?:^|\/)(?:authwall|login|sign-in|signin|auth)(?:\/|$)/i.test(url.pathname) || /^(?:login|secure)\.seek\./i.test(url.hostname))
            return 'login-required';
    }
    catch { /* report a generic redirect */ }
    return 'unavailable';
}
async function readJob(target, context, load) {
    const result = (status, reason, httpStatus) => ({ ...target, status, reason, ...(httpStatus ? { httpStatus } : {}) });
    let response;
    try {
        response = await context.get(target.url, { timeout: 6000, maxRedirects: 0, failOnStatusCode: false });
        const status = response.status();
        const headers = response.headers();
        if (status >= 300 && status < 400)
            return result(redirectStatus(headers.location), 'The board redirected the request; the redirect was not followed.', status);
        if (status === 401)
            return result('login-required', 'The board did not accept the saved session.', status);
        if ([403, 429, 999].includes(status))
            return result('restricted', 'The board restricted the request; no fallback was attempted.', status);
        if (status !== 200)
            return result('unavailable', 'The board did not return a vacancy page; this is not proof of closure.', status);
        if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(headers['content-type'] ?? ''))
            return result('unavailable', 'The response is not HTML.', status);
        const body = await response.body();
        if (body.length > MAX_BODY)
            return result('unavailable', 'The response exceeded the extraction size limit.', status);
        const html = body.toString('utf8');
        if (/<title\b[^>]*>\s*(?:security verification|verify (?:you are human|your identity)|access denied|just a moment|captcha)\b/i.test(html)) {
            return result('restricted', 'The response is an access challenge; no fallback was attempted.', status);
        }
        if (/<title\b[^>]*>\s*(?:(?:linkedin|seek)(?:\s*[-|–:]\s*|\s+))?(?:sign in|log in|login|join linkedin)\b/i.test(html)) {
            return result('login-required', 'The response is a sign-in page.', status);
        }
        const vacancy = extractVacancy(html, target, load);
        if (vacancy)
            return { ...target, status: 'read', httpStatus: status, vacancy };
        if (/<form\b[^>]*action=["'][^"']*\/(?:login-submit|uas\/login-submit|signin)\b/i.test(html)) {
            return result('login-required', 'The response is a sign-in page.', status);
        }
        return result('no-description', 'No vacancy description was found in the HTML. No JavaScript or secondary endpoint was run.', status);
    }
    catch {
        return result('unavailable', 'The detail request or extraction did not complete.');
    }
    finally {
        await response?.dispose().catch(() => { });
    }
}
export async function readBoardJobs(urls, dependencies) {
    if (urls.length < 1 || urls.length > MAX_URLS)
        throw new Error(`Provide between 1 and ${MAX_URLS} --url arguments.`);
    const unique = new Map();
    for (const value of urls) {
        const target = boardJobTarget(value);
        const key = target.source + ':' + target.id;
        if (!unique.has(key))
            unique.set(key, target);
    }
    const targets = [...unique.values()];
    const results = await Promise.all(Object.keys(SITES).map(async (source) => {
        const group = targets.filter((target) => target.source === source);
        if (!group.length)
            return [];
        let context;
        try {
            const state = await dependencies.loadSession(source);
            if (!state)
                return group.map((target) => ({ ...target, status: 'not-configured', reason: 'No saved session for this source; no request was made.' }));
            context = await dependencies.createContext(state);
            const found = [];
            let stop;
            for (const target of group) {
                const outcome = stop ? { ...target, status: stop, reason: 'Skipped after this source returned a login or access restriction.' }
                    : await readJob(target, context, dependencies.loadHtml);
                if (outcome.status === 'restricted' || outcome.status === 'login-required')
                    stop = outcome.status;
                found.push(outcome);
            }
            return found;
        }
        catch (error) {
            if (error instanceof OptionalSdkMissing)
                return group.map((target) => ({ ...target, status: 'not-configured', reason: error.message }));
            return group.map((target) => ({ ...target, status: 'unavailable', reason: 'The saved session or optional SDK could not be opened.' }));
        }
        finally {
            await context?.dispose().catch(() => { });
        }
    }));
    const byUrl = new Map(results.flat().map((result) => [result.url, result]));
    return targets.map((target) => byUrl.get(target.url));
}
export async function runBoardCli(command, args) {
    if (command === 'board-login') {
        const [flag, source] = args;
        if (args.length !== 2 || flag !== '--source' || (source !== 'seek' && source !== 'linkedin')) {
            throw new Error('Usage: board-login --source seek|linkedin');
        }
        await login(source);
        return;
    }
    const urls = [];
    for (let index = 0; index < args.length; index += 2) {
        const value = args[index + 1];
        if (args[index] !== '--url' || !value)
            throw new Error('Usage: board-details --url VACANCY_URL [--url VACANCY_URL ...]');
        urls.push(value);
    }
    const results = await readBoardJobs(urls, {
        loadSession,
        createContext: async (state) => {
            optionalPackage('cheerio');
            return optionalPackage('playwright').request.newContext({ storageState: state });
        },
        loadHtml: (html) => optionalPackage('cheerio').load(html),
    });
    console.log(JSON.stringify({ results }));
}
