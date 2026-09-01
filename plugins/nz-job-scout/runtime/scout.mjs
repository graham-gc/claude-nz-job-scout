#!/usr/bin/env node

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
];
const GENERIC_ROLE_TOKENS = new Set([
  'engineer', 'engineering', 'developer', 'development', 'intern', 'internship',
  'graduate', 'junior', 'senior', 'software',
]);
const BLOCKED_AGGREGATORS = [
  'bebee.',
  'ziprecruiter.',
  'thebigjobsite.',
  'joblum.',
  'broxer.',
  'jooble.',
];

const asText = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];
const clamp = (value, min = 0, max = 10) => Math.max(min, Math.min(max, value));
const round1 = (value) => Math.round(value * 10) / 10;
const normalise = (value) => asText(value).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
const DAILY_REPORT_PATTERN = /^nz-jobs-(\d{4}-\d{2}-\d{2})\.md$/;

function aucklandDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function parseDate(value, label) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid date: ${value}`);
  return date;
}

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

export function normaliseUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(ref|source|tracking|trk|eBP|trackingId|refId|seek-token|origin)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return asText(value);
  }
}

function jobIdentityKeys(job) {
  const keys = [];
  const applicationUrl = normaliseUrl(job.applicationUrl);
  const sourceUrl = normaliseUrl(job.sourceUrl);
  if (applicationUrl) keys.push(`url:${applicationUrl}`);
  if (sourceUrl) keys.push(`url:${sourceUrl}`);
  if (job.requisitionId) keys.push(`req:${normalise(job.employer)}:${normalise(job.requisitionId)}`);
  const employer = normalise(job.employer);
  const title = normalise(job.title);
  const location = normalise(job.location);
  if (employer && title) {
    keys.push(`role:${employer}|${title}|${location}`);
    keys.push(`role-loose:${employer}|${title}`);
  }
  return keys;
}

export function extractReportedIdentities(markdown) {
  const identities = new Set();
  for (const match of markdown.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) {
    const url = normaliseUrl(match[1]);
    if (url) identities.add(`url:${url}`);
  }
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-+/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || normalise(cells[0]) === 'role') continue;
    const location = cells[2].split(' / ')[0];
    identities.add(`role:${normalise(cells[1])}|${normalise(cells[0])}|${normalise(location)}`);
  }
  const rolePatterns = [
    /^#{3,4}\s+(?:\d+\.\s+)?(.+?)\s+—\s+(.+?)\s*$/gm,
    /^-\s+\*\*(.+?)\s+—\s+(.+?)\*\*/gm,
  ];
  for (const pattern of rolePatterns) {
    for (const match of markdown.matchAll(pattern)) {
      identities.add(`role-loose:${normalise(match[2])}|${normalise(match[1])}`);
    }
  }
  return identities;
}

async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
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
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const reportPaths = new Set([target]);
  for (const name of names) {
    const match = DAILY_REPORT_PATTERN.exec(name);
    if (match && match[1] >= earliest && match[1] <= today) reportPaths.add(join(folder, name));
  }
  const identities = new Set();
  let currentMarkdown;
  for (const path of reportPaths) {
    const markdown = await readTextIfPresent(path);
    if (markdown === undefined) continue;
    if (path === target) currentMarkdown = markdown;
    for (const identity of extractReportedIdentities(markdown)) identities.add(identity);
  }
  return { identities, currentMarkdown };
}

function requiredString(value, path, errors) {
  if (!asText(value)) errors.push(`${path} is required`);
}

function phraseTokens(value) {
  return normalise(value).split(' ').filter((token) => token && !GENERIC_ROLE_TOKENS.has(token));
}

function conceptGroup(value) {
  const text = normalise(value);
  return CONCEPT_GROUPS.findIndex((group) => group.some((term) => text.includes(term)));
}

function semanticSimilarity(left, right) {
  const a = normalise(left);
  const b = normalise(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if ((a.includes(b) || b.includes(a)) && shorter >= 5 && shorter / longer >= 0.6) return 0.9;
  const aGroup = conceptGroup(a);
  if (aGroup >= 0 && aGroup === conceptGroup(b)) return 0.82;
  const aTokens = new Set(phraseTokens(a));
  const bTokens = new Set(phraseTokens(b));
  if (!aTokens.size || !bTokens.size) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  return intersection / Math.max(aTokens.size, bTokens.size);
}

export function validateSession(session) {
  const errors = [];
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { valid: false, errors: ['session must be a JSON object'] };
  }
  if (!session.candidate || typeof session.candidate !== 'object') errors.push('candidate is required');
  if (!session.preferences || typeof session.preferences !== 'object') errors.push('preferences is required');
  if (!Array.isArray(session.jobs)) errors.push('jobs must be an array');
  if (session.preferences) {
    const searchModes = new Set(['profile', 'criteria', 'combined']);
    if (!searchModes.has(session.preferences.mode)) {
      errors.push('preferences.mode must be profile, criteria, or combined');
    }
  }
  if (!session.searchCoverage || typeof session.searchCoverage !== 'object') {
    errors.push('searchCoverage is required');
  } else {
    const coverageStatuses = new Set(['complete', 'partial', 'blocked']);
    const sourceStatuses = new Set(['searched', 'discovery-only', 'blocked', 'unavailable', 'skipped']);
    if (!coverageStatuses.has(session.searchCoverage.status)) {
      errors.push('searchCoverage.status must be complete, partial, or blocked');
    }
    if (!Array.isArray(session.searchCoverage.sources) || session.searchCoverage.sources.length === 0) {
      errors.push('searchCoverage.sources must contain at least one source attempt');
    }
    asArray(session.searchCoverage.sources).forEach((source, index) => {
      requiredString(source?.name, `searchCoverage.sources[${index}].name`, errors);
      if (!sourceStatuses.has(source?.status)) errors.push(`searchCoverage.sources[${index}].status is invalid`);
    });
    const searchedSources = asArray(session.searchCoverage.sources).filter((source) => source.status === 'searched');
    if (session.searchCoverage.status !== 'blocked' && searchedSources.length === 0) errors.push('complete or partial coverage requires at least one searched source');
    if (!Array.isArray(session.searchCoverage.searchFamilies) || session.searchCoverage.searchFamilies.length === 0) {
      errors.push('searchCoverage.searchFamilies must record at least one role/query family');
    }
    if (!Number.isInteger(session.searchCoverage.queriesRun) || session.searchCoverage.queriesRun < 1) {
      errors.push('searchCoverage.queriesRun must be a positive integer');
    }
    if (!Number.isInteger(session.searchCoverage.leadsDiscovered) || session.searchCoverage.leadsDiscovered < 0) {
      errors.push('searchCoverage.leadsDiscovered must be a non-negative integer');
    }
    if (!Number.isInteger(session.searchCoverage.detailPagesOpened) || session.searchCoverage.detailPagesOpened < 0) {
      errors.push('searchCoverage.detailPagesOpened must be a non-negative integer');
    }
  }
  if (session.candidate) {
    if (!Array.isArray(session.candidate.skills)) errors.push('candidate.skills must be an array');
    if (!Array.isArray(session.candidate.capabilities)) errors.push('candidate.capabilities must be an array');
    asArray(session.candidate.skills).forEach((skill, index) => {
      requiredString(skill?.name, `candidate.skills[${index}].name`, errors);
      if (!Object.hasOwn(LEVEL_WEIGHT, skill?.level)) {
        errors.push(`candidate.skills[${index}].level must be core, frequent, working, or exposure`);
      }
    });
    asArray(session.candidate.capabilities).forEach((capability, index) => {
      requiredString(capability?.name, `candidate.capabilities[${index}].name`, errors);
      if (!Object.hasOwn(LEVEL_WEIGHT, capability?.level)) {
        errors.push(`candidate.capabilities[${index}].level must be core, frequent, working, or exposure`);
      }
    });
  }
  asArray(session.jobs).forEach((job, index) => {
    requiredString(job?.title, `jobs[${index}].title`, errors);
    requiredString(job?.employer, `jobs[${index}].employer`, errors);
    requiredString(job?.sourceUrl, `jobs[${index}].sourceUrl`, errors);
    requiredString(job?.verificationEvidence?.verifiedAt, `jobs[${index}].verificationEvidence.verifiedAt`, errors);
    if (!Array.isArray(job?.roleFamilies) || job.roleFamilies.length === 0) errors.push(`jobs[${index}].roleFamilies must contain at least one duty-derived role family`);
    if (!Array.isArray(job?.responsibilityAreas) || job.responsibilityAreas.length === 0) errors.push(`jobs[${index}].responsibilityAreas must contain at least one responsibility`);
    if (!Array.isArray(job?.requiredSkills)) errors.push(`jobs[${index}].requiredSkills must be an array`);
    if (!Array.isArray(job?.preferredSkills)) errors.push(`jobs[${index}].preferredSkills must be an array`);
    if (!Array.isArray(job?.eligibilityRequirements)) errors.push(`jobs[${index}].eligibilityRequirements must be an array`);
    asArray(job?.requiredSkills).forEach((skill, skillIndex) => {
      if (ELIGIBILITY_REQUIREMENT.test(asText(skill))) {
        errors.push(`jobs[${index}].requiredSkills[${skillIndex}] is an eligibility requirement; move it to eligibilityRequirements`);
      }
    });
  });
  return { valid: errors.length === 0, errors };
}

function skillMatch(requiredSkill, candidateEvidence, nowYear) {
  const requirement = normalise(requiredSkill);
  if (!requirement) return undefined;
  const match = candidateEvidence
    .map((item) => ({ item, similarity: semanticSimilarity(requirement, item.name) }))
    .filter(({ similarity }) => similarity >= 0.5)
    .sort((a, b) => b.similarity - a.similarity)[0];
  if (!match) return undefined;
  const level = LEVEL_WEIGHT[match.item.level] ?? 0;
  const years = Number(match.item.years ?? 0);
  const yearsFactor = years > 0 ? clamp(0.55 + Math.log2(years + 1) * 0.16, 0.55, 1) : 0.65;
  const lastUsed = Number(match.item.lastUsedYear ?? nowYear);
  const recency = lastUsed >= nowYear - 1 ? 1 : lastUsed >= nowYear - 3 ? 0.85 : 0.65;
  return { skill: match.item, score: level * yearsFactor * recency * match.similarity };
}

function bestSemanticMatch(values, targets) {
  let best = 0;
  for (const value of asArray(values)) {
    for (const target of asArray(targets)) best = Math.max(best, semanticSimilarity(value, target));
  }
  return best;
}

function scoreRole(job, candidate, now) {
  const required = asArray(job.requiredSkills);
  const preferred = asArray(job.preferredSkills);
  const responsibilities = asArray(job.responsibilityAreas);
  const evidenceItems = [...asArray(candidate.skills), ...asArray(candidate.capabilities)];
  const nowYear = now.getFullYear();
  const requiredMatches = required.map((name) => ({ name, match: skillMatch(name, evidenceItems, nowYear) }));
  const preferredMatches = preferred.map((name) => ({ name, match: skillMatch(name, evidenceItems, nowYear) }));
  const responsibilityMatches = responsibilities.map((name) => ({ name, match: skillMatch(name, evidenceItems, nowYear) }));
  const requiredScore = required.length
    ? requiredMatches.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / required.length
    : 0.55;
  const preferredScore = preferred.length
    ? preferredMatches.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / preferred.length
    : requiredScore;
  const responsibilityScore = responsibilities.length
    ? responsibilityMatches.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / responsibilities.length
    : 0.45;
  const familyScore = bestSemanticMatch(job.roleFamilies, candidate.targetRoleFamilies);
  const domainScore = bestSemanticMatch(job.domains, candidate.domains);
  const score = requiredScore * 4 + preferredScore + responsibilityScore * 3.5 + familyScore + domainScore * 0.5;
  const evidence = [...requiredMatches, ...responsibilityMatches]
    .filter((item) => item.match)
    .map((item) => `${item.name}: supported by ${item.match.skill.name} (${item.match.skill.level}${item.match.skill.years ? `, ${item.match.skill.years} years` : ''})`);
  const gaps = requiredMatches.filter((item) => !item.match).map((item) => item.name);
  if (!required.length) gaps.push('No concrete required technologies were stated; score relies on responsibilities and transferable capabilities');
  return { score: round1(clamp(score)), evidence: [...new Set(evidence)], gaps };
}

function scoreCriteriaRole(job, candidate, preferences) {
  const targets = [...asArray(preferences.keywords), ...asArray(candidate.targetRoleFamilies)];
  const familyScore = bestSemanticMatch([...asArray(job.roleFamilies), job.title], targets);
  const responsibilityScore = bestSemanticMatch(job.responsibilityAreas, targets);
  const score = familyScore * 7 + responsibilityScore * 3;
  const evidence = [];
  if (familyScore > 0) evidence.push('Duty-derived role family matches the requested role criteria');
  if (responsibilityScore > 0) evidence.push('Advertised responsibilities overlap the requested criteria');
  const gaps = targets.length && familyScore === 0
    ? ['No duty-derived role family matched the requested criteria']
    : [];
  return { score: round1(clamp(score)), evidence, gaps };
}

function includesNormalised(values, value) {
  const target = normalise(value);
  return !target || asArray(values).some((entry) => {
    const allowed = normalise(entry);
    return allowed === target || target.includes(allowed) || allowed.includes(target);
  });
}

function scorePractical(job, candidate, preferences) {
  const blockers = [];
  const positives = [];
  const cautions = [];
  let score = 0;
  const requestedTypes = asArray(preferences.employmentTypes).length
    ? preferences.employmentTypes
    : candidate.employmentTypes;
  if (job.engagementModel && normalise(job.engagementModel) !== 'employee') {
    blockers.push(`Engagement model is ${job.engagementModel}, not employee employment`);
  }
  if (job.employmentType && !includesNormalised(requestedTypes, job.employmentType)) {
    blockers.push(`Employment type ${job.employmentType} is outside the requested types`);
  } else if (job.employmentType) {
    positives.push(`Employment type: ${job.employmentType}`);
    score += 2;
  } else {
    cautions.push('Employment type is not stated');
    score += 0.75;
  }
  const remote = normalise(job.workArrangement) === 'remote';
  const allowedLocation = includesNormalised(preferences.locations ?? candidate.locations, job.location);
  if (!allowedLocation && !remote) {
    blockers.push(`Location ${job.location || 'unknown'} is outside the requested area and is not fully remote`);
  } else if (remote || allowedLocation) {
    positives.push(remote ? 'Fully remote' : `Location: ${job.location}`);
    score += 1.25;
  }
  if (job.workArrangement && !includesNormalised(preferences.workArrangements ?? candidate.workArrangements, job.workArrangement)) {
    blockers.push(`Work arrangement ${job.workArrangement} is outside the requested arrangements`);
  } else if (job.workArrangement) {
    positives.push(`Work arrangement: ${job.workArrangement}`);
    score += 0.75;
  } else {
    cautions.push('Work arrangement is not stated');
    score += 0.35;
  }
  const maxHours = Number(preferences.maxHoursPerWeekDuringStudy ?? 0);
  if (maxHours && Number(job.hoursPerWeek) > maxHours && job.duringScheduledBreak !== true) {
    blockers.push(`${job.hoursPerWeek} hours/week exceeds the ${maxHours}-hour study-period limit`);
  }
  if (job.availabilityCompatible === false) {
    blockers.push('Start date or working period conflicts with availability');
  } else if (job.availabilityCompatible === true) {
    positives.push('Availability appears compatible');
    score += 2;
  } else {
    cautions.push('Availability compatibility was not verified');
    score += 0.75;
  }
  if (job.workRightsCompatible === false) {
    blockers.push('Stated work-right requirements are incompatible');
  } else if (job.workRightsCompatible === true) {
    positives.push('Work rights appear compatible');
    score += 2;
  } else {
    cautions.push('Work-right compatibility was not verified');
    score += 0.75;
  }
  if (job.eligibilityCompatible === false) {
    blockers.push('The candidate does not meet a stated eligibility requirement');
  } else if (job.eligibilityCompatible === true) {
    positives.push('Stated study/qualification eligibility appears compatible');
    score += 2;
  } else {
    cautions.push(asArray(job.eligibilityRequirements).length
      ? 'Study/qualification eligibility was not fully verified'
      : 'No explicit eligibility requirements were recorded');
    score += 0.75;
  }
  for (const risk of asArray(job.selectionRisks)) cautions.push(risk);
  score -= Math.min(2, asArray(job.selectionRisks).length * 0.5);
  return { score: round1(clamp(score)), blockers, positives, cautions };
}

function classifyEvidence(job, preferences, now) {
  const reasons = [];
  let status = 'verified-active';
  let hostname = '';
  try { hostname = new URL(job.sourceUrl).hostname.toLowerCase(); } catch { reasons.push('Source URL is invalid'); }
  if (BLOCKED_AGGREGATORS.some((domain) => hostname.includes(domain))) {
    status = 'rejected';
    reasons.push('Final link is an aggregator rather than a public direct employer/ATS page');
  }
  const evidence = job.verificationEvidence ?? {};
  if (evidence.expiredIndicatorVisible || evidence.unavailableIndicatorVisible) {
    status = 'rejected';
    reasons.push('The page visibly says the vacancy is expired, removed, or unavailable');
  }
  if (!evidence.detailPageOpened) {
    status = status === 'rejected' ? status : 'unverified';
    reasons.push('The job detail page was not directly opened');
  }
  if (!evidence.applyRouteAvailable) {
    status = status === 'rejected' ? status : 'unverified';
    reasons.push('No working application route or clear application instructions were verified');
  }
  const closing = parseDate(job.closesAt, 'closesAt');
  if (closing && closing.getTime() < now.getTime()) {
    status = 'rejected';
    reasons.push(`Closing date ${job.closesAt} has passed`);
  }
  const maxAge = Number(preferences.maxPostingAgeDays ?? 30);
  if (!job.postedAt) {
    status = status === 'rejected' ? status : 'unverified';
    reasons.push('Posting date is unavailable');
  } else {
    const posted = parseDate(job.postedAt, 'postedAt');
    const age = daysBetween(now, posted);
    if (age > maxAge) {
      status = 'rejected';
      reasons.push(`Posted ${age} days ago, outside the ${maxAge}-day window`);
    }
    if (age < -1) {
      status = 'unverified';
      reasons.push('Posting date is in the future');
    }
  }
  return { status, reasons };
}

function dedupeKey(job) {
  const application = normaliseUrl(job.applicationUrl);
  if (application) return `application:${application}`;
  if (job.requisitionId) return `req:${normalise(job.employer)}:${normalise(job.requisitionId)}`;
  return [normalise(job.employer), normalise(job.title), normalise(job.location)].join('|');
}

function evidenceStrength(job) {
  const evidence = job.verificationEvidence ?? {};
  let score = 0;
  if (evidence.detailPageOpened) score += 2;
  if (evidence.applyRouteAvailable) score += 2;
  if (job.applicationUrl) score += 1;
  if (job.requisitionId) score += 1;
  try {
    const host = new URL(job.sourceUrl).hostname;
    if (!host.includes('seek.co.nz') && !host.includes('linkedin.com')) score += 1;
  } catch { /* handled by verification */ }
  return score;
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
    } else {
      duplicates.push({ ...job, duplicateOf: previous.title });
    }
  }
  return { unique: [...byKey.values()], duplicates };
}

export function buildReport(session, options = {}) {
  const validation = validateSession(session);
  if (!validation.valid) throw new Error(`Invalid session:\n- ${validation.errors.join('\n- ')}`);
  const now = options.now ? new Date(options.now) : new Date();
  const { unique, duplicates } = deduplicate(session.jobs);
  const evaluated = unique.map((job) => {
    const verification = classifyEvidence(job, session.preferences, now);
    const roleFit = session.preferences.mode === 'criteria'
      ? scoreCriteriaRole(job, session.candidate, session.preferences)
      : scoreRole(job, session.candidate, now);
    const practicalFit = scorePractical(job, session.candidate, session.preferences);
    return {
      ...job,
      sourceUrl: normaliseUrl(job.sourceUrl),
      applicationUrl: normaliseUrl(job.applicationUrl),
      verification,
      roleFit,
      practicalFit,
    };
  });
  const eligible = evaluated
    .filter((job) => job.verification.status === 'verified-active' && job.practicalFit.blockers.length === 0 && job.practicalFit.score >= 5);
  const recommended = eligible
    .filter((job) => job.roleFit.score >= 5)
    .sort((a, b) => (b.roleFit.score + b.practicalFit.score) - (a.roleFit.score + a.practicalFit.score));
  const stretch = eligible
    .filter((job) => job.roleFit.score >= 3 && job.roleFit.score < 5)
    .sort((a, b) => (b.roleFit.score + b.practicalFit.score) - (a.roleFit.score + a.practicalFit.score));
  const rejected = evaluated.filter((job) => !recommended.includes(job) && !stretch.includes(job));
  for (const job of duplicates) {
    rejected.push({
      ...job,
      sourceUrl: normaliseUrl(job.sourceUrl),
      verification: { status: 'rejected', reasons: [`Duplicate of retained listing: ${job.duplicateOf}`] },
      roleFit: session.preferences.mode === 'criteria'
        ? scoreCriteriaRole(job, session.candidate, session.preferences)
        : scoreRole(job, session.candidate, now),
      practicalFit: scorePractical(job, session.candidate, session.preferences),
    });
  }
  return {
    generatedAt: now.toISOString(),
    candidate: session.candidate,
    preferences: session.preferences,
    searchCoverage: session.searchCoverage,
    assumptions: asArray(session.assumptions),
    searchedCount: options.searchedCount ?? session.jobs.length,
    excludedPreviouslyReported: options.excludedPreviouslyReported ?? 0,
    recommended,
    stretch,
    rejected,
  };
}

function escapeCell(value) {
  return asText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function bulletList(values, fallback = 'None recorded') {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : `- ${fallback}`;
}

function formatAucklandTime(value) {
  const formatted = new Intl.DateTimeFormat('en-NZ', {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'Pacific/Auckland',
  }).format(new Date(value));
  return `${formatted} (Pacific/Auckland)`;
}

export function renderMarkdown(report) {
  const coverage = report.searchCoverage;
  const criteriaOnly = report.preferences.mode === 'criteria';
  const fitLabel = criteriaOnly ? 'Criteria fit' : 'Role fit';
  const fitEvidenceHeading = criteriaOnly ? '**Evidence of criteria match**' : '**Evidence of fit**';
  const lines = [
    '# New Zealand Job Scout Report',
    '',
    `Generated: ${formatAucklandTime(report.generatedAt)}`,
    '',
    '## Search criteria',
    '',
    `- Mode: ${report.preferences.mode ?? 'profile'}`,
    `- Posting age: ${report.preferences.maxPostingAgeDays ?? 30} days`,
    `- Employment types: ${asArray(report.preferences.employmentTypes).join(', ') || 'not specified'}`,
    `- Locations: ${asArray(report.preferences.locations).join(', ') || 'not specified'}`,
    `- Work arrangements: ${asArray(report.preferences.workArrangements).join(', ') || 'not specified'}`,
    `- Leads discovered: ${coverage.leadsDiscovered}`,
    `- Detail pages opened: ${coverage.detailPagesOpened}`,
    `- Listings assessed with evidence: ${report.searchedCount}`,
    `- Search families: ${asArray(coverage.searchFamilies).join(', ')}`,
    `- Queries run: ${coverage.queriesRun}`,
    `- Previously reported listings excluded: ${report.excludedPreviouslyReported ?? 0}`,
    `- Search coverage: ${coverage.status}`,
    '',
    '### Source coverage',
    '',
    ...coverage.sources.map((source) => `- ${source.name} — ${source.status}${source.note ? `: ${source.note}` : ''}`),
    '',
    '### Assumptions',
    '',
    bulletList(report.assumptions),
    '',
    '## Verified recommendations',
    '',
  ];
  if (coverage.status !== 'complete') {
    lines.push('> Search coverage was incomplete. Results describe only the sources accessible in this run; additional suitable vacancies may exist.', '');
  }
  if (!report.recommended.length && !report.stretch.length) {
    if (coverage.status === 'blocked') {
      lines.push('Search incomplete — the configured primary sources could not be searched, so no conclusion can be made about whether qualified vacancies exist.', '');
    } else if (coverage.status === 'partial') {
      lines.push('No qualified roles were found among the sources that could be verified. Search coverage was incomplete, so this is not evidence that no suitable vacancies exist.', '');
    } else {
      lines.push('Today there are no new qualified vacancies.', '');
    }
  } else if (report.recommended.length) {
    lines.push(`| Role | Company | Location / arrangement | ${fitLabel} | Practical fit | Direct link |`, '|---|---|---|---:|---:|---|');
    for (const job of report.recommended) {
      lines.push(`| ${escapeCell(job.title)} | ${escapeCell(job.employer)} | ${escapeCell(`${job.location ?? '-'} / ${job.workArrangement ?? '-'}`)} | ${job.roleFit.score}/10 | ${job.practicalFit.score}/10 | [Open listing](${job.applicationUrl || job.sourceUrl}) |`);
    }
    lines.push('');
    report.recommended.forEach((job, index) => {
      lines.push(
        `### ${index + 1}. ${job.title} — ${job.employer}`,
        '',
        `- Employment: ${job.employmentType ?? 'not stated'}; ${job.engagementModel ?? 'engagement model not stated'}`,
        `- Posted: ${job.postedAt ?? 'not stated'}${job.closesAt ? `; closes: ${job.closesAt}` : ''}`,
        `- Verified: ${job.verificationEvidence.verifiedAt}`,
        `- ${fitLabel}: ${job.roleFit.score}/10`,
        `- Practical fit: ${job.practicalFit.score}/10`,
        `- Link: ${job.applicationUrl || job.sourceUrl}`,
        '',
        fitEvidenceHeading,
        '',
        bulletList(job.roleFit.evidence),
        '',
        '**Gaps / cautions**',
        '',
        bulletList(job.roleFit.gaps),
        '',
        '**Practical-fit evidence**',
        '',
        bulletList(job.practicalFit.positives),
        '',
        '**Practical cautions**',
        '',
        bulletList(job.practicalFit.cautions),
        ''
      );
    });
  } else {
    lines.push('No primary recommendation met the 5/10 role-fit threshold. See verified stretch roles below.', '');
  }
  if (report.stretch.length) {
    lines.push(
      '## Verified stretch roles',
      '',
      '> These vacancies are practically possible but have weaker alignment with the candidate\'s sustained day-to-day experience. Treat them as optional applications, not primary recommendations.',
      '',
      `| Role | Company | Location / arrangement | ${fitLabel} | Practical fit | Direct link |`,
      '|---|---|---|---:|---:|---|',
    );
    for (const job of report.stretch) {
      lines.push(`| ${escapeCell(job.title)} | ${escapeCell(job.employer)} | ${escapeCell(`${job.location ?? '-'} / ${job.workArrangement ?? '-'}`)} | ${job.roleFit.score}/10 | ${job.practicalFit.score}/10 | [Open listing](${job.applicationUrl || job.sourceUrl}) |`);
    }
    lines.push('');
    report.stretch.forEach((job, index) => {
      lines.push(
        `### Stretch ${index + 1}. ${job.title} — ${job.employer}`,
        '',
        `- Employment: ${job.employmentType ?? 'not stated'}; ${job.engagementModel ?? 'engagement model not stated'}`,
        `- Posted: ${job.postedAt ?? 'not stated'}${job.closesAt ? `; closes: ${job.closesAt}` : ''}`,
        `- Verified: ${job.verificationEvidence.verifiedAt}`,
        `- ${fitLabel}: ${job.roleFit.score}/10`,
        `- Practical fit: ${job.practicalFit.score}/10`,
        `- Link: ${job.applicationUrl || job.sourceUrl}`,
        '',
        fitEvidenceHeading,
        '',
        bulletList(job.roleFit.evidence),
        '',
        '**Gaps / cautions**',
        '',
        bulletList(job.roleFit.gaps),
        '',
        '**Practical cautions**',
        '',
        bulletList(job.practicalFit.cautions),
        '',
      );
    });
  }
  lines.push('## Rejected or unverified', '');
  if (!report.rejected.length) {
    lines.push('- None', '');
  } else {
    for (const job of report.rejected) {
      const roleReason = job.verification.status === 'verified-active' && job.roleFit.score < 3
        ? [`Role fit ${job.roleFit.score}/10 is below the minimum stretch threshold`]
        : [];
      const reasons = [...job.verification.reasons, ...job.practicalFit.blockers, ...roleReason];
      lines.push(`- **${job.title} — ${job.employer}** (${job.verification.status}): ${reasons.join('; ') || 'Not recommended after ranking'}. [Source](${job.sourceUrl})`);
    }
    lines.push('');
  }
  lines.push(criteriaOnly ? '## Criteria evidence for the strongest roles' : '## CV emphasis for the strongest roles', '');
  const rankedRoles = [...report.recommended, ...report.stretch];
  const evidence = [...new Set(rankedRoles.flatMap((job) => job.roleFit.evidence))].slice(0, 8);
  const emptyEvidence = rankedRoles.length
    ? 'Verified roles were found, but the evidence session captured no defensible role-specific emphasis.'
    : criteriaOnly
      ? 'No verified roles were available, so no criteria evidence is available.'
      : 'No verified roles were available, so no role-specific CV emphasis is suggested.';
  lines.push(bulletList(evidence, emptyEvidence), '');
  return `${lines.join('\n')}\n`;
}

