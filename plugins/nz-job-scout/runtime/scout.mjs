#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LEVEL_WEIGHT = { core: 1, frequent: 0.85, working: 0.6, exposure: 0.25 };
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

function requiredString(value, path, errors) {
  if (!asText(value)) errors.push(`${path} is required`);
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
    const sourceStatuses = new Set(['searched', 'blocked', 'unavailable', 'skipped']);
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
  }
  if (session.candidate) {
    if (!Array.isArray(session.candidate.skills)) errors.push('candidate.skills must be an array');
    asArray(session.candidate.skills).forEach((skill, index) => {
      requiredString(skill?.name, `candidate.skills[${index}].name`, errors);
      if (!Object.hasOwn(LEVEL_WEIGHT, skill?.level)) {
        errors.push(`candidate.skills[${index}].level must be core, frequent, working, or exposure`);
      }
    });
  }
  asArray(session.jobs).forEach((job, index) => {
    requiredString(job?.title, `jobs[${index}].title`, errors);
    requiredString(job?.employer, `jobs[${index}].employer`, errors);
    requiredString(job?.sourceUrl, `jobs[${index}].sourceUrl`, errors);
    requiredString(job?.verificationEvidence?.verifiedAt, `jobs[${index}].verificationEvidence.verifiedAt`, errors);
  });
  return { valid: errors.length === 0, errors };
}

function skillMatch(requiredSkill, candidateSkills, nowYear) {
  const requirement = normalise(requiredSkill);
  if (!requirement) return undefined;
  const match = candidateSkills.find((skill) => {
    const candidate = normalise(skill.name);
    return candidate === requirement || candidate.includes(requirement) || requirement.includes(candidate);
  });
  if (!match) return undefined;
  const level = LEVEL_WEIGHT[match.level] ?? 0;
  const years = Number(match.years ?? 0);
  const yearsFactor = years > 0 ? clamp(0.55 + Math.log2(years + 1) * 0.16, 0.55, 1) : 0.65;
  const lastUsed = Number(match.lastUsedYear ?? nowYear);
  const recency = lastUsed >= nowYear - 1 ? 1 : lastUsed >= nowYear - 3 ? 0.85 : 0.65;
  return { skill: match, score: level * yearsFactor * recency };
}

function scoreRole(job, candidate, now) {
  const required = asArray(job.requiredSkills);
  const preferred = asArray(job.preferredSkills);
  const skills = asArray(candidate.skills);
  const nowYear = now.getFullYear();
  const requiredMatches = required.map((name) => ({ name, match: skillMatch(name, skills, nowYear) }));
  const preferredMatches = preferred.map((name) => ({ name, match: skillMatch(name, skills, nowYear) }));
  const requiredScore = required.length
    ? requiredMatches.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / required.length
    : 0.65;
  const preferredScore = preferred.length
    ? preferredMatches.reduce((sum, item) => sum + (item.match?.score ?? 0), 0) / preferred.length
    : requiredScore;
  const roleText = normalise(`${job.title} ${job.summary ?? ''}`);
  const familyHit = asArray(candidate.targetRoleFamilies).some((family) => {
    const phrase = normalise(family);
    return phrase && (roleText.includes(phrase) || phrase.split(' ').some((part) => part.length > 4 && roleText.includes(part)));
  });
  const domainHit = asArray(candidate.domains).some((domain) => roleText.includes(normalise(domain)));
  const score = requiredScore * 6.8 + preferredScore * 1.2 + (familyHit ? 1.4 : 0.5) + (domainHit ? 0.6 : 0);
  const evidence = requiredMatches
    .filter((item) => item.match)
    .map((item) => `${item.name}: ${item.match.skill.level}${item.match.skill.years ? `, ${item.match.skill.years} years` : ''}`);
  const gaps = requiredMatches.filter((item) => !item.match).map((item) => item.name);
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
  let score = 10;
  const requestedTypes = asArray(preferences.employmentTypes).length
    ? preferences.employmentTypes
    : candidate.employmentTypes;
  if (job.engagementModel && normalise(job.engagementModel) !== 'employee') {
    blockers.push(`Engagement model is ${job.engagementModel}, not employee employment`);
    score -= 7;
  }
  if (job.employmentType && !includesNormalised(requestedTypes, job.employmentType)) {
    blockers.push(`Employment type ${job.employmentType} is outside the requested types`);
    score -= 5;
  } else if (job.employmentType) positives.push(`Employment type: ${job.employmentType}`);
  const remote = normalise(job.workArrangement) === 'remote';
  const allowedLocation = includesNormalised(preferences.locations ?? candidate.locations, job.location);
  if (!allowedLocation && !remote) {
    blockers.push(`Location ${job.location || 'unknown'} is outside the requested area and is not fully remote`);
    score -= 6;
  } else if (remote || allowedLocation) positives.push(remote ? 'Fully remote' : `Location: ${job.location}`);
  if (job.workArrangement && !includesNormalised(preferences.workArrangements ?? candidate.workArrangements, job.workArrangement)) {
    blockers.push(`Work arrangement ${job.workArrangement} is outside the requested arrangements`);
    score -= 4;
  }
  const maxHours = Number(preferences.maxHoursPerWeekDuringStudy ?? 0);
  if (maxHours && Number(job.hoursPerWeek) > maxHours && job.duringScheduledBreak !== true) {
    blockers.push(`${job.hoursPerWeek} hours/week exceeds the ${maxHours}-hour study-period limit`);
    score -= 6;
  }
  if (job.availabilityCompatible === false) {
    blockers.push('Start date or working period conflicts with availability');
    score -= 6;
  }
  if (job.workRightsCompatible === false) {
    blockers.push('Stated work-right requirements are incompatible');
    score -= 8;
  }
  if (job.availabilityCompatible === true) positives.push('Availability appears compatible');
  if (job.workRightsCompatible === true) positives.push('Work rights appear compatible');
  return { score: round1(clamp(score)), blockers, positives };
}

