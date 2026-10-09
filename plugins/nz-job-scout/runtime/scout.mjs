#!/usr/bin/env node
// Single source of truth for the dependency-free runtime bundled with the plugin.
// The module deliberately uses JavaScript-compatible TypeScript so `tsc` can emit
// a standalone .mjs file without introducing runtime packages.
// @ts-nocheck
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const PLUGIN_VERSION = '0.7.0';
export const SESSION_SCHEMA_VERSION = 4;
const LEVEL_WEIGHT = { core: 1, frequent: 0.85, working: 0.6, exposure: 0.25 };
const ELIGIBILITY_REQUIREMENT = /\b(degree|qualification|nzqa|tertiary|student|studying|graduate|work rights?|visa|citizen|resident)\b/i;
const CONCEPT_GROUPS = [
    ['software engineering', 'software development', 'software product development', 'application development'],
    ['backend engineering', 'backend development', 'server side development', 'api development', 'rest api development', 'microservices'],
    ['test automation', 'automated testing', 'api automation', 'software testing', 'quality engineering', 'sdet'],
    ['platform engineering', 'developer productivity', 'engineering productivity', 'developer tooling', 'internal tools'],
    ['performance testing', 'load testing', 'performance engineering'],
    ['full stack development', 'web application development', 'frontend and backend development'],
    ['debugging', 'troubleshooting', 'root cause analysis', 'production support'],
    ['technology services', 'digital services', 'ict services', 'it support', 'technical support', 'systems support', 'application support', 'service management', 'it operations', 'software support'],
    ['sql', 'relational databases', 'database development'],
    ['ci cd', 'continuous integration', 'continuous delivery', 'jenkins'],
    ['api', 'rest api', 'http api', 'web service'],
];
const GENERIC_ROLE_TOKENS = new Set([
    'engineer', 'engineering', 'developer', 'development', 'intern', 'internship',
    'graduate', 'junior', 'senior', 'software',
]);
const BLOCKED_AGGREGATORS = [
    'bebee.', 'ziprecruiter.', 'thebigjobsite.', 'joblum.', 'broxer.', 'jooble.',
    'builtin.', 'career.now', 'jobleads.', 'expertini.', 'jobspace.', 'jora.',
    'omnijobs.', 'alion.io', 'hiringcafe.', 'freehire.',
];
const DISCOVERY_ONLY_HOSTS = ['seek.', 'linkedin.', 'indeed.'];
const DAILY_REPORT_PATTERN = /^nz-jobs-(\d{4}-\d{2}-\d{2})(?:-[a-f0-9]{8})?\.md$/;
const ITEM_MARKER = /<!-- nz-job-scout:item (\{.+?\}) -->/g;
const CONTEXT_MARKER = /<!-- nz-job-scout:context (\{.+?\}) -->/;
const STATE_FILE_NAME = '.nz-job-scout-state.json';
const UNSUPPORTED_WORK_RIGHTS_ASSUMPTION = /\b(unrestricted work rights?|post[- ]graduation(?: work)? rights?|post[- ]study work rights?)\b/i;
const asText = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];
const clamp = (value, min = 0, max = 10) => Math.max(min, Math.min(max, value));
const round1 = (value) => Math.round(value * 10) / 10;
const normalise = (value) => asText(value).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
const SOURCE_KIND_WEIGHT = { employer: 5, ats: 5, 'job-board': 3, 'search-result': 2, aggregator: 1 };
function aucklandDateKey(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value);
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}
function shiftDateKey(value, days) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function parseDate(value, label) {
    if (!value)
        return undefined;
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(date.getTime()))
        throw new Error(`${label} is not a valid date: ${value}`);
    return date;
}
function dateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(asText(value));
}
function closingHasPassed(value, now) {
    if (!value)
        return false;
    if (dateOnly(value))
        return value < aucklandDateKey(now);
    return parseDate(value, 'closesAt').getTime() < now.getTime();
}
function postingAgeDays(value, now) {
    if (!value)
        return undefined;
    if (dateOnly(value)) {
        const today = Date.parse(`${aucklandDateKey(now)}T00:00:00Z`);
        return Math.floor((today - Date.parse(`${value}T00:00:00Z`)) / 86_400_000);
    }
    return Math.floor((now.getTime() - parseDate(value, 'postedAt').getTime()) / 86_400_000);
}
export function normaliseUrl(value) {
    if (!value)
        return '';
    try {
        const url = new URL(value);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/^(ref|source|tracking|trk|eBP|trackingId|refId|seek-token|origin|utm_.*)$/i.test(key))
                url.searchParams.delete(key);
        }
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.toString();
    }
    catch {
        return asText(value);
    }
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function fingerprint(value) {
    return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 20);
}
export function deriveScanContext(session) {
    const resumeFingerprint = asText(session.resumeFingerprint) || undefined;
    const criteriaFingerprint = fingerprint({
        keywords: asArray(session.preferences?.keywords),
        maxPostingAgeDays: Number(session.preferences?.maxPostingAgeDays ?? 30),
        includeTechnicalVolunteer: session.preferences?.includeTechnicalVolunteer === true,
        constraints: asArray(session.preferences?.constraints),
        programmeTypes: asArray(session.preferences?.programmeTypes),
        contractTypes: asArray(session.preferences?.contractTypes),
        workloads: asArray(session.preferences?.workloads),
        locations: asArray(session.preferences?.locations),
        workArrangements: asArray(session.preferences?.workArrangements),
    });
    const scanContextFingerprint = fingerprint({ mode: session.preferences?.mode, resumeFingerprint, criteriaFingerprint });
    return { mode: session.preferences?.mode, resumeFingerprint, criteriaFingerprint, scanContextFingerprint };
}
function parseContextMarker(markdown) {
    const match = markdown.match(CONTEXT_MARKER);
    if (!match)
        return undefined;
    try {
        return JSON.parse(match[1]);
    }
    catch {
        return undefined;
    }
}
function hostMatches(value, domains) {
    try {
        return domains.some((domain) => new URL(value).hostname.toLowerCase().includes(domain));
    }
    catch {
        return false;
    }
}
function sourceEvidenceRank(entry) {
    return (SOURCE_KIND_WEIGHT[entry?.kind] ?? 0) * 10
        + Number(entry?.detailPageOpened === true) * 3
        + Number(entry?.applyRouteAvailable === true) * 3
        + Number(Boolean(entry?.applicationUrl))
        + Number(Boolean(entry?.requisitionId));
}
function bestSourceEvidence(job) {
    return [...asArray(job.sourceEvidence)].sort((left, right) => sourceEvidenceRank(right) - sourceEvidenceRank(left))[0];
}
function canonicaliseJobEvidence(job) {
    const sourceEvidence = [...asArray(job.sourceEvidence)].sort((left, right) => sourceEvidenceRank(right) - sourceEvidenceRank(left));
    const strongest = sourceEvidence[0];
    if (!strongest)
        return job;
    return {
        ...job,
        source: strongest.name,
        sourceUrl: normaliseUrl(strongest.url),
        applicationUrl: normaliseUrl(strongest.applicationUrl || (strongest.applyRouteAvailable ? strongest.url : '')),
        requisitionId: strongest.requisitionId || job.requisitionId,
        sourceEvidence,
        verificationEvidence: {
            ...job.verificationEvidence,
            detailPageOpened: strongest.detailPageOpened === true,
            applyRouteAvailable: strongest.applyRouteAvailable === true,
            expiredIndicatorVisible: strongest.expiredIndicatorVisible === true,
            unavailableIndicatorVisible: strongest.unavailableIndicatorVisible === true,
            verifiedAt: strongest.observedAt || job.verificationEvidence?.verifiedAt,
        },
    };
}
function sameRole(left, right) {
    return normalise(left?.employer) === normalise(right?.employer)
        && normalise(left?.title) === normalise(right?.title);
}
function leadMatchesJob(lead, job) {
    const leadUrl = normaliseUrl(lead?.url);
    return Boolean(leadUrl && [normaliseUrl(job?.sourceUrl), normaliseUrl(job?.applicationUrl)].includes(leadUrl))
        || sameRole(lead, job);
}
function dateObservations(job, field) {
    const recorded = asArray(job.dateEvidence?.[field]);
    if (recorded.length)
        return recorded;
    const legacy = job[field];
    return legacy ? [{ value: legacy, sourceUrl: job.sourceUrl, sourceType: 'legacy', confidence: 'low' }] : [];
}
export function resolveDateEvidence(job, field) {
    const allObservations = dateObservations(job, field).filter((entry) => asText(entry?.value));
    const authoritative = allObservations.filter((entry) => ['employer', 'ats'].includes(entry.sourceType));
    const observations = authoritative.length ? authoritative : allObservations;
    for (const entry of observations)
        parseDate(entry.value, `${field}.value`);
    const values = [...new Set(observations.map((entry) => entry.value))];
    return {
        value: values.length === 1 ? values[0] : undefined,
        observations,
        conflict: values.length > 1,
        conflictingValues: values.length > 1 ? values : [],
    };
}
function jobIdentityKeys(job) {
    const keys = [];
    const applicationUrl = normaliseUrl(job.applicationUrl);
    const sourceUrl = normaliseUrl(job.sourceUrl);
    if (applicationUrl)
        keys.push(`url:${applicationUrl}`);
    if (sourceUrl)
        keys.push(`url:${sourceUrl}`);
    if (job.requisitionId)
        keys.push(`req:${normalise(job.employer)}:${normalise(job.requisitionId)}`);
    const employer = normalise(job.employer);
    const title = normalise(job.title);
    const location = normalise(job.location);
    if (employer && title) {
        keys.push(`role:${employer}|${title}|${location}`);
        if (!job.requisitionId && !applicationUrl)
            keys.push(`role-loose:${employer}|${title}`);
    }
    return [...new Set(keys)];
}
function opportunityIdentityKeys(item) {
    const url = normaliseUrl(item.url);
    return [...new Set([...(url ? [`url:${url}`] : []), `opportunity:${normalise(item.organisation)}|${normalise(item.title)}`])];
}
function requiredString(value, path, errors) {
    if (!asText(value))
        errors.push(`${path} is required`);
}
function validateStringArray(value, path, errors, options = {}) {
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return;
    }
    if (options.nonEmpty === true && value.length === 0)
        errors.push(`${path} must contain at least one value`);
    value.forEach((entry, index) => {
        if (typeof entry !== 'string' || !entry.trim())
            errors.push(`${path}[${index}] must be a non-empty string`);
    });
}
function validateDateEvidence(job, index, errors) {
    const sourceTypes = new Set(['employer', 'ats', 'job-board', 'structured-data', 'search-result', 'legacy']);
    const confidenceValues = new Set(['high', 'medium', 'low']);
    for (const field of ['postedAt', 'closesAt', 'startAt', 'endAt']) {
        asArray(job?.dateEvidence?.[field]).forEach((entry, evidenceIndex) => {
            requiredString(entry?.value, `jobs[${index}].dateEvidence.${field}[${evidenceIndex}].value`, errors);
            requiredString(entry?.sourceUrl, `jobs[${index}].dateEvidence.${field}[${evidenceIndex}].sourceUrl`, errors);
            if (!sourceTypes.has(entry?.sourceType))
                errors.push(`jobs[${index}].dateEvidence.${field}[${evidenceIndex}].sourceType is invalid`);
            if (!confidenceValues.has(entry?.confidence))
                errors.push(`jobs[${index}].dateEvidence.${field}[${evidenceIndex}].confidence is invalid`);
            if (entry?.value) {
                try {
                    parseDate(entry.value, `jobs[${index}].dateEvidence.${field}[${evidenceIndex}].value`);
                }
                catch (error) {
                    errors.push(error.message);
                }
            }
        });
    }
}
export function deriveSearchCoverage(searchCoverage = {}, leads = []) {
    const attempts = asArray(searchCoverage.attempts);
    const families = asArray(searchCoverage.searchFamilies);
    const sourceTargets = asArray(searchCoverage.sourceTargets);
    const explicitFamilies = asArray(searchCoverage.explicitSearchFamilies);
    const programmeFirstRequired = searchCoverage.programmeFirstRequired === true;
    const searched = attempts.filter((attempt) => attempt.status === 'searched');
    const materialFailures = attempts.filter((attempt) => attempt.requiredForCoverage !== false && ['blocked', 'unavailable', 'discovery-only'].includes(attempt.status));
    const successfulFamilyStrategy = (family, strategy) => searched.some((attempt) => normalise(attempt.roleFamily) === normalise(family) && attempt.strategy === strategy);
    const missingBroadDiscoveryFamilies = families.filter((family) => !successfulFamilyStrategy(family, 'broad-discovery'));
    const missingSourceInventoryFamilies = families.filter((family) => !successfulFamilyStrategy(family, 'source-inventory'));
    const unsearchedFamilies = families.filter((family) => missingBroadDiscoveryFamilies.includes(family) && missingSourceInventoryFamilies.includes(family));
    const requiredEmployers = [...new Set(asArray(leads)
            .filter((lead) => lead.employerExpansionRequired === true)
            .map((lead) => asText(lead.employer))
            .filter(Boolean))];
    const unexpandedEmployers = requiredEmployers.filter((employer) => !searched.some((attempt) => attempt.strategy === 'employer-expansion' && normalise(attempt.employer) === normalise(employer)));
    const missingRequiredSourceTargets = sourceTargets
        .filter((target) => target.requiredForCoverage !== false && target.status !== 'searched')
        .map((target) => asText(target.name))
        .filter(Boolean);
    const missingExplicitFamilies = explicitFamilies.filter((explicitFamily) => !families.some((family) => normalise(family) === normalise(explicitFamily)));
    const missingProgrammeDiscovery = programmeFirstRequired && !searched.some((attempt) => attempt.strategy === 'programme-discovery');
    const missingProgrammeInventory = programmeFirstRequired && !sourceTargets.some((target) => target.purpose === 'programme-inventory' && target.status === 'searched');
    const incompletePlan = missingBroadDiscoveryFamilies.length || missingSourceInventoryFamilies.length || unexpandedEmployers.length
        || missingRequiredSourceTargets.length || missingExplicitFamilies.length || missingProgrammeDiscovery || missingProgrammeInventory;
    const status = searched.length === 0 ? 'blocked' : materialFailures.length || incompletePlan ? 'partial' : 'complete';
    const leadList = asArray(leads);
    return {
        status,
        searchFamilies: families,
        queriesRun: attempts.length,
        leadsDiscovered: leadList.length,
        detailPagesOpened: leadList.filter((lead) => lead.detailPageOpened === true).length,
        attempts,
        unsearchedFamilies,
        missingBroadDiscoveryFamilies,
        missingSourceInventoryFamilies,
        unexpandedEmployers,
        sourceTargets,
        missingRequiredSourceTargets,
        explicitSearchFamilies: explicitFamilies,
        missingExplicitFamilies,
        programmeFirstRequired,
        missingProgrammeDiscovery,
        missingProgrammeInventory,
    };
}
export function validateSession(session) {
    const errors = [];
    if (!session || typeof session !== 'object' || Array.isArray(session))
        return { valid: false, errors: ['session must be a JSON object'] };
    if (session.pluginVersion !== PLUGIN_VERSION)
        errors.push(`pluginVersion must be ${PLUGIN_VERSION}`);
    if (session.sessionSchemaVersion !== SESSION_SCHEMA_VERSION)
        errors.push(`sessionSchemaVersion must be ${SESSION_SCHEMA_VERSION}`);
    if (!session.candidate || typeof session.candidate !== 'object')
        errors.push('candidate is required');
    if (!session.preferences || typeof session.preferences !== 'object')
        errors.push('preferences is required');
    if (!Array.isArray(session.jobs))
        errors.push('jobs must be an array');
    if (!Array.isArray(session.leads))
        errors.push('leads must be an array');
    if (!Array.isArray(session.relatedOpportunities))
        errors.push('relatedOpportunities must be an array');
    if (session.preferences && !['profile', 'criteria', 'combined'].includes(session.preferences.mode))
        errors.push('preferences.mode must be profile, criteria, or combined');
    if (['profile', 'combined'].includes(session.preferences?.mode) && !/^[a-f0-9]{64}$/i.test(asText(session.resumeFingerprint))) {
        errors.push('resumeFingerprint must be the 64-character SHA-256 of the supplied resume in profile or combined mode');
    }
    if (session.preferences?.mode === 'criteria' && asText(session.resumeFingerprint))
        errors.push('criteria mode must not include resumeFingerprint');
    if (session.preferences && !Array.isArray(session.preferences.constraints))
        errors.push('preferences.constraints must be an array');
    asArray(session.preferences?.constraints).forEach((constraint, index) => {
        requiredString(constraint?.field, `preferences.constraints[${index}].field`, errors);
        requiredString(constraint?.value, `preferences.constraints[${index}].value`, errors);
        if (!['hard', 'soft'].includes(constraint?.strength))
            errors.push(`preferences.constraints[${index}].strength must be hard or soft`);
        if (!['user-explicit', 'conversation-context', 'resume-inferred', 'skill-default'].includes(constraint?.source))
            errors.push(`preferences.constraints[${index}].source is invalid`);
    });
    if (!session.searchCoverage || typeof session.searchCoverage !== 'object')
        errors.push('searchCoverage is required');
    else {
        if (!Array.isArray(session.searchCoverage.searchFamilies) || !session.searchCoverage.searchFamilies.length)
            errors.push('searchCoverage.searchFamilies must contain at least one role family');
        if (!Array.isArray(session.searchCoverage.attempts) || !session.searchCoverage.attempts.length)
            errors.push('searchCoverage.attempts must contain each search attempt');
        if (!Array.isArray(session.searchCoverage.explicitSearchFamilies))
            errors.push('searchCoverage.explicitSearchFamilies must be an array');
        if (typeof session.searchCoverage.programmeFirstRequired !== 'boolean')
            errors.push('searchCoverage.programmeFirstRequired must be boolean');
        if (!Array.isArray(session.searchCoverage.sourceTargets) || !session.searchCoverage.sourceTargets.length)
            errors.push('searchCoverage.sourceTargets must contain the planned public sources');
        const familyNames = asArray(session.searchCoverage.searchFamilies).map(normalise);
        asArray(session.searchCoverage.explicitSearchFamilies).forEach((family) => {
            if (!familyNames.includes(normalise(family)))
                errors.push(`Explicit search family is missing from searchFamilies: ${family}`);
        });
        const statuses = new Set(['searched', 'discovery-only', 'blocked', 'unavailable', 'skipped']);
        const strategies = new Set(['programme-discovery', 'broad-discovery', 'source-inventory', 'employer-expansion', 'focused-follow-up']);
        asArray(session.searchCoverage.attempts).forEach((attempt, index) => {
            requiredString(attempt?.roleFamily, `searchCoverage.attempts[${index}].roleFamily`, errors);
            requiredString(attempt?.source, `searchCoverage.attempts[${index}].source`, errors);
            requiredString(attempt?.query, `searchCoverage.attempts[${index}].query`, errors);
            if (!statuses.has(attempt?.status))
                errors.push(`searchCoverage.attempts[${index}].status is invalid`);
            if (!strategies.has(attempt?.strategy))
                errors.push(`searchCoverage.attempts[${index}].strategy is invalid`);
            if (attempt?.strategy === 'employer-expansion')
                requiredString(attempt?.employer, `searchCoverage.attempts[${index}].employer`, errors);
        });
        const targetPurposes = new Set(['board-discovery', 'programme-inventory', 'employer-ats', 'technical-volunteer']);
        const inventoryScopes = new Set(['listing-page', 'ats-board', 'search-results', 'single-detail', 'event-page']);
        asArray(session.searchCoverage.sourceTargets).forEach((target, index) => {
            requiredString(target?.name, `searchCoverage.sourceTargets[${index}].name`, errors);
            requiredString(target?.url, `searchCoverage.sourceTargets[${index}].url`, errors);
            if (target?.url) {
                try {
                    new URL(target.url);
                }
                catch {
                    errors.push(`searchCoverage.sourceTargets[${index}].url must be an absolute URL`);
                }
            }
            if (!Number.isInteger(target?.itemsInspected) || target.itemsInspected < 0)
                errors.push(`searchCoverage.sourceTargets[${index}].itemsInspected must be a non-negative integer`);
            if (!Array.isArray(target?.itemUrls))
                errors.push(`searchCoverage.sourceTargets[${index}].itemUrls must be an array`);
            else {
                if (target.itemsInspected !== target.itemUrls.length)
                    errors.push(`searchCoverage.sourceTargets[${index}].itemsInspected must equal itemUrls.length`);
                target.itemUrls.forEach((itemUrl, itemIndex) => {
                    try {
                        new URL(itemUrl);
                    }
                    catch {
                        errors.push(`searchCoverage.sourceTargets[${index}].itemUrls[${itemIndex}] must be an absolute URL`);
                    }
                });
            }
            if (!inventoryScopes.has(target?.inventoryScope))
                errors.push(`searchCoverage.sourceTargets[${index}].inventoryScope is invalid`);
            if (!targetPurposes.has(target?.purpose))
                errors.push(`searchCoverage.sourceTargets[${index}].purpose is invalid`);
            if (!statuses.has(target?.status))
                errors.push(`searchCoverage.sourceTargets[${index}].status is invalid`);
            if (target?.purpose === 'programme-inventory' && ['single-detail', 'event-page'].includes(target?.inventoryScope)) {
                errors.push(`searchCoverage.sourceTargets[${index}] cannot use a ${target.inventoryScope} as a programme inventory`);
            }
            if (target?.purpose === 'employer-ats') {
                requiredString(target?.employer, `searchCoverage.sourceTargets[${index}].employer`, errors);
                if (!['listing-page', 'ats-board'].includes(target?.inventoryScope))
                    errors.push(`searchCoverage.sourceTargets[${index}] employer-ats must be a listing-page or ats-board`);
                if (hostMatches(target?.url, [...BLOCKED_AGGREGATORS, ...DISCOVERY_ONLY_HOSTS]))
                    errors.push(`searchCoverage.sourceTargets[${index}] employer-ats must use a public employer or ATS inventory, not a discovery or aggregator host`);
            }
        });
        const plannedPurposes = new Set(asArray(session.searchCoverage.sourceTargets).map((target) => target.purpose));
        for (const purpose of ['board-discovery', 'employer-ats']) {
            if (!plannedPurposes.has(purpose))
                errors.push(`searchCoverage.sourceTargets needs ${purpose === 'employer-ats' ? 'an' : 'a'} ${purpose} target`);
        }
        if (session.preferences?.includeTechnicalVolunteer === true && !plannedPurposes.has('technical-volunteer'))
            errors.push('Technical volunteer searches need a technical-volunteer source target');
        if (session.searchCoverage.programmeFirstRequired === true) {
            if (!asArray(session.searchCoverage.attempts).some((attempt) => attempt.strategy === 'programme-discovery'))
                errors.push('programmeFirstRequired needs a programme-discovery attempt');
            if (!asArray(session.searchCoverage.sourceTargets).some((target) => target.purpose === 'programme-inventory'))
                errors.push('programmeFirstRequired needs a programme-inventory source target');
        }
    }
    const leadStatuses = new Set(['assessed', 'duplicate', 'blocked', 'not-opened', 'out-of-scope', 'previously-reported']);
    const leadPriorities = new Set(['high', 'normal', 'low']);
    const directSourceStatuses = new Set(['found', 'not-found', 'not-checked']);
    asArray(session.leads).forEach((lead, index) => {
        for (const field of ['title', 'employer', 'source', 'url', 'roleFamily', 'discoveredAt'])
            requiredString(lead?.[field], `leads[${index}].${field}`, errors);
        if (!leadStatuses.has(lead?.status))
            errors.push(`leads[${index}].status is invalid`);
        if (!leadPriorities.has(lead?.priority))
            errors.push(`leads[${index}].priority is invalid`);
        if (!directSourceStatuses.has(lead?.directSourceStatus))
            errors.push(`leads[${index}].directSourceStatus is invalid`);
        if (typeof lead?.employerExpansionRequired !== 'boolean')
            errors.push(`leads[${index}].employerExpansionRequired must be boolean`);
        requiredString(lead?.employerExpansionReason, `leads[${index}].employerExpansionReason`, errors);
        if (lead?.status !== 'assessed' && !asText(lead?.reason))
            errors.push(`leads[${index}].reason is required when status is ${lead?.status}`);
        if (lead?.status === 'assessed' && !asArray(session.jobs).some((job) => leadMatchesJob(lead, job))) {
            errors.push(`leads[${index}] is assessed but has no matching jobs[] evidence record`);
        }
    });
    if (session.candidate) {
        for (const field of ['targetRoleFamilies', 'locations', 'workArrangements', 'domains', 'qualifications']) {
            validateStringArray(session.candidate[field], `candidate.${field}`, errors);
        }
        if (!Array.isArray(session.candidate.skills))
            errors.push('candidate.skills must be an array');
        if (!Array.isArray(session.candidate.capabilities))
            errors.push('candidate.capabilities must be an array');
        if (!Array.isArray(session.candidate.availabilityWindows))
            errors.push('candidate.availabilityWindows must be an array');
        asArray(session.candidate.availabilityWindows).forEach((window, index) => {
            requiredString(window?.startAt, `candidate.availabilityWindows[${index}].startAt`, errors);
            requiredString(window?.endAt, `candidate.availabilityWindows[${index}].endAt`, errors);
            if (!(Number(window?.maxHoursPerWeek) > 0))
                errors.push(`candidate.availabilityWindows[${index}].maxHoursPerWeek must be positive`);
            for (const field of ['startAt', 'endAt']) {
                if (window?.[field]) {
                    try {
                        parseDate(window[field], `candidate.availabilityWindows[${index}].${field}`);
                    }
                    catch (error) {
                        errors.push(error.message);
                    }
                }
            }
        });
        if (session.candidate.workRights) {
            if (!['temporary', 'unrestricted', 'none'].includes(session.candidate.workRights.status))
                errors.push('candidate.workRights.status is invalid');
            if (typeof session.candidate.workRights.unrestricted !== 'boolean')
                errors.push('candidate.workRights.unrestricted must be boolean');
            if (!['user-explicit', 'resume', 'official-document', 'unknown'].includes(session.candidate.workRights.evidenceSource))
                errors.push('candidate.workRights.evidenceSource is invalid');
            if (session.candidate.workRights.unrestricted === true && session.candidate.workRights.status !== 'unrestricted')
                errors.push('candidate.workRights.unrestricted can be true only when status is unrestricted');
            if (session.candidate.workRights.unrestricted === true && session.candidate.workRights.evidenceSource === 'unknown')
                errors.push('unrestricted work rights require user, resume, or official-document evidence');
        }
        for (const [field, values] of [['skills', session.candidate.skills], ['capabilities', session.candidate.capabilities]]) {
            asArray(values).forEach((item, index) => {
                requiredString(item?.name, `candidate.${field}[${index}].name`, errors);
                if (!Object.hasOwn(LEVEL_WEIGHT, item?.level))
                    errors.push(`candidate.${field}[${index}].level is invalid`);
            });
        }
    }
    asArray(session.jobs).forEach((job, index) => {
        for (const field of ['source', 'title', 'employer', 'sourceUrl', 'location', 'programmeType', 'contractType', 'workload'])
            requiredString(job?.[field], `jobs[${index}].${field}`, errors);
        requiredString(job?.verificationEvidence?.verifiedAt, `jobs[${index}].verificationEvidence.verifiedAt`, errors);
        if (!job?.dateEvidence || typeof job.dateEvidence !== 'object' || Array.isArray(job.dateEvidence))
            errors.push(`jobs[${index}].dateEvidence must be an object`);
        for (const field of ['detailPageOpened', 'applyRouteAvailable', 'expiredIndicatorVisible', 'unavailableIndicatorVisible']) {
            if (typeof job?.verificationEvidence?.[field] !== 'boolean')
                errors.push(`jobs[${index}].verificationEvidence.${field} must be boolean`);
        }
        if (!['internship', 'graduate', 'standard', 'not-stated'].includes(job?.programmeType))
            errors.push(`jobs[${index}].programmeType is invalid`);
        if (!['fixed-term', 'permanent', 'casual', 'contract', 'not-stated'].includes(job?.contractType))
            errors.push(`jobs[${index}].contractType is invalid`);
        if (!['full-time', 'part-time', 'variable', 'not-stated'].includes(job?.workload))
            errors.push(`jobs[${index}].workload is invalid`);
        if (job?.isTechnicalVolunteer !== undefined && typeof job.isTechnicalVolunteer !== 'boolean')
            errors.push(`jobs[${index}].isTechnicalVolunteer must be boolean`);
        if (job?.compensation && !['paid', 'unpaid', 'reimbursed', 'unknown'].includes(job.compensation.kind))
            errors.push(`jobs[${index}].compensation.kind is invalid`);
        validateStringArray(job?.roleFamilies, `jobs[${index}].roleFamilies`, errors, { nonEmpty: true });
        validateStringArray(job?.responsibilityAreas, `jobs[${index}].responsibilityAreas`, errors, { nonEmpty: true });
        validateStringArray(job?.domains, `jobs[${index}].domains`, errors);
        validateStringArray(job?.selectionRisks ?? [], `jobs[${index}].selectionRisks`, errors);
        if (!Array.isArray(job?.technicalRequirements))
            errors.push(`jobs[${index}].technicalRequirements must be an array`);
        asArray(job?.technicalRequirements).forEach((group, groupIndex) => {
            requiredString(group?.label, `jobs[${index}].technicalRequirements[${groupIndex}].label`, errors);
            if (!['required', 'preferred', 'exposure'].includes(group?.strength))
                errors.push(`jobs[${index}].technicalRequirements[${groupIndex}].strength is invalid`);
            if (!['any', 'all'].includes(group?.match))
                errors.push(`jobs[${index}].technicalRequirements[${groupIndex}].match is invalid`);
            validateStringArray(group?.options, `jobs[${index}].technicalRequirements[${groupIndex}].options`, errors, { nonEmpty: true });
            asArray(group?.options).forEach((skill, skillIndex) => {
                if (ELIGIBILITY_REQUIREMENT.test(asText(skill)))
                    errors.push(`jobs[${index}].technicalRequirements[${groupIndex}].options[${skillIndex}] is an eligibility requirement; move it to requirements`);
            });
        });
        if (!Array.isArray(job?.sourceEvidence) || !job.sourceEvidence.length)
            errors.push(`jobs[${index}].sourceEvidence must contain at least one observed source`);
        asArray(job?.sourceEvidence).forEach((source, sourceIndex) => {
            requiredString(source?.name, `jobs[${index}].sourceEvidence[${sourceIndex}].name`, errors);
            requiredString(source?.url, `jobs[${index}].sourceEvidence[${sourceIndex}].url`, errors);
            requiredString(source?.observedAt, `jobs[${index}].sourceEvidence[${sourceIndex}].observedAt`, errors);
            if (source?.observedAt) {
                try {
                    parseDate(source.observedAt, `jobs[${index}].sourceEvidence[${sourceIndex}].observedAt`);
                }
                catch (error) {
                    errors.push(error.message);
                }
            }
            if (!['employer', 'ats', 'job-board', 'aggregator', 'search-result'].includes(source?.kind))
                errors.push(`jobs[${index}].sourceEvidence[${sourceIndex}].kind is invalid`);
            for (const field of ['detailPageOpened', 'applyRouteAvailable', 'expiredIndicatorVisible', 'unavailableIndicatorVisible']) {
                if (typeof source?.[field] !== 'boolean')
                    errors.push(`jobs[${index}].sourceEvidence[${sourceIndex}].${field} must be boolean`);
            }
            for (const field of ['url', 'applicationUrl']) {
                if (!source?.[field])
                    continue;
                try {
                    new URL(source[field]);
                }
                catch {
                    errors.push(`jobs[${index}].sourceEvidence[${sourceIndex}].${field} must be an absolute URL`);
                }
            }
        });
        if (!Array.isArray(job?.requirements))
            errors.push(`jobs[${index}].requirements must be an array`);
        asArray(job?.requirements).forEach((requirement, requirementIndex) => {
            requiredString(requirement?.text, `jobs[${index}].requirements[${requirementIndex}].text`, errors);
            if (!['hard', 'preference'].includes(requirement?.strength))
                errors.push(`jobs[${index}].requirements[${requirementIndex}].strength is invalid`);
            if (!['met', 'not-met', 'unknown'].includes(requirement?.compatibility))
                errors.push(`jobs[${index}].requirements[${requirementIndex}].compatibility is invalid`);
            if (requirement?.evidenceSource !== undefined && !['resume', 'user-explicit', 'official-document', 'unknown'].includes(requirement.evidenceSource))
                errors.push(`jobs[${index}].requirements[${requirementIndex}].evidenceSource is invalid`);
            if (requirement?.compatibility === 'met' && (!requirement?.evidenceSource || requirement.evidenceSource === 'unknown'))
                errors.push(`jobs[${index}].requirements[${requirementIndex}] cannot be met without resume, user-explicit, or official-document evidence`);
        });
        validateDateEvidence(job, index, errors);
    });
    const urlOwners = new Map();
    asArray(session.jobs).forEach((job, index) => {
        for (const rawUrl of [job?.sourceUrl, job?.applicationUrl]) {
            const url = normaliseUrl(rawUrl);
            if (!url)
                continue;
            const owner = urlOwners.get(url);
            if (owner && !sameRole(owner.job, job)) {
                errors.push(`jobs[${index}] reuses ${url} for a different employer/title than jobs[${owner.index}]`);
            }
            else if (!owner)
                urlOwners.set(url, { job, index });
        }
    });
    if (session.candidate?.workRights?.unrestricted !== true) {
        asArray(session.assumptions).forEach((assumption, index) => {
            if (UNSUPPORTED_WORK_RIGHTS_ASSUMPTION.test(asText(assumption)))
                errors.push(`assumptions[${index}] claims unrestricted or post-study work rights without explicit evidence`);
        });
    }
    asArray(session.relatedOpportunities).forEach((item, index) => {
        for (const field of ['kind', 'title', 'organisation', 'url', 'registrationStatus'])
            requiredString(item?.[field], `relatedOpportunities[${index}].${field}`, errors);
        requiredString(item?.verificationEvidence?.verifiedAt, `relatedOpportunities[${index}].verificationEvidence.verifiedAt`, errors);
        for (const field of ['detailPageOpened', 'applyRouteAvailable', 'expiredIndicatorVisible', 'unavailableIndicatorVisible']) {
            if (typeof item?.verificationEvidence?.[field] !== 'boolean')
                errors.push(`relatedOpportunities[${index}].verificationEvidence.${field} must be boolean`);
        }
        if (!['event', 'programme', 'talent-pool', 'recruitment-channel'].includes(item?.kind))
            errors.push(`relatedOpportunities[${index}].kind is invalid`);
        if (!['open', 'closed', 'conditional', 'unknown'].includes(item?.registrationStatus))
            errors.push(`relatedOpportunities[${index}].registrationStatus is invalid`);
    });
    return { valid: errors.length === 0, errors };
}
function phraseTokens(value) { return normalise(value).split(' ').filter((token) => token && !GENERIC_ROLE_TOKENS.has(token)); }
function conceptGroup(value) {
    const text = normalise(value);
    return CONCEPT_GROUPS.findIndex((group) => group.some((term) => text.includes(term)));
}
function semanticSimilarity(left, right) {
    const a = normalise(left);
    const b = normalise(right);
    if (!a || !b)
        return 0;
    if (a === b)
        return 1;
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if ((a.includes(b) || b.includes(a)) && shorter >= 5 && shorter / longer >= 0.6)
        return 0.9;
    const group = conceptGroup(a);
    if (group >= 0 && group === conceptGroup(b))
        return 0.82;
    const aTokens = new Set(phraseTokens(a));
    const bTokens = new Set(phraseTokens(b));
    if (!aTokens.size || !bTokens.size)
        return 0;
    const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
    return intersection / Math.max(aTokens.size, bTokens.size);
}
function skillMatch(requiredSkill, candidateEvidence, nowYear) {
    const match = candidateEvidence
        .map((item) => ({ item, similarity: semanticSimilarity(requiredSkill, item.name) }))
        .filter(({ similarity }) => similarity >= 0.5)
        .sort((a, b) => b.similarity - a.similarity)[0];
    if (!match)
        return undefined;
    const years = Number(match.item.years ?? 0);
    const yearsFactor = years > 0 ? clamp(0.55 + Math.log2(years + 1) * 0.16, 0.55, 1) : 0.65;
    const lastUsed = Number(match.item.lastUsedYear ?? nowYear);
    const recency = lastUsed >= nowYear - 1 ? 1 : lastUsed >= nowYear - 3 ? 0.85 : 0.65;
    return { skill: match.item, score: (LEVEL_WEIGHT[match.item.level] ?? 0) * yearsFactor * recency * match.similarity };
}
function bestSemanticMatch(values, targets) {
    let best = 0;
    for (const value of asArray(values))
        for (const target of asArray(targets))
            best = Math.max(best, semanticSimilarity(value, target));
    return best;
}
export function scoreRoleFit(candidate, job, now = new Date()) {
    const responsibilities = asArray(job.responsibilityAreas);
    const evidenceItems = [...asArray(candidate.skills), ...asArray(candidate.capabilities)];
    const matchAll = (values) => values.map((name) => ({ name, match: skillMatch(name, evidenceItems, now.getFullYear()) }));
    const responsibilityMatches = matchAll(responsibilities);
    const average = (items, fallback = 0) => items.length ? items.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / items.length : fallback;
    const technicalGroups = asArray(job.technicalRequirements).map((group) => {
        const options = matchAll(group.options);
        const optionScores = options.map((item) => item.match?.score ?? 0);
        const score = group.match === 'all'
            ? (optionScores.length ? optionScores.reduce((sum, value) => sum + value, 0) / optionScores.length : 0)
            : Math.max(0, ...optionScores);
        const matched = options.filter((item) => (item.match?.score ?? 0) >= 0.3);
        const met = group.match === 'all' ? matched.length === options.length : matched.length > 0;
        return { ...group, score, options, matched, met };
    });
    const requiredGroups = technicalGroups.filter((group) => group.strength === 'required');
    const preferredGroups = technicalGroups.filter((group) => group.strength !== 'required');
    const requiredScore = requiredGroups.length ? requiredGroups.reduce((sum, group) => sum + group.score, 0) / requiredGroups.length : 0.55;
    const preferredScore = preferredGroups.length ? preferredGroups.reduce((sum, group) => sum + group.score, 0) / preferredGroups.length : requiredScore;
    const responsibilityScore = average(responsibilityMatches, 0.45);
    const familyScore = bestSemanticMatch(job.roleFamilies, candidate.targetRoleFamilies);
    const rawScore = requiredScore * 4 + preferredScore + responsibilityScore * 3.5
        + familyScore + bestSemanticMatch(job.domains, candidate.domains) * 0.5;
    const technicalMatches = technicalGroups.flatMap((group) => group.matched.map((item) => ({ ...item, group })));
    const evidence = [...technicalMatches, ...responsibilityMatches.filter((item) => item.match)]
        .map((item) => `${item.name}: supported by ${item.match.skill.name} (${item.match.skill.level}${item.match.skill.years ? `, ${item.match.skill.years} years` : ''})`);
    const gaps = requiredGroups.filter((group) => !group.met).map((group) => `${group.label}: requires ${group.match === 'all' ? 'all of' : 'one of'} ${group.options.map((item) => item.name).join(', ')}`);
    if (!technicalGroups.length)
        gaps.push('No concrete technical requirements were stated; assessment relies on responsibilities and transferable capabilities');
    const coreDutyValue = responsibilityScore * 0.75 + familyScore * 0.25;
    const coreDutyFit = coreDutyValue >= 0.62 ? 'Strong' : coreDutyValue >= 0.3 ? 'Partial' : 'Low';
    const metRequiredGroups = requiredGroups.filter((group) => group.met).length;
    const requiredTechnology = requiredGroups.length === 0 ? 'Unknown'
        : metRequiredGroups === requiredGroups.length ? 'Met'
            : technicalGroups.some((group) => group.matched.length) ? 'Partially met' : 'Not met';
    const noRequiredSkillMatches = requiredGroups.length > 0 && metRequiredGroups === 0;
    return {
        score: round1(clamp(noRequiredSkillMatches ? Math.min(rawScore, 2.9) : rawScore)),
        coreDutyFit, requiredTechnology,
        technologySummary: { requiredGroups: requiredGroups.length, metRequiredGroups },
        evidence: [...new Set(evidence)], gaps,
    };
}
function scoreCriteriaRole(job, candidate, preferences) {
    const requested = asArray(preferences.constraints).filter((item) => ['keyword', 'roleFamily'].includes(item.field)).map((item) => item.value);
    const targets = [...requested, ...asArray(preferences.keywords), ...asArray(candidate.targetRoleFamilies)];
    const familyScore = bestSemanticMatch([...asArray(job.roleFamilies), job.title], targets);
    const responsibilityScore = bestSemanticMatch(job.responsibilityAreas, targets);
    return {
        score: round1(clamp(familyScore * 7 + responsibilityScore * 3)),
        coreDutyFit: familyScore * 0.7 + responsibilityScore * 0.3 >= 0.62 ? 'Strong' : familyScore > 0 || responsibilityScore > 0 ? 'Partial' : 'Low',
        requiredTechnology: 'Unknown',
        technologySummary: { requiredGroups: 0, metRequiredGroups: 0 },
        evidence: [...(familyScore > 0 ? ['Duty-derived role family matches the requested role criteria'] : []), ...(responsibilityScore > 0 ? ['Advertised responsibilities overlap the requested criteria'] : [])],
        gaps: targets.length && familyScore === 0 ? ['No duty-derived role family matched the requested criteria'] : [],
    };
}
function constraintsFor(preferences, field) { return asArray(preferences.constraints).filter((item) => item.field === field); }
function legacyConstraints(preferences, field, values) {
    const explicit = constraintsFor(preferences, field);
    return explicit.length ? explicit : asArray(values).map((value) => ({ field, value, strength: 'hard', source: 'user-explicit' }));
}
function valueMatches(actual, expected) {
    const left = normalise(actual);
    const right = normalise(expected);
    return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}