export function renderIncrementalMarkdown(report) {
  const lines = renderMarkdown(report).trimEnd().split('\n');
  const body = lines.slice(4).map((line) => {
    if (line.startsWith('### ')) return `#### ${line.slice(4)}`;
    if (line.startsWith('## ')) return `### ${line.slice(3)}`;
    return line;
  });
  return [
    '---',
    '',
    `## Incremental scan — ${formatAucklandTime(report.generatedAt)}`,
    '',
    ...body,
    '',
  ].join('\n');
}

export async function readSession(inputPath) {
  return JSON.parse(await readFile(resolve(inputPath), 'utf8'));
}

export async function writeReport(inputPath, outputPath, options = {}) {
  const session = await readSession(inputPath);
  const now = options.now ? new Date(options.now) : new Date();
  const target = resolve(outputPath);
  const history = await loadReportHistory(target, now, session.preferences.maxPostingAgeDays);
  const newJobs = session.jobs.filter((job) => !jobIdentityKeys(job).some((key) => history.identities.has(key)));
  const excludedPreviouslyReported = session.jobs.length - newJobs.length;
  const report = buildReport(
    { ...session, jobs: newJobs },
    {
      ...options,
      now,
      searchedCount: session.jobs.length,
      excludedPreviouslyReported,
    },
  );
  report.newListingsCount = newJobs.length;
  await mkdir(dirname(target), { recursive: true });
  if (history.currentMarkdown !== undefined) {
    if (!newJobs.length) {
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
  const values = {
    command: command === '--help' || command === '-h' ? undefined : command,
    help: command === '--help' || command === '-h',
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--input' || token === '-i') values.input = rest[++index];
    else if (token === '--output' || token === '-o') values.output = rest[++index];
    else if (token === '--help' || token === '-h') values.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return values;
}

function usage() {
  return [
    'NZ Job Scout runtime',
    '',
    'Usage:',
    '  nz-job-scout validate --input SESSION.json',
    '  nz-job-scout report --input SESSION.json --output REPORT.md',
  ].join('\n');
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help || !args.command) {
      console.log(usage());
      return 0;
    }
    if (!args.input) throw new Error('--input is required');
    const session = await readSession(args.input);
    if (args.command === 'validate') {
      const result = validateSession(session);
      if (!result.valid) throw new Error(result.errors.join('\n'));
      console.log(`Valid session: ${session.jobs.length} job listing(s)`);
      return 0;
    }
    if (args.command === 'report') {
      if (!args.output) throw new Error('--output is required for report');
      const report = await writeReport(args.input, args.output);
      if (report.writeAction === 'unchanged') {
        console.log(`No new listings; existing report left unchanged: ${resolve(args.output)} (${report.excludedPreviouslyReported} previously reported)`);
      } else {
        const action = report.writeAction === 'appended' ? 'updated incrementally' : 'created';
        console.log(`Report ${action}: ${resolve(args.output)} (${report.recommended.length} new verified recommendation(s), ${report.stretch.length} new stretch role(s), ${report.rejected.length} new rejected/unverified, ${report.excludedPreviouslyReported} previously reported)`);
      }
      return 0;
    }
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    console.error(`nz-job-scout: ${error.message}`);
    process.exitCode = 1;
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli();
}