function classifyEvidence(job, preferences, now) {
  const reasons = [];
  let status = 'verified-active';
  let hostname = '';
  try { hostname = new URL(job.sourceUrl).hostname.toLowerCase(); } catch { reasons.push('Source URL is invalid'); }
  if (BLOCKED_AGGREGATORS.some((domain) => hostname.includes(domain))) {
    status = 'rejected';
    reasons.push('Final link is an aggregator rather than SEEK or a direct employer/ATS page');
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
    const roleFit = scoreRole(job, session.candidate, now);
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
  const recommended = evaluated
    .filter((job) => job.verification.status === 'verified-active' && job.practicalFit.blockers.length === 0)
    .sort((a, b) => (b.roleFit.score + b.practicalFit.score) - (a.roleFit.score + a.practicalFit.score));
  const rejected = evaluated.filter((job) => !recommended.includes(job));
  for (const job of duplicates) {
    rejected.push({
      ...job,
      sourceUrl: normaliseUrl(job.sourceUrl),
      verification: { status: 'rejected', reasons: [`Duplicate of retained listing: ${job.duplicateOf}`] },
      roleFit: scoreRole(job, session.candidate, now),
      practicalFit: scorePractical(job, session.candidate, session.preferences),
    });
  }
  return {
    generatedAt: now.toISOString(),
    candidate: session.candidate,
    preferences: session.preferences,
    searchCoverage: session.searchCoverage,
    assumptions: asArray(session.assumptions),
    searchedCount: session.jobs.length,
    recommended,
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
    `- Listings reviewed: ${report.searchedCount}`,
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
    '## Verified roles',
    '',
  ];
  if (!report.recommended.length) {
    if (coverage.status === 'blocked') {
      lines.push('Search incomplete — the configured primary sources could not be searched, so no conclusion can be made about whether qualified vacancies exist.', '');
    } else if (coverage.status === 'partial') {
      lines.push('No qualified roles were found among the sources that could be verified. Search coverage was incomplete, so this is not evidence that no suitable vacancies exist.', '');
    } else {
      lines.push('Today there are no new qualified vacancies.', '');
    }
  } else {
    if (coverage.status !== 'complete') lines.push('> Search coverage was incomplete. The roles below are verified, but additional suitable vacancies may exist.', '');
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
        ''
      );
    });
  }
  lines.push('## Rejected or unverified', '');
  if (!report.rejected.length) {
    lines.push('- None', '');
  } else {
    for (const job of report.rejected) {
      const reasons = [...job.verification.reasons, ...job.practicalFit.blockers];
      lines.push(`- **${job.title} — ${job.employer}** (${job.verification.status}): ${reasons.join('; ') || 'Not recommended after ranking'}. [Source](${job.sourceUrl})`);
    }
    lines.push('');
  }
  lines.push(criteriaOnly ? '## Criteria evidence for the strongest roles' : '## CV emphasis for the strongest roles', '');
  const evidence = [...new Set(report.recommended.flatMap((job) => job.roleFit.evidence))].slice(0, 8);
  const emptyEvidence = criteriaOnly
    ? 'No verified roles were available, so no criteria evidence is available.'
    : 'No verified roles were available, so no role-specific CV emphasis is suggested.';
  lines.push(bulletList(evidence, emptyEvidence), '');
  return `${lines.join('\n')}\n`;
}

export async function readSession(inputPath) {
  return JSON.parse(await readFile(resolve(inputPath), 'utf8'));
}

export async function writeReport(inputPath, outputPath, options = {}) {
  const session = await readSession(inputPath);
  const report = buildReport(session, options);
  const markdown = renderMarkdown(report);
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), markdown, 'utf8');
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
      console.log(`Report written to ${resolve(args.output)} (${report.recommended.length} verified recommendation(s), ${report.rejected.length} rejected/unverified)`);
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