function evaluateConstraint(actual, constraints, label, blockers, cautions, positives) {
    if (!constraints.length)
        return 0;
    if (!actual) {
        cautions.push(`${label} is not stated`);
        return 0.25;
    }
    if (constraints.some((item) => valueMatches(actual, item.value))) {
        positives.push(`${label}: ${actual}`);
        return 1;
    }
    const hard = constraints.filter((item) => item.strength === 'hard');
    if (hard.length)
        blockers.push(`${label} ${actual} is outside the hard preference: ${hard.map((item) => item.value).join(', ')}`);
    else
        cautions.push(`${label} ${actual} differs from the soft preference: ${constraints.map((item) => item.value).join(', ')}`);
    return 0;
}
function resolvedJobDates(job) {
    return Object.fromEntries(['postedAt', 'closesAt', 'startAt', 'endAt'].map((field) => [field, resolveDateEvidence(job, field)]));
}
function evaluateAvailability(job, candidate, dates) {
    const windows = asArray(candidate.availabilityWindows);
    const hours = Number(job.hoursPerWeek ?? 0);
    if (!windows.length)
        return { status: 'unknown', reason: 'No candidate availability windows were recorded' };
    if (!dates.startAt.value || !dates.endAt.value)
        return { status: 'unknown', reason: 'Job start/end dates were not both verified' };
    const start = parseDate(dates.startAt.value, 'startAt');
    const end = parseDate(dates.endAt.value, 'endAt');
    for (const window of windows) {
        const windowStart = parseDate(window.startAt, 'availabilityWindows.startAt');
        const windowEnd = parseDate(window.endAt, 'availabilityWindows.endAt');
        if (start >= windowStart && end <= windowEnd && (!hours || hours <= Number(window.maxHoursPerWeek))) {
            return { status: 'compatible', reason: `Fits availability window ${window.startAt} to ${window.endAt} at up to ${window.maxHoursPerWeek} hours/week` };
        }
    }
    return { status: 'incompatible', reason: 'Job dates or hours do not fit any recorded availability window' };
}
function evaluateWorkRights(job, candidate, dates) {
    const rights = candidate.workRights;
    const requirement = job.workRightsRequirement;
    if (!requirement)
        return { status: 'unknown', reason: 'No explicit work-right requirement was recorded' };
    if (!rights || typeof rights !== 'object')
        return { status: 'unknown', reason: 'Candidate work-right details are not structured' };
    if (requirement.country && rights.country && !valueMatches(requirement.country, rights.country))
        return { status: 'incompatible', reason: `Work rights are for ${rights.country}, not ${requirement.country}` };
    if (requirement.requiresUnrestricted === true && rights.unrestricted !== true)
        return { status: 'incompatible', reason: 'The role requires unrestricted work rights' };
    if (requirement.requiresCurrentRights === true && rights.status === 'none')
        return { status: 'incompatible', reason: 'The role requires current local work rights' };
    if (rights.validUntil && dates.endAt.value && parseDate(rights.validUntil, 'workRights.validUntil') < parseDate(dates.endAt.value, 'endAt'))
        return { status: 'incompatible', reason: 'Current work rights expire before the job ends' };
    if (['temporary', 'unrestricted'].includes(rights.status))
        return { status: 'compatible', reason: 'Recorded work rights satisfy the stated requirement for the verified job period' };
    return { status: 'unknown', reason: 'Work-right compatibility could not be determined' };
}
export function scorePracticalFit(candidate, preferences, job) {
    const blockers = [];
    const positives = [];
    const cautions = [];
    const eligibilityFailures = [];
    const eligibilityUnknowns = [];
    let score = 0;
    const volunteerRequested = preferences.includeTechnicalVolunteer === true
        || constraintsFor(preferences, 'engagementModel').some((item) => normalise(item.value) === 'volunteer');
    const volunteerRole = normalise(job.engagementModel) === 'volunteer' || job.isTechnicalVolunteer === true;
    if (volunteerRole) {
        if (!volunteerRequested)
            blockers.push('Technical volunteer work was not requested for this search');
        else if (job.isTechnicalVolunteer !== true)
            blockers.push('Volunteer role is not evidenced as having explicit technical software work');
        else {
            positives.push('Explicitly requested technical volunteer role');
            score += 0.75;
        }
    }
    else if (job.engagementModel && normalise(job.engagementModel) !== 'employee') {
        blockers.push(`Engagement model is ${job.engagementModel}, not employee employment`);
    }
    const excludedCoreSkills = constraintsFor(preferences, 'excludeCoreSkill').filter((item) => item.strength === 'hard');
    for (const group of asArray(job.technicalRequirements).filter((item) => item.strength === 'required')) {
        const conflicts = asArray(group.options).filter((option) => excludedCoreSkills.some((item) => semanticSimilarity(option, item.value) >= 0.8));
        const blocked = group.match === 'all' ? conflicts.length > 0 : conflicts.length === asArray(group.options).length;
        if (blocked)
            blockers.push(`Required technology group ${group.label} conflicts with an explicit core-technology exclusion: ${conflicts.join(', ')}`);
    }
    score += evaluateConstraint(job.programmeType, legacyConstraints(preferences, 'programmeType', preferences.programmeTypes ?? preferences.employmentTypes), 'Programme type', blockers, cautions, positives) * 1.5;
    score += evaluateConstraint(job.contractType, legacyConstraints(preferences, 'contractType', preferences.contractTypes), 'Contract type', blockers, cautions, positives) * 0.75;
    score += evaluateConstraint(job.workload, legacyConstraints(preferences, 'workload', preferences.workloads), 'Workload', blockers, cautions, positives) * 0.75;
    const remote = normalise(job.workArrangement) === 'remote';
    if (remote) {
        positives.push('Fully remote');
        score += 1.5;
    }
    else
        score += evaluateConstraint(job.location, legacyConstraints(preferences, 'location', preferences.locations ?? candidate.locations), 'Location', blockers, cautions, positives) * 1.5;
    score += evaluateConstraint(job.workArrangement, legacyConstraints(preferences, 'workArrangement', preferences.workArrangements ?? candidate.workArrangements), 'Work arrangement', blockers, cautions, positives) * 0.5;
    const dates = resolvedJobDates(job);
    const availability = evaluateAvailability(job, candidate, dates);
    if (availability.status === 'compatible') {
        positives.push(availability.reason);
        score += 2;
    }
    else if (availability.status === 'incompatible') {
        blockers.push(availability.reason);
        eligibilityFailures.push(availability.reason);
    }
    else {
        cautions.push(availability.reason);
        eligibilityUnknowns.push(availability.reason);
        score += 0.5;
    }
    const workRights = evaluateWorkRights(job, candidate, dates);
    if (workRights.status === 'compatible') {
        positives.push(workRights.reason);
        score += 2;
    }
    else if (workRights.status === 'incompatible') {
        blockers.push(workRights.reason);
        eligibilityFailures.push(workRights.reason);
    }
    else {
        cautions.push(workRights.reason);
        eligibilityUnknowns.push(workRights.reason);
        score += 0.5;
    }
    const requirements = asArray(job.requirements);
    if (!requirements.length) {
        cautions.push('No explicit non-technical eligibility requirements were recorded');
        eligibilityUnknowns.push('No explicit non-technical eligibility requirements were recorded');
        score += 0.5;
    }
    else {
        const hard = requirements.filter((item) => item.strength === 'hard');
        const failed = hard.filter((item) => item.compatibility === 'not-met');
        const unknown = hard.filter((item) => item.compatibility === 'unknown');
        const met = hard.filter((item) => item.compatibility === 'met');
        failed.forEach((item) => { const message = `Hard requirement not met: ${item.text}`; blockers.push(message); eligibilityFailures.push(message); });
        unknown.forEach((item) => { const message = `Hard requirement not verified: ${item.text}`; cautions.push(message); eligibilityUnknowns.push(message); });
        requirements.filter((item) => item.strength === 'preference' && item.compatibility !== 'met').forEach((item) => cautions.push(`Selection preference: ${item.text}`));
        if (hard.length && met.length === hard.length) {
            positives.push('All recorded hard eligibility requirements appear met');
            score += 1;
        }
        else if (met.length)
            score += 0.5;
    }
    for (const risk of asArray(job.selectionRisks))
        cautions.push(risk);
    score -= Math.min(2, asArray(job.selectionRisks).length * 0.5);
    const eligibility = eligibilityFailures.length ? 'Not met' : eligibilityUnknowns.length ? 'Unknown' : 'Met';
    return { score: round1(clamp(score)), eligibility, blockers: [...new Set(blockers)], positives: [...new Set(positives)], cautions: [...new Set(cautions)] };
}
export function classifyVerification(job, preferences, now = new Date()) {
    job = canonicaliseJobEvidence(job);
    const reasons = [];
    let status = 'verified-active';
    let hostname = '';
    try {
        hostname = new URL(job.sourceUrl).hostname.toLowerCase();
    }
    catch {
        status = 'rejected';
        reasons.push('Source URL is invalid');
    }
    let applicationHostname = '';
    try {
        applicationHostname = new URL(job.applicationUrl || job.sourceUrl).hostname.toLowerCase();
    }
    catch { /* Source URL validation above supplies the user-facing error. */ }
    if (BLOCKED_AGGREGATORS.some((domain) => hostname.includes(domain) || applicationHostname.includes(domain))) {
        status = 'rejected';
        reasons.push('Final link is an aggregator rather than a permitted direct vacancy page');
    }
    if (DISCOVERY_ONLY_HOSTS.some((domain) => applicationHostname.includes(domain))) {
        status = 'unverified';
        reasons.push('The final application route is a discovery job board rather than a public employer or ATS vacancy page');
    }
    const evidence = job.verificationEvidence ?? {};
    if (evidence.expiredIndicatorVisible) {
        status = 'closed';
        reasons.push('The page visibly says the vacancy is expired or closed');
    }
    if (evidence.unavailableIndicatorVisible) {
        status = 'unavailable';
        reasons.push('The page visibly says the vacancy is removed or unavailable');
    }
    if (!evidence.detailPageOpened && status === 'verified-active') {
        status = 'unverified';
        reasons.push('The exact job detail page was not directly opened');
    }
    if (!evidence.applyRouteAvailable && status === 'verified-active') {
        status = 'unverified';
        reasons.push('No working application route or current application instructions were verified');
    }
    const dates = resolvedJobDates(job);
    const conflicts = Object.entries(dates).filter(([, result]) => result.conflict);
    if (conflicts.length && status === 'verified-active') {
        status = 'unverified';
        conflicts.forEach(([field, result]) => reasons.push(`${field} has conflicting evidence: ${result.conflictingValues.join(' vs ')}`));
    }
    if (dates.closesAt.value && closingHasPassed(dates.closesAt.value, now)) {
        status = 'closed';
        reasons.push(`Closing date ${dates.closesAt.value} has passed`);
    }
    const maxAge = Number(preferences.maxPostingAgeDays ?? 30);
    if (!dates.postedAt.value) {
        if (status === 'verified-active')
            status = 'unverified';
        reasons.push('Posting date is unavailable or conflicting');
    }
    else {
        const age = postingAgeDays(dates.postedAt.value, now);
        if (age > maxAge) {
            status = 'rejected';
            reasons.push(`Posted ${age} days ago, outside the ${maxAge}-day window`);
        }
        if (age < -1 && status === 'verified-active') {
            status = 'unverified';
            reasons.push('Posting date is in the future');
        }
    }
    return { status, reasons: [...new Set(reasons)], dates };
}
function evidenceStrength(job) {
    const evidence = job.verificationEvidence ?? {};
    return sourceEvidenceRank(bestSourceEvidence(job)) * 10
        + Number(Boolean(evidence.detailPageOpened)) * 2 + Number(Boolean(evidence.applyRouteAvailable)) * 2
        + Number(Boolean(job.applicationUrl)) + Number(Boolean(job.requisitionId))
        + Object.values(job.dateEvidence ?? {}).flatMap(asArray).filter((entry) => ['employer', 'ats'].includes(entry.sourceType)).length;
}
function mergeUnique(items, key) {
    const seen = new Set();
    return items.filter((item) => {
        const identity = key(item);
        if (seen.has(identity))
            return false;
        seen.add(identity);
        return true;
    });
}
function mergeJobs(left, right) {
    const preferred = evidenceStrength(right) > evidenceStrength(left) ? right : left;
    const secondary = preferred === right ? left : right;
    const dateEvidence = {};
    for (const field of ['postedAt', 'closesAt', 'startAt', 'endAt']) {
        dateEvidence[field] = mergeUnique([
            ...asArray(preferred.dateEvidence?.[field]), ...asArray(secondary.dateEvidence?.[field]),
        ], (entry) => `${entry.value}|${normaliseUrl(entry.sourceUrl)}|${entry.sourceType}`);
    }
    return canonicaliseJobEvidence({
        ...preferred,
        sourceEvidence: mergeUnique([
            ...asArray(preferred.sourceEvidence), ...asArray(secondary.sourceEvidence),
        ], (entry) => `${entry.kind}|${normaliseUrl(entry.url)}`),
        dateEvidence,
    });
}
function deduplicate(jobs) {
    const retained = [];
    const duplicates = [];
    for (const rawJob of jobs) {
        const job = canonicaliseJobEvidence(rawJob);
        const keys = new Set(jobIdentityKeys(job));
        const previousIndex = retained.findIndex((candidate) => jobIdentityKeys(candidate).some((key) => keys.has(key)));
        if (previousIndex < 0) {
            retained.push(job);
            continue;
        }
        const previous = retained[previousIndex];
        duplicates.push({ ...(evidenceStrength(job) > evidenceStrength(previous) ? previous : job), duplicateOf: job.title });
        retained[previousIndex] = mergeJobs(previous, job);
    }
    return { unique: retained, duplicates };
}
function classifyRelatedOpportunity(item) {
    const evidence = item.verificationEvidence ?? {};
    if (evidence.expiredIndicatorVisible || evidence.unavailableIndicatorVisible || item.registrationStatus === 'closed')
        return 'closed';
    if (!evidence.detailPageOpened)
        return 'unverified';
    if (item.registrationStatus === 'open')
        return 'verified-open';
    if (item.registrationStatus === 'conditional')
        return 'conditional';
    return 'unverified';
}
function assessmentState(job) {
    return fingerprint({
        status: job.verification.status, reasons: job.verification.reasons, sourceUrl: normaliseUrl(job.sourceUrl),
        applicationUrl: normaliseUrl(job.applicationUrl), requisitionId: job.requisitionId,
        dates: Object.fromEntries(Object.entries(job.verification.dates).map(([field, value]) => [field, { value: value.value, conflict: value.conflict }])),
        programmeType: job.programmeType, contractType: job.contractType, workload: job.workload, engagementModel: job.engagementModel,
        technicalVolunteer: job.isTechnicalVolunteer, compensation: job.compensation, requirements: job.requirements,
        technicalRequirements: job.technicalRequirements,
        strongestSourceKind: bestSourceEvidence(job)?.kind,
    });
}
function recommendationFor(job, mode) {
    if (job.verification.status !== 'verified-active')
        return 'Skip';
    if (job.practicalFit.blockers.length || job.practicalFit.eligibility === 'Not met')
        return 'Skip';
    if (job.roleFit.coreDutyFit === 'Low' || job.roleFit.requiredTechnology === 'Not met')
        return 'Skip';
    if (mode === 'criteria')
        return job.roleFit.coreDutyFit === 'Strong' ? 'Apply' : 'Consider';
    if (job.roleFit.coreDutyFit === 'Strong' && job.roleFit.requiredTechnology === 'Met' && job.practicalFit.eligibility !== 'Unknown')
        return 'Apply';
    return 'Consider';
}
export function buildReport(session, options = {}) {
    const validation = validateSession(session);
    if (!validation.valid)
        throw new Error(`Invalid session:\n- ${validation.errors.join('\n- ')}`);
    const now = options.now ? new Date(options.now) : new Date();
    const scanContext = deriveScanContext(session);
    const coverage = deriveSearchCoverage(session.searchCoverage, session.leads);
    const { unique, duplicates } = deduplicate(session.jobs);
    const evaluated = unique.map((job) => {
        const verification = classifyVerification(job, session.preferences, now);
        const canonicalJob = canonicaliseJobEvidence(job);
        const result = {
            ...canonicalJob,
            sourceUrl: normaliseUrl(canonicalJob.sourceUrl), applicationUrl: normaliseUrl(canonicalJob.applicationUrl), verification,
            roleFit: session.preferences.mode === 'criteria' ? scoreCriteriaRole(canonicalJob, session.candidate, session.preferences) : scoreRoleFit(session.candidate, canonicalJob, now),
            practicalFit: scorePracticalFit(session.candidate, session.preferences, canonicalJob),
        };
        result.recommendation = recommendationFor(result, session.preferences.mode);
        result.stateFingerprint = assessmentState(result);
        return result;
    });
    for (const job of duplicates) {
        const result = {
            ...job,
            sourceUrl: normaliseUrl(job.sourceUrl), applicationUrl: normaliseUrl(job.applicationUrl),
            verification: { status: 'rejected', reasons: [`Duplicate of retained listing: ${job.duplicateOf}`], dates: resolvedJobDates(job) },
            roleFit: session.preferences.mode === 'criteria' ? scoreCriteriaRole(job, session.candidate, session.preferences) : scoreRoleFit(session.candidate, job, now),
            practicalFit: scorePracticalFit(session.candidate, session.preferences, job),
        };
        result.recommendation = 'Skip';
        result.stateFingerprint = assessmentState(result);
        evaluated.push(result);
    }
    const noBlockers = (job) => job.practicalFit.blockers.length === 0;
    const verifiedEligible = evaluated.filter((job) => job.verification.status === 'verified-active' && noBlockers(job));
    const recommended = verifiedEligible.filter((job) => job.recommendation === 'Apply');
    const stretch = verifiedEligible.filter((job) => job.recommendation === 'Consider');
    const manualVerification = evaluated.filter((job) => session.preferences.includeUnverified !== false
        && job.verification.status === 'unverified' && noBlockers(job)
        && job.roleFit.coreDutyFit !== 'Low' && job.roleFit.requiredTechnology !== 'Not met');
    const closed = evaluated.filter((job) => ['closed', 'unavailable'].includes(job.verification.status));
    const incompatible = evaluated.filter((job) => job.verification.status === 'verified-active' && job.practicalFit.blockers.length > 0);
    const lowFit = evaluated.filter((job) => job.verification.status === 'verified-active' && noBlockers(job) && job.recommendation === 'Skip');
    const classified = new Set([...recommended, ...stretch, ...manualVerification, ...closed, ...incompatible, ...lowFit]);
    const otherUnverified = evaluated.filter((job) => !classified.has(job));
    const sortFit = (a, b) => (b.roleFit.score + b.practicalFit.score) - (a.roleFit.score + a.practicalFit.score);
    [recommended, stretch, manualVerification].forEach((items) => items.sort(sortFit));
    const unresolvedHighValueLeads = asArray(session.leads).filter((lead) => lead.priority === 'high' && ['blocked', 'not-opened'].includes(lead.status));
    const relatedOpportunities = asArray(session.relatedOpportunities).map((item) => ({
        ...item, url: normaliseUrl(item.url), status: classifyRelatedOpportunity(item),
        stateFingerprint: fingerprint({
            registrationStatus: item.registrationStatus, startsAt: item.startsAt, endsAt: item.endsAt,
            conditions: item.conditions, detailPageOpened: item.verificationEvidence?.detailPageOpened,
            applyRouteAvailable: item.verificationEvidence?.applyRouteAvailable,
            expiredIndicatorVisible: item.verificationEvidence?.expiredIndicatorVisible,
            unavailableIndicatorVisible: item.verificationEvidence?.unavailableIndicatorVisible,
        }),
    }));
    return {
        pluginVersion: session.pluginVersion, sessionSchemaVersion: session.sessionSchemaVersion,
        scanContext,
        generatedAt: now.toISOString(), candidate: session.candidate, preferences: session.preferences,
        searchCoverage: coverage, assumptions: asArray(session.assumptions), leads: asArray(session.leads),
        searchedCount: options.searchedCount ?? session.jobs.length,
        excludedByProjectState: options.excludedByProjectState ?? 0,
        excludedPreviouslyReported: options.excludedPreviouslyReported ?? 0,
        updatedListingsCount: options.updatedListingsCount ?? session.jobs.filter((job) => job.historyChange === 'updated').length,
        recommended, stretch, manualVerification, unresolvedHighValueLeads, closed, incompatible, lowFit, otherUnverified, relatedOpportunities,
        rejected: [...closed, ...incompatible, ...lowFit, ...otherUnverified],
    };
}
function escapeCell(value) { return asText(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function bulletList(values, fallback = 'None recorded') { return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${fallback}`; }
function formatAucklandTime(value) {
    return `${new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'long', timeZone: 'Pacific/Auckland' }).format(new Date(value))} (Pacific/Auckland)`;
}
function dateSummary(job) { return `Posted: ${job.verification.dates.postedAt.value ?? 'not verified'}; closes: ${job.verification.dates.closesAt.value ?? 'not verified'}`; }
function jobMarker(job) { return `<!-- nz-job-scout:item ${JSON.stringify({ kind: 'job', identities: jobIdentityKeys(job), fingerprint: job.stateFingerprint, status: job.verification.status })} -->`; }
function opportunityMarker(item) { return `<!-- nz-job-scout:item ${JSON.stringify({ kind: 'opportunity', identities: opportunityIdentityKeys(item), fingerprint: item.stateFingerprint, status: item.status })} -->`; }
function leadBreakdown(leads) {
    const counts = new Map();
    for (const lead of leads)
        counts.set(lead.status, (counts.get(lead.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, count]) => `${status}: ${count}`).join(', ') || 'none';
}
function sourceCoverage(attempts) {
    const grouped = new Map();
    for (const attempt of attempts) {
        const previous = grouped.get(attempt.source) ?? { statuses: new Set(), notes: [] };
        previous.statuses.add(attempt.status);
        if (attempt.note)
            previous.notes.push(attempt.note);
        grouped.set(attempt.source, previous);
    }
    return [...grouped.entries()].map(([source, value]) => `- ${source} — ${[...value.statuses].join(', ')}${value.notes.length ? `: ${[...new Set(value.notes)].join('; ')}` : ''}`);
}
function renderJobDetails(job, heading) {
    return [
        `${heading}${job.historyChange === 'updated' ? ' — Updated evidence' : ''}`, '',
        `- Programme: ${job.programmeType}; contract: ${job.contractType}; workload: ${job.workload}; ${job.engagementModel ?? 'engagement model not stated'}${job.isTechnicalVolunteer ? ' (technical volunteer)' : ''}`,
        `- Compensation: ${job.compensation ? `${job.compensation.kind}${job.compensation.detail ? ` — ${job.compensation.detail}` : ''}` : 'not stated'}`,
        `- ${dateSummary(job)}`, `- Verified: ${job.verificationEvidence.verifiedAt}`,
        `- Primary evidence: ${bestSourceEvidence(job)?.kind ?? 'unknown'}; observed sources: ${asArray(job.sourceEvidence).map((item) => `${item.name} (${item.kind})`).join(', ')}`,
        `- Recommendation: ${job.recommendation}`, `- Core duty fit: ${job.roleFit.coreDutyFit}`,
        `- Required technology: ${job.roleFit.requiredTechnology}`, `- Eligibility: ${job.practicalFit.eligibility}`,
        `- Link: ${job.applicationUrl || job.sourceUrl}`, '',
        '**Evidence of fit**', '', bulletList(job.roleFit.evidence), '',
        '**Technical gaps / cautions**', '', bulletList(job.roleFit.gaps), '',
        '**Practical-fit evidence**', '', bulletList(job.practicalFit.positives), '',
        '**Practical cautions**', '', bulletList(job.practicalFit.cautions), '',
    ];
}
function table(items, fitLabel = 'Role fit') {
    if (!items.length)
        return [];
    return [
        `| Role | Company | Location / arrangement | Engagement / pay | Recommendation | ${fitLabel} | Required technology | Eligibility | Direct link |`, '|---|---|---|---|---|---|---|---|---|',
        ...items.map((job) => {
            const engagement = job.isTechnicalVolunteer ? 'Volunteer' : (job.engagementModel ?? 'Not stated');
            const pay = job.compensation?.kind ?? 'not stated';
            return `| ${escapeCell(job.title)} | ${escapeCell(job.employer)} | ${escapeCell(`${job.location} / ${job.workArrangement ?? '-'}`)} | ${escapeCell(`${engagement} / ${pay}`)} | ${job.recommendation} | ${job.roleFit.coreDutyFit} | ${job.roleFit.requiredTechnology} | ${job.practicalFit.eligibility} | [Open listing](${job.applicationUrl || job.sourceUrl}) |`;
        }), '',
    ];
}
export function renderMarkdown(report) {
    const coverage = report.searchCoverage;
    const criteriaOnly = report.preferences.mode === 'criteria';
    const fitLabel = criteriaOnly ? 'Criteria fit' : 'Role fit';
    const lines = [
        '# New Zealand Job Scout Report', '', `Generated: ${formatAucklandTime(report.generatedAt)}`,
        `Plugin version: ${report.pluginVersion}`, `Session schema: ${report.sessionSchemaVersion}`, '',
        `<!-- nz-job-scout:context ${JSON.stringify(report.scanContext)} -->`, '',
        '## Search criteria', '', `- Mode: ${report.preferences.mode}`, `- Posting age: ${report.preferences.maxPostingAgeDays ?? 30} days`,
        `- Leads discovered: ${coverage.leadsDiscovered}`, `- Detail pages opened: ${coverage.detailPagesOpened}`,
        `- Listings assessed with evidence: ${report.searchedCount}`, `- Search families: ${coverage.searchFamilies.join(', ')}`,
        `- Queries run: ${coverage.queriesRun}`, `- Lead outcomes: ${leadBreakdown(report.leads)}`,
        `- Persistently excluded roles/leads: ${report.excludedByProjectState ?? 0}`,
        `- Previously reported unchanged listings excluded: ${report.excludedPreviouslyReported}`,
        `- Listings with changed evidence included: ${report.updatedListingsCount}`, `- Search coverage: ${coverage.status}`, '',
        '### Search attempts', '', '| Role family | Strategy | Source | Status | Query | Leads | Detail pages |', '|---|---|---|---|---|---:|---:|',
        ...coverage.attempts.map((attempt) => `| ${escapeCell(attempt.roleFamily)} | ${attempt.strategy} | ${escapeCell(attempt.source)} | ${attempt.status} | ${escapeCell(attempt.query)} | ${Number(attempt.leadsDiscovered ?? 0)} | ${Number(attempt.detailPagesOpened ?? 0)} |`), '',
        '### Discovery-plan gaps', '',
        `- Families missing broad discovery: ${coverage.missingBroadDiscoveryFamilies.join(', ') || 'none'}`,
        `- Families missing source inventory: ${coverage.missingSourceInventoryFamilies.join(', ') || 'none'}`,
        `- Employers awaiting expansion: ${coverage.unexpandedEmployers.join(', ') || 'none'}`, '',
        `- Planned sources not completed: ${coverage.missingRequiredSourceTargets.join(', ') || 'none'}`, '',
        `- Explicit families omitted: ${coverage.missingExplicitFamilies.join(', ') || 'none'}`,
        `- Programme-first discovery missing: ${coverage.missingProgrammeDiscovery ? 'yes' : 'no'}`,
        `- Programme inventory missing: ${coverage.missingProgrammeInventory ? 'yes' : 'no'}`, '',
        ...(coverage.sourceTargets.length ? ['### Planned public sources', '', '| Source | Purpose / scope | Employer | Status | Items inspected | Note |', '|---|---|---|---|---|---:|---|', ...coverage.sourceTargets.map((target) => `| [${escapeCell(target.name)}](${target.url}) | ${target.purpose} / ${target.inventoryScope} | ${escapeCell(target.employer ?? '-')} | ${target.status} | ${Number(target.itemsInspected ?? 0)} | ${escapeCell(target.note ?? '')} |`), ''] : []),
        '### Source coverage', '', ...sourceCoverage(coverage.attempts), '', '### Assumptions', '', bulletList(report.assumptions), '', '## Verified recommendations', '',
    ];
    if (coverage.status !== 'complete')
        lines.push('> Search coverage was incomplete. Results describe only the public sources accessible in this run; additional suitable vacancies may exist.', '');
    if (!report.recommended.length)
        lines.push(coverage.status === 'complete' ? 'Today there are no new qualified vacancies.' : 'No qualified roles were verified among accessible sources; this is not evidence that no suitable vacancies exist.', '');
    else {
        lines.push(...table(report.recommended, fitLabel));
        report.recommended.forEach((job, index) => lines.push(...renderJobDetails(job, `### ${index + 1}. ${job.title} — ${job.employer}`)));
    }
    if (report.stretch.length) {
        lines.push('## Verified stretch roles', '', '> These roles are practically possible but align less strongly with sustained day-to-day experience.', '', ...table(report.stretch, fitLabel));
        report.stretch.forEach((job, index) => lines.push(...renderJobDetails(job, `### Stretch ${index + 1}. ${job.title} — ${job.employer}`)));
    }
    lines.push('## High-value leads requiring manual verification', '');
    if (!report.manualVerification.length && !report.unresolvedHighValueLeads.length)
        lines.push('- None', '');
    else {
        lines.push('> These leads match the requested profile, but the exact public detail page, application route, posting date, or conflicting evidence prevented verification. They are not counted as recommendations.', '');
        for (const job of report.manualVerification)
            lines.push(`- **${job.title} — ${job.employer}** (core duties ${job.roleFit.coreDutyFit}; required technology ${job.roleFit.requiredTechnology}; eligibility ${job.practicalFit.eligibility}): ${job.verification.reasons.join('; ')}. [Discovery source](${job.sourceUrl})`);
        for (const lead of report.unresolvedHighValueLeads)
            lines.push(`- **${lead.title} — ${lead.employer}** (unresolved ${lead.status}; primary source ${lead.directSourceStatus}): ${lead.reason}. [Discovery source](${lead.url})`);
        lines.push('');
    }
    for (const [heading, items] of [
        ['Verified closed or unavailable', report.closed], ['Practically incompatible roles', report.incompatible],
        ['Verified low-fit roles', report.lowFit], ['Other rejected or unverified', report.otherUnverified],
    ]) {
        lines.push(`## ${heading}`, '');
        if (!items.length)
            lines.push('- None', '');
        else {
            for (const job of items) {
                const reasons = [...job.verification.reasons, ...job.practicalFit.blockers, ...(job.roleFit.coreDutyFit === 'Low' ? ['Core day-to-day duties have low overlap with the candidate evidence'] : []), ...(job.roleFit.requiredTechnology === 'Not met' ? ['No required technology group is supported by candidate evidence'] : [])];
                lines.push(`- **${job.title} — ${job.employer}** (${job.verification.status}): ${[...new Set(reasons)].join('; ') || 'Not recommended after ranking'}. [Source](${job.sourceUrl})`);
            }
            lines.push('');
        }
    }
    lines.push('## Related opportunities and recruitment channels', '');
    if (!report.relatedOpportunities.length)
        lines.push('- None', '');
    else {
        lines.push('> Events, talent pools, recruitment programmes, and networking channels are listed separately and never counted as job recommendations.', '');
        for (const item of report.relatedOpportunities)
            lines.push(`- **${item.title} — ${item.organisation}** (${item.kind}; ${item.status}): ${item.audience ?? 'Audience not stated'}${item.conditions ? `; ${item.conditions}` : ''}. [Official information](${item.url})`);
        lines.push('');
    }
    lines.push(criteriaOnly ? '## Criteria evidence for the strongest roles' : '## CV emphasis for the strongest roles', '');
    const ranked = [...report.recommended, ...report.stretch];
    const emphasis = [...new Set(ranked.flatMap((job) => job.roleFit.evidence))].slice(0, 8);
    lines.push(bulletList(emphasis, ranked.length ? 'No defensible role-specific emphasis was captured.' : 'No verified roles were available, so no role-specific emphasis is suggested.'), '');
    lines.push('<!-- NZ Job Scout state metadata: used only for status-aware incremental reports -->');
    for (const job of [...report.recommended, ...report.stretch, ...report.manualVerification, ...report.closed, ...report.incompatible, ...report.lowFit, ...report.otherUnverified])
        lines.push(jobMarker(job));
    for (const item of report.relatedOpportunities)
        lines.push(opportunityMarker(item));
    return `${lines.join('\n')}\n`;
}
export function renderIncrementalMarkdown(report) {
    const rendered = renderMarkdown(report).trimEnd().split('\n');
    const start = rendered.findIndex((line) => line === '## Search criteria');
    const body = rendered.slice(start >= 0 ? start : 0).map((line) => line.startsWith('### ') ? `#### ${line.slice(4)}` : line.startsWith('## ') ? `### ${line.slice(3)}` : line);
    return ['---', '', `## Incremental scan — ${formatAucklandTime(report.generatedAt)}`, '', ...body, ''].join('\n');
}
export function extractReportHistory(markdown) {
    const states = new Map();
    const legacyIdentities = new Set();
    for (const match of markdown.matchAll(ITEM_MARKER)) {
        try {
            const item = JSON.parse(match[1]);
            for (const identity of asArray(item.identities)) {
                const records = states.get(identity) ?? new Set();
                records.add(item.fingerprint);
                states.set(identity, records);
            }
        }
        catch { /* ignore manually damaged hidden metadata */ }
    }
    if (!states.size) {
        for (const match of markdown.matchAll(/\((https?:\/\/[^)\s]+)\)/g))
            legacyIdentities.add(`url:${normaliseUrl(match[1])}`);
        for (const line of markdown.split('\n')) {
            if (!line.startsWith('|') || /^\|\s*-+/.test(line))
                continue;
            const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
            if (cells.length >= 3 && normalise(cells[0]) !== 'role')
                legacyIdentities.add(`role:${normalise(cells[1])}|${normalise(cells[0])}|${normalise(cells[2].split(' / ')[0])}`);
        }
    }
    return { states, legacyIdentities, context: parseContextMarker(markdown) };
}
async function readTextIfPresent(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function exclusionMatchesItem(record, item) {
    if (normalise(record?.employer) !== normalise(item?.employer))
        return false;
    if (record?.url && [normaliseUrl(item?.url), normaliseUrl(item?.sourceUrl), normaliseUrl(item?.applicationUrl)].includes(normaliseUrl(record.url)))
        return true;
    if (record?.requisitionId && normalise(record.requisitionId) === normalise(item?.requisitionId))
        return true;
    if (record?.title && normalise(record.title) === normalise(item?.title))
        return true;
    return false;
}
async function loadProjectState(inputPath) {
    const path = join(dirname(resolve(inputPath)), STATE_FILE_NAME);
    const raw = await readTextIfPresent(path);
    if (raw === undefined)
        return { path, schemaVersion: 1, excludedRoles: [] };
    let state;
    try {
        state = JSON.parse(raw);
    }
    catch {
        throw new Error(`${STATE_FILE_NAME} is not valid JSON`);
    }
    if (state?.schemaVersion !== 1 || !Array.isArray(state?.excludedRoles))
        throw new Error(`${STATE_FILE_NAME} must use schemaVersion 1 and an excludedRoles array`);
    const decisions = new Set(['applied', 'rejected', 'not-interested', 'closed']);
    state.excludedRoles.forEach((record, index) => {
        if (!asText(record?.employer))
            throw new Error(`${STATE_FILE_NAME} excludedRoles[${index}].employer is required`);
        if (![record?.title, record?.requisitionId, record?.url].some((value) => asText(value)))
            throw new Error(`${STATE_FILE_NAME} excludedRoles[${index}] needs title, requisitionId, or url`);
        if (!decisions.has(record?.decision))
            throw new Error(`${STATE_FILE_NAME} excludedRoles[${index}].decision is invalid`);
        if (!asText(record?.decidedAt))
            throw new Error(`${STATE_FILE_NAME} excludedRoles[${index}].decidedAt is required`);
    });
    return { path, ...state };
}
function applyProjectExclusions(session, state) {
    const records = asArray(state?.excludedRoles);
    const removedJobs = asArray(session.jobs).filter((job) => records.some((record) => exclusionMatchesItem(record, job)));
    const jobs = asArray(session.jobs).filter((job) => !removedJobs.includes(job));
    const leads = asArray(session.leads).filter((lead) => !records.some((record) => exclusionMatchesItem(record, lead))
        && !removedJobs.some((job) => leadMatchesJob(lead, job)));
    return { session: { ...session, jobs, leads }, excludedCount: removedJobs.length + (asArray(session.leads).length - leads.length) };
}
async function loadReportHistory(outputPath, now, maxPostingAgeDays, expectedContext) {
    const target = resolve(outputPath);
    const folder = dirname(target);
    const today = aucklandDateKey(now);
    const earliest = shiftDateKey(today, -Math.max(1, Number(maxPostingAgeDays ?? 30)));
    let names = [];
    try {
        names = await readdir(folder);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const paths = new Set([target]);
    for (const name of names) {
        const match = DAILY_REPORT_PATTERN.exec(name);
        if (match && match[1] >= earliest && match[1] <= today)
            paths.add(join(folder, name));
    }
    const states = new Map();
    const legacyIdentities = new Set();
    let currentMarkdown;
    let targetContextMismatch = false;
    for (const path of paths) {
        const markdown = await readTextIfPresent(path);
        if (markdown === undefined)
            continue;
        const extracted = extractReportHistory(markdown);
        if (extracted.context?.scanContextFingerprint !== expectedContext.scanContextFingerprint) {
            if (path === target)
                targetContextMismatch = true;
            continue;
        }
        if (path === target)
            currentMarkdown = markdown;
        for (const [identity, fingerprints] of extracted.states) {
            const records = states.get(identity) ?? new Set();
            fingerprints.forEach((value) => records.add(value));
            states.set(identity, records);
        }
        extracted.legacyIdentities.forEach((identity) => legacyIdentities.add(identity));
    }
    return { states, legacyIdentities, currentMarkdown, targetContextMismatch };
}
function rawJobState(job, preferences, now) {
    job = canonicaliseJobEvidence(job);
    const verification = classifyVerification(job, preferences, now);
    return fingerprint({
        status: verification.status, reasons: verification.reasons, sourceUrl: normaliseUrl(job.sourceUrl), applicationUrl: normaliseUrl(job.applicationUrl), requisitionId: job.requisitionId,
        dates: Object.fromEntries(Object.entries(verification.dates).map(([field, value]) => [field, { value: value.value, conflict: value.conflict }])),
        programmeType: job.programmeType, contractType: job.contractType, workload: job.workload, engagementModel: job.engagementModel,
        technicalVolunteer: job.isTechnicalVolunteer, compensation: job.compensation, requirements: job.requirements,
        technicalRequirements: job.technicalRequirements,
        strongestSourceKind: bestSourceEvidence(job)?.kind,
    });
}
function filterHistoricalItems(items, history, identityFunction, fingerprintFunction) {
    const fresh = [];
    let excluded = 0;
    let updated = 0;
    for (const original of items) {
        const item = { ...original };
        const identities = identityFunction(item);
        const state = fingerprintFunction(item);
        const sameState = identities.some((identity) => history.states.get(identity)?.has(state));
        const legacyMatch = identities.some((identity) => history.legacyIdentities.has(identity));
        if (sameState || legacyMatch) {
            excluded += 1;
            continue;
        }
        if (identities.some((identity) => history.states.has(identity))) {
            item.historyChange = 'updated';
            updated += 1;
        }
        fresh.push(item);
    }
    return { fresh, excluded, updated };
}
export async function readSession(inputPath) { return JSON.parse(await readFile(resolve(inputPath), 'utf8')); }
export function resolveReportOutput(outputPath, options = {}) {
    const projectDirectory = resolve(options.cwd ?? process.cwd());
    const outputDirectory = join(projectDirectory, 'output');
    const now = options.now ? new Date(options.now) : new Date();
    const target = outputPath
        ? resolve(projectDirectory, outputPath)
        : join(outputDirectory, `nz-jobs-${aucklandDateKey(now)}.md`);
    if (!options.allowCustomOutput && dirname(target) !== outputDirectory) {
        throw new Error(`Report output must be inside ${outputDirectory}; omit --output to use the default, or use --allow-custom-output only when the user explicitly requested another location`);
    }
    return target;
}
export async function writeReport(inputPath, outputPath, options = {}) {
    const session = await readSession(inputPath);
    const validation = validateSession(session);
    if (!validation.valid)
        throw new Error(`Invalid session:\n- ${validation.errors.join('\n- ')}`);
    const state = await loadProjectState(inputPath);
    const exclusions = applyProjectExclusions(session, state);
    const activeSession = exclusions.session;
    const now = options.now ? new Date(options.now) : new Date();
    const scanContext = deriveScanContext(activeSession);
    let target = resolve(outputPath);
    let history = await loadReportHistory(target, now, activeSession.preferences.maxPostingAgeDays, scanContext);
    if (history.targetContextMismatch) {
        target = target.replace(/\.md$/i, `-${scanContext.scanContextFingerprint.slice(0, 8)}.md`);
        history = await loadReportHistory(target, now, activeSession.preferences.maxPostingAgeDays, scanContext);
    }
    const jobs = filterHistoricalItems(activeSession.jobs, history, jobIdentityKeys, (job) => rawJobState(job, activeSession.preferences, now));
    const opportunities = filterHistoricalItems(activeSession.relatedOpportunities, history, opportunityIdentityKeys, (item) => fingerprint({
        registrationStatus: item.registrationStatus, startsAt: item.startsAt, endsAt: item.endsAt,
        conditions: item.conditions, detailPageOpened: item.verificationEvidence?.detailPageOpened,
        applyRouteAvailable: item.verificationEvidence?.applyRouteAvailable,
        expiredIndicatorVisible: item.verificationEvidence?.expiredIndicatorVisible,
        unavailableIndicatorVisible: item.verificationEvidence?.unavailableIndicatorVisible,
    }));
    const reportLeads = activeSession.leads.map((lead) => {
        if (lead.status !== 'assessed' || jobs.fresh.some((job) => leadMatchesJob(lead, job)))
            return lead;
        if (activeSession.jobs.some((job) => leadMatchesJob(lead, job))) {
            return { ...lead, status: 'previously-reported', reason: 'Matching vacancy evidence is unchanged in recent report history' };
        }
        return lead;
    });
    const report = buildReport({ ...activeSession, leads: reportLeads, jobs: jobs.fresh, relatedOpportunities: opportunities.fresh }, {
        ...options, now, searchedCount: activeSession.jobs.length,
        excludedPreviouslyReported: jobs.excluded + opportunities.excluded, updatedListingsCount: jobs.updated,
    });
    report.excludedByProjectState = exclusions.excludedCount;
    report.newListingsCount = jobs.fresh.length;
    report.outputPath = target;
    await mkdir(dirname(target), { recursive: true });
    const newItems = jobs.fresh.length + opportunities.fresh.length;
    if (history.currentMarkdown !== undefined) {
        if (!newItems) {
            report.writeAction = 'unchanged';
            return report;
        }
        await appendFile(target, `\n${renderIncrementalMarkdown(report)}`, 'utf8');
        report.writeAction = 'appended';
        return report;
    }
    await writeFile(target, renderMarkdown(report), 'utf8');
    report.writeAction = 'created';
    return report;
}
function parseArgs(argv) {
    const [command, ...rest] = argv;
    const values = { command: command === '--help' || command === '-h' ? undefined : command, help: command === '--help' || command === '-h' };
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (token === '--input' || token === '-i')
            values.input = rest[++index];
        else if (token === '--output' || token === '-o')
            values.output = rest[++index];
        else if (token === '--allow-custom-output')
            values.allowCustomOutput = true;
        else if (token === '--help' || token === '-h')
            values.help = true;
        else
            throw new Error(`Unknown argument: ${token}`);
    }
    return values;
}
function usage() { return ['NZ Job Scout runtime', '', 'Usage:', '  nz-job-scout validate --input SESSION.json', '  nz-job-scout report --input SESSION.json', '  nz-job-scout report --input SESSION.json --output REPORT.md --allow-custom-output'].join('\n'); }
export async function runCli(argv = process.argv.slice(2)) {
    try {
        const args = parseArgs(argv);
        if (args.help || !args.command) {
            console.log(usage());
            return 0;
        }
        if (!args.input)
            throw new Error('--input is required');
        const session = await readSession(args.input);
        if (args.command === 'validate') {
            const result = validateSession(session);
            if (!result.valid)
                throw new Error(result.errors.join('\n'));
            const coverage = deriveSearchCoverage(session.searchCoverage, session.leads);
            console.log(`Valid session: ${session.jobs.length} assessed listing(s), ${session.leads.length} lead(s), ${coverage.status} coverage`);
            return 0;
        }
        if (args.command === 'report') {
            const output = resolveReportOutput(args.output, { allowCustomOutput: args.allowCustomOutput === true });
            const report = await writeReport(args.input, output);
            if (report.writeAction === 'unchanged')
                console.log(`No new or changed items; existing report left unchanged: ${report.outputPath} (${report.excludedPreviouslyReported} unchanged item(s))`);
            else {
                const action = report.writeAction === 'appended' ? 'updated incrementally' : 'created';
                console.log(`Report ${action}: ${report.outputPath} (${report.recommended.length} recommendation(s), ${report.stretch.length} consider, ${report.manualVerification.length + report.unresolvedHighValueLeads.length} manual-verification lead(s), ${report.updatedListingsCount} updated)`);
            }
            return 0;
        }
        throw new Error(`Unknown command: ${args.command}`);
    }
    catch (error) {
        console.error(`nz-job-scout: ${error.message}`);
        process.exitCode = 1;
        return 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await runCli();
