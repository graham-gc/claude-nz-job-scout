#!/usr/bin/env node
// Single source of truth for the dependency-free runtime bundled with the plugin.
// The module deliberately uses JavaScript-compatible TypeScript so `tsc` can emit
// a standalone .mjs file without introducing runtime packages.
// @ts-nocheck
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
];
const DAILY_REPORT_PATTERN = /^nz-jobs-(\d{4}-\d{2}-\d{2})\.md$/;
const ITEM_MARKER = /<!-- nz-job-scout:item (\{.+?\}) -->/g;
const asText = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];
const clamp = (value, min = 0, max = 10) => Math.max(min, Math.min(max, value));
const round1 = (value) => Math.round(value * 10) / 10;
const normalise = (value) => asText(value).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
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
function dateObservations(job, field) {
    const recorded = asArray(job.dateEvidence?.[field]);
    if (recorded.length)
        return recorded;
    const legacy = job[field];
    return legacy ? [{ value: legacy, sourceUrl: job.sourceUrl, sourceType: 'legacy', confidence: 'low' }] : [];
}
export function resolveDateEvidence(job, field) {
    const observations = dateObservations(job, field).filter((entry) => asText(entry?.value));
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
    const searched = attempts.filter((attempt) => attempt.status === 'searched');
    const materialFailures = attempts.filter((attempt) => attempt.requiredForCoverage !== false && ['blocked', 'unavailable', 'discovery-only'].includes(attempt.status));
    const unsearchedFamilies = families.filter((family) => !searched.some((attempt) => normalise(attempt.roleFamily) === normalise(family)));
    const status = searched.length === 0 ? 'blocked' : materialFailures.length || unsearchedFamilies.length ? 'partial' : 'complete';
    const leadList = asArray(leads);
    return {
        status,
        searchFamilies: families,
        queriesRun: attempts.length,
        leadsDiscovered: leadList.length,
        detailPagesOpened: leadList.filter((lead) => lead.detailPageOpened === true).length,
        attempts,
        unsearchedFamilies,
    };
}
export function validateSession(session) {
    const errors = [];
    if (!session || typeof session !== 'object' || Array.isArray(session))
        return { valid: false, errors: ['session must be a JSON object'] };
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
        const statuses = new Set(['searched', 'discovery-only', 'blocked', 'unavailable', 'skipped']);
        asArray(session.searchCoverage.attempts).forEach((attempt, index) => {
            requiredString(attempt?.roleFamily, `searchCoverage.attempts[${index}].roleFamily`, errors);
            requiredString(attempt?.source, `searchCoverage.attempts[${index}].source`, errors);
            requiredString(attempt?.query, `searchCoverage.attempts[${index}].query`, errors);
            if (!statuses.has(attempt?.status))
                errors.push(`searchCoverage.attempts[${index}].status is invalid`);
        });
    }
    const leadStatuses = new Set(['assessed', 'duplicate', 'blocked', 'not-opened', 'out-of-scope', 'previously-reported']);
    asArray(session.leads).forEach((lead, index) => {
        for (const field of ['title', 'employer', 'source', 'url', 'roleFamily', 'discoveredAt'])
            requiredString(lead?.[field], `leads[${index}].${field}`, errors);
        if (!leadStatuses.has(lead?.status))
            errors.push(`leads[${index}].status is invalid`);
        if (lead?.status !== 'assessed' && !asText(lead?.reason))
            errors.push(`leads[${index}].reason is required when status is ${lead?.status}`);
    });
    if (session.candidate) {
        for (const field of ['targetRoleFamilies', 'locations', 'workArrangements', 'domains', 'qualifications']) {
            if (!Array.isArray(session.candidate[field]))
                errors.push(`candidate.${field} must be an array`);
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
        if (!Array.isArray(job?.roleFamilies) || !job.roleFamilies.length)
            errors.push(`jobs[${index}].roleFamilies must contain at least one duty-derived family`);
        if (!Array.isArray(job?.responsibilityAreas) || !job.responsibilityAreas.length)
            errors.push(`jobs[${index}].responsibilityAreas must contain at least one responsibility`);
        if (!Array.isArray(job?.requiredSkills))
            errors.push(`jobs[${index}].requiredSkills must be an array`);
        if (!Array.isArray(job?.preferredSkills))
            errors.push(`jobs[${index}].preferredSkills must be an array`);
        if (!Array.isArray(job?.requirements))
            errors.push(`jobs[${index}].requirements must be an array`);
        asArray(job?.requiredSkills).forEach((skill, skillIndex) => {
            if (ELIGIBILITY_REQUIREMENT.test(asText(skill)))
                errors.push(`jobs[${index}].requiredSkills[${skillIndex}] is an eligibility requirement; move it to requirements`);
        });
        asArray(job?.requirements).forEach((requirement, requirementIndex) => {
            requiredString(requirement?.text, `jobs[${index}].requirements[${requirementIndex}].text`, errors);
            if (!['hard', 'preference'].includes(requirement?.strength))
                errors.push(`jobs[${index}].requirements[${requirementIndex}].strength is invalid`);
            if (!['met', 'not-met', 'unknown'].includes(requirement?.compatibility))
                errors.push(`jobs[${index}].requirements[${requirementIndex}].compatibility is invalid`);
        });
        validateDateEvidence(job, index, errors);
    });
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
    const required = asArray(job.requiredSkills);
    const preferred = asArray(job.preferredSkills);
    const responsibilities = asArray(job.responsibilityAreas);
    const evidenceItems = [...asArray(candidate.skills), ...asArray(candidate.capabilities)];
    const matchAll = (values) => values.map((name) => ({ name, match: skillMatch(name, evidenceItems, now.getFullYear()) }));
    const requiredMatches = matchAll(required);
    const preferredMatches = matchAll(preferred);
    const responsibilityMatches = matchAll(responsibilities);
    const average = (items, fallback) => items.length ? items.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / items.length : fallback;
    const requiredScore = average(requiredMatches, 0.55);
    const preferredScore = average(preferredMatches, requiredScore);
    const responsibilityScore = average(responsibilityMatches, 0.45);
    const score = requiredScore * 4 + preferredScore + responsibilityScore * 3.5
        + bestSemanticMatch(job.roleFamilies, candidate.targetRoleFamilies)
        + bestSemanticMatch(job.domains, candidate.domains) * 0.5;
    const evidence = [...requiredMatches, ...responsibilityMatches].filter((item) => item.match)
        .map((item) => `${item.name}: supported by ${item.match.skill.name} (${item.match.skill.level}${item.match.skill.years ? `, ${item.match.skill.years} years` : ''})`);
    const gaps = requiredMatches.filter((item) => !item.match).map((item) => item.name);
    if (!required.length)
        gaps.push('No concrete required technologies were stated; score relies on responsibilities and transferable capabilities');
    return { score: round1(clamp(score)), evidence: [...new Set(evidence)], gaps };
}
function scoreCriteriaRole(job, candidate, preferences) {
    const requested = asArray(preferences.constraints).filter((item) => ['keyword', 'roleFamily'].includes(item.field)).map((item) => item.value);
    const targets = [...requested, ...asArray(preferences.keywords), ...asArray(candidate.targetRoleFamilies)];
    const familyScore = bestSemanticMatch([...asArray(job.roleFamilies), job.title], targets);
    const responsibilityScore = bestSemanticMatch(job.responsibilityAreas, targets);
    return {
        score: round1(clamp(familyScore * 7 + responsibilityScore * 3)),
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
    let score = 0;
    if (job.engagementModel && normalise(job.engagementModel) !== 'employee')
        blockers.push(`Engagement model is ${job.engagementModel}, not employee employment`);
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
    else if (availability.status === 'incompatible')
        blockers.push(availability.reason);
    else {
        cautions.push(availability.reason);
        score += 0.5;
    }
    const workRights = evaluateWorkRights(job, candidate, dates);
    if (workRights.status === 'compatible') {
        positives.push(workRights.reason);
        score += 2;
    }
    else if (workRights.status === 'incompatible')
        blockers.push(workRights.reason);
    else {
        cautions.push(workRights.reason);
        score += 0.5;
    }
    const requirements = asArray(job.requirements);
    if (!requirements.length) {
        cautions.push('No explicit non-technical eligibility requirements were recorded');
        score += 0.5;
    }
    else {
        const hard = requirements.filter((item) => item.strength === 'hard');
        const failed = hard.filter((item) => item.compatibility === 'not-met');
        const unknown = hard.filter((item) => item.compatibility === 'unknown');
        const met = hard.filter((item) => item.compatibility === 'met');
        failed.forEach((item) => blockers.push(`Hard requirement not met: ${item.text}`));
        unknown.forEach((item) => cautions.push(`Hard requirement not verified: ${item.text}`));
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
    return { score: round1(clamp(score)), blockers: [...new Set(blockers)], positives: [...new Set(positives)], cautions: [...new Set(cautions)] };
}
export function classifyVerification(job, preferences, now = new Date()) {
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
    if (BLOCKED_AGGREGATORS.some((domain) => hostname.includes(domain))) {
        status = 'rejected';
        reasons.push('Final link is an aggregator rather than a permitted direct vacancy page');
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
function dedupeKey(job) {
    if (job.requisitionId)
        return `req:${normalise(job.employer)}:${normalise(job.requisitionId)}`;
    const application = normaliseUrl(job.applicationUrl);
    if (application)
        return `application:${application}`;
    return [normalise(job.employer), normalise(job.title), normalise(job.location)].join('|');
}
function evidenceStrength(job) {
    const evidence = job.verificationEvidence ?? {};
    return Number(Boolean(evidence.detailPageOpened)) * 2 + Number(Boolean(evidence.applyRouteAvailable)) * 2
        + Number(Boolean(job.applicationUrl)) + Number(Boolean(job.requisitionId))
        + Object.values(job.dateEvidence ?? {}).flatMap(asArray).filter((entry) => ['employer', 'ats'].includes(entry.sourceType)).length;
}
function deduplicate(jobs) {
    const byKey = new Map();
    const duplicates = [];
    for (const job of jobs) {
        const key = dedupeKey(job);
        const previous = byKey.get(key);
        if (!previous) {
            byKey.set(key, job);
            continue;
        }
        if (evidenceStrength(job) > evidenceStrength(previous)) {
            duplicates.push({ ...previous, duplicateOf: job.title });
            byKey.set(key, job);
        }
        else
            duplicates.push({ ...job, duplicateOf: previous.title });
    }
    return { unique: [...byKey.values()], duplicates };
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
        programmeType: job.programmeType, contractType: job.contractType, workload: job.workload, requirements: job.requirements,
    });
}
export function buildReport(session, options = {}) {
    const validation = validateSession(session);
    if (!validation.valid)
        throw new Error(`Invalid session:\n- ${validation.errors.join('\n- ')}`);
    const now = options.now ? new Date(options.now) : new Date();
    const coverage = deriveSearchCoverage(session.searchCoverage, session.leads);
    const { unique, duplicates } = deduplicate(session.jobs);
    const evaluated = unique.map((job) => {
        const verification = classifyVerification(job, session.preferences, now);
        const result = {
            ...job,
            sourceUrl: normaliseUrl(job.sourceUrl), applicationUrl: normaliseUrl(job.applicationUrl), verification,
            roleFit: session.preferences.mode === 'criteria' ? scoreCriteriaRole(job, session.candidate, session.preferences) : scoreRoleFit(session.candidate, job, now),
            practicalFit: scorePracticalFit(session.candidate, session.preferences, job),
        };
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
        result.stateFingerprint = assessmentState(result);
        evaluated.push(result);
    }
    const noBlockers = (job) => job.practicalFit.blockers.length === 0 && job.practicalFit.score >= 5;
    const verifiedEligible = evaluated.filter((job) => job.verification.status === 'verified-active' && noBlockers(job));
    const recommended = verifiedEligible.filter((job) => job.roleFit.score >= 5);
    const stretch = verifiedEligible.filter((job) => job.roleFit.score >= 3 && job.roleFit.score < 5);
    const manualVerification = evaluated.filter((job) => session.preferences.includeUnverified !== false && job.verification.status === 'unverified' && noBlockers(job) && job.roleFit.score >= 5);
    const closed = evaluated.filter((job) => ['closed', 'unavailable'].includes(job.verification.status));
    const incompatible = evaluated.filter((job) => job.verification.status === 'verified-active' && job.practicalFit.blockers.length > 0);
    const lowFit = evaluated.filter((job) => job.verification.status === 'verified-active' && noBlockers(job) && job.roleFit.score < 3);
    const classified = new Set([...recommended, ...stretch, ...manualVerification, ...closed, ...incompatible, ...lowFit]);
    const otherUnverified = evaluated.filter((job) => !classified.has(job));
    const sortFit = (a, b) => (b.roleFit.score + b.practicalFit.score) - (a.roleFit.score + a.practicalFit.score);
    [recommended, stretch, manualVerification].forEach((items) => items.sort(sortFit));
    const relatedOpportunities = asArray(session.relatedOpportunities).map((item) => ({
        ...item, url: normaliseUrl(item.url), status: classifyRelatedOpportunity(item),
        stateFingerprint: fingerprint({ registrationStatus: item.registrationStatus, startsAt: item.startsAt, endsAt: item.endsAt, conditions: item.conditions, evidence: item.verificationEvidence }),
    }));
    return {
        generatedAt: now.toISOString(), candidate: session.candidate, preferences: session.preferences,
        searchCoverage: coverage, assumptions: asArray(session.assumptions), leads: asArray(session.leads),
        searchedCount: options.searchedCount ?? session.jobs.length,
        excludedPreviouslyReported: options.excludedPreviouslyReported ?? 0,
        updatedListingsCount: options.updatedListingsCount ?? session.jobs.filter((job) => job.historyChange === 'updated').length,
        recommended, stretch, manualVerification, closed, incompatible, lowFit, otherUnverified, relatedOpportunities,
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
        `- Programme: ${job.programmeType}; contract: ${job.contractType}; workload: ${job.workload}; ${job.engagementModel ?? 'engagement model not stated'}`,
        `- ${dateSummary(job)}`, `- Verified: ${job.verificationEvidence.verifiedAt}`,
        `- Role fit: ${job.roleFit.score}/10`, `- Practical fit: ${job.practicalFit.score}/10`,
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
        `| Role | Company | Location / arrangement | ${fitLabel} | Practical fit | Direct link |`, '|---|---|---|---:|---:|---|',
        ...items.map((job) => `| ${escapeCell(job.title)} | ${escapeCell(job.employer)} | ${escapeCell(`${job.location} / ${job.workArrangement ?? '-'}`)} | ${job.roleFit.score}/10 | ${job.practicalFit.score}/10 | [Open listing](${job.applicationUrl || job.sourceUrl}) |`), '',
    ];
}
export function renderMarkdown(report) {
    const coverage = report.searchCoverage;
    const criteriaOnly = report.preferences.mode === 'criteria';
    const fitLabel = criteriaOnly ? 'Criteria fit' : 'Role fit';
    const lines = [
        '# New Zealand Job Scout Report', '', `Generated: ${formatAucklandTime(report.generatedAt)}`, '',
        '## Search criteria', '', `- Mode: ${report.preferences.mode}`, `- Posting age: ${report.preferences.maxPostingAgeDays ?? 30} days`,
        `- Leads discovered: ${coverage.leadsDiscovered}`, `- Detail pages opened: ${coverage.detailPagesOpened}`,
        `- Listings assessed with evidence: ${report.searchedCount}`, `- Search families: ${coverage.searchFamilies.join(', ')}`,
        `- Queries run: ${coverage.queriesRun}`, `- Lead outcomes: ${leadBreakdown(report.leads)}`,
        `- Previously reported unchanged listings excluded: ${report.excludedPreviouslyReported}`,
        `- Listings with changed evidence included: ${report.updatedListingsCount}`, `- Search coverage: ${coverage.status}`, '',
        '### Search attempts', '', '| Role family | Source | Status | Query | Leads | Detail pages |', '|---|---|---|---|---:|---:|',
        ...coverage.attempts.map((attempt) => `| ${escapeCell(attempt.roleFamily)} | ${escapeCell(attempt.source)} | ${attempt.status} | ${escapeCell(attempt.query)} | ${Number(attempt.leadsDiscovered ?? 0)} | ${Number(attempt.detailPagesOpened ?? 0)} |`), '',
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
    if (!report.manualVerification.length)
        lines.push('- None', '');
    else {
        lines.push('> These leads match the requested profile, but the exact public detail page, application route, posting date, or conflicting evidence prevented verification. They are not counted as recommendations.', '');
        for (const job of report.manualVerification)
            lines.push(`- **${job.title} — ${job.employer}** (${fitLabel} ${job.roleFit.score}/10; practical fit ${job.practicalFit.score}/10): ${job.verification.reasons.join('; ')}. [Discovery source](${job.sourceUrl})`);
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
                const reasons = [...job.verification.reasons, ...job.practicalFit.blockers, ...(job.roleFit.score < 3 ? [`Role fit ${job.roleFit.score}/10 is below the stretch threshold`] : [])];
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
    const body = renderMarkdown(report).trimEnd().split('\n').slice(4).map((line) => line.startsWith('### ') ? `#### ${line.slice(4)}` : line.startsWith('## ') ? `### ${line.slice(3)}` : line);
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
    return { states, legacyIdentities };
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
async function loadReportHistory(outputPath, now, maxPostingAgeDays) {
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
    for (const path of paths) {
        const markdown = await readTextIfPresent(path);
        if (markdown === undefined)
            continue;
        if (path === target)
            currentMarkdown = markdown;
        const extracted = extractReportHistory(markdown);
        for (const [identity, fingerprints] of extracted.states) {
            const records = states.get(identity) ?? new Set();
            fingerprints.forEach((value) => records.add(value));
            states.set(identity, records);
        }
        extracted.legacyIdentities.forEach((identity) => legacyIdentities.add(identity));
    }
    return { states, legacyIdentities, currentMarkdown };
}
function rawJobState(job, preferences, now) {
    const verification = classifyVerification(job, preferences, now);
    return fingerprint({
        status: verification.status, reasons: verification.reasons, sourceUrl: normaliseUrl(job.sourceUrl), applicationUrl: normaliseUrl(job.applicationUrl), requisitionId: job.requisitionId,
        dates: Object.fromEntries(Object.entries(verification.dates).map(([field, value]) => [field, { value: value.value, conflict: value.conflict }])),
        programmeType: job.programmeType, contractType: job.contractType, workload: job.workload, requirements: job.requirements,
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
export async function writeReport(inputPath, outputPath, options = {}) {
    const session = await readSession(inputPath);
    const validation = validateSession(session);
    if (!validation.valid)
        throw new Error(`Invalid session:\n- ${validation.errors.join('\n- ')}`);
    const now = options.now ? new Date(options.now) : new Date();
    const target = resolve(outputPath);
    const history = await loadReportHistory(target, now, session.preferences.maxPostingAgeDays);
    const jobs = filterHistoricalItems(session.jobs, history, jobIdentityKeys, (job) => rawJobState(job, session.preferences, now));
    const opportunities = filterHistoricalItems(session.relatedOpportunities, history, opportunityIdentityKeys, (item) => fingerprint({ registrationStatus: item.registrationStatus, startsAt: item.startsAt, endsAt: item.endsAt, conditions: item.conditions, evidence: item.verificationEvidence }));
    const report = buildReport({ ...session, jobs: jobs.fresh, relatedOpportunities: opportunities.fresh }, {
        ...options, now, searchedCount: session.jobs.length,
        excludedPreviouslyReported: jobs.excluded + opportunities.excluded, updatedListingsCount: jobs.updated,
    });
    report.newListingsCount = jobs.fresh.length;
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
        else if (token === '--help' || token === '-h')
            values.help = true;
        else
            throw new Error(`Unknown argument: ${token}`);
    }
    return values;
}
function usage() { return ['NZ Job Scout runtime', '', 'Usage:', '  nz-job-scout validate --input SESSION.json', '  nz-job-scout report --input SESSION.json --output REPORT.md'].join('\n'); }
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
            if (!args.output)
                throw new Error('--output is required for report');
            const report = await writeReport(args.input, args.output);
            if (report.writeAction === 'unchanged')
                console.log(`No new or changed items; existing report left unchanged: ${resolve(args.output)} (${report.excludedPreviouslyReported} unchanged item(s))`);
            else {
                const action = report.writeAction === 'appended' ? 'updated incrementally' : 'created';
                console.log(`Report ${action}: ${resolve(args.output)} (${report.recommended.length} recommendation(s), ${report.stretch.length} stretch, ${report.manualVerification.length} manual-verification lead(s), ${report.updatedListingsCount} updated)`);
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
