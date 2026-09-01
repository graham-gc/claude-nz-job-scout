import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildReport,
  classifyVerification,
  deriveSearchCoverage,
  renderMarkdown,
  scorePracticalFit,
  validateSession,
  writeReport,
} from '../runtime/scout.mjs';

const verifiedAt = '2026-09-01T09:00:00+12:00';
const candidate = {
  name: 'Test Candidate',
  targetRoleFamilies: ['Software Test Engineer', 'Java Backend'],
  locations: ['Auckland'],
  workArrangements: ['on-site', 'hybrid', 'remote'],
  availabilityWindows: [
    { startAt: '2026-11-01', endAt: '2027-02-28', maxHoursPerWeek: 40, note: 'Scheduled summer break' },
    { startAt: '2026-07-01', endAt: '2026-10-31', maxHoursPerWeek: 25, note: 'Teaching period' },
  ],
  workRights: {
    country: 'New Zealand', status: 'temporary', unrestricted: false,
    validUntil: '2027-12-31', visaType: 'Student Visa',
  },
  domains: ['test automation', 'developer productivity'],
  skills: [
    { name: 'Java', level: 'core', years: 8, lastUsedYear: 2026 },
    { name: 'Spring Boot', level: 'frequent', years: 4, lastUsedYear: 2026 },
  ],
  capabilities: [
    { name: 'API test automation', level: 'core', years: 4, lastUsedYear: 2026 },
    { name: 'test framework development', level: 'core', years: 4, lastUsedYear: 2026 },
    { name: 'backend development', level: 'frequent', years: 4, lastUsedYear: 2026 },
  ],
  qualifications: ['Bachelor of Engineering', 'Master of Information Technology in progress'],
};

const observation = (value, sourceUrl = 'https://careers.example.com/jobs/NZ-101') => ({
  value, sourceUrl, sourceType: 'employer', confidence: 'high',
});

function activeJob(overrides = {}) {
  return {
    source: 'Employer careers site',
    sourceUrl: 'https://careers.example.com/jobs/NZ-101?tracking=test',
    applicationUrl: 'https://careers.example.com/jobs/NZ-101/apply',
    requisitionId: 'NZ-101',
    title: 'Software Test Engineer Intern',
    employer: 'Example Engineering',
    location: 'Auckland',
    workArrangement: 'hybrid',
    programmeType: 'internship',
    contractType: 'fixed-term',
    workload: 'full-time',
    engagementModel: 'employee',
    hoursPerWeek: 40,
    summary: 'API test automation for a Java platform',
    roleFamilies: ['software test engineering', 'backend engineering'],
    responsibilityAreas: ['API test automation', 'test framework development', 'backend debugging'],
    domains: ['test automation', 'developer productivity'],
    requiredSkills: ['Java', 'API automation'],
    preferredSkills: ['Spring Boot'],
    requirements: [{ category: 'study', text: 'Currently studying at a New Zealand tertiary institution', strength: 'hard', compatibility: 'met' }],
    workRightsRequirement: { country: 'New Zealand', requiresCurrentRights: true, requiresUnrestricted: false },
    dateEvidence: {
      postedAt: [observation('2026-08-25')],
      closesAt: [observation('2026-09-30')],
      startAt: [observation('2026-11-16')],
      endAt: [observation('2027-02-12')],
    },
    selectionRisks: [],
    verificationEvidence: {
      detailPageOpened: true, applyRouteAvailable: true,
      expiredIndicatorVisible: false, unavailableIndicatorVisible: false,
      verifiedAt, notes: [],
    },
    ...overrides,
  };
}

function leadFor(job, overrides = {}) {
  return {
    title: job.title, employer: job.employer, source: job.source,
    url: job.sourceUrl, roleFamily: job.roleFamilies[0], discoveredAt: verifiedAt,
    detailPageOpened: true, status: 'assessed', ...overrides,
  };
}

function session(jobs = [activeJob()], overrides = {}) {
  const leads = jobs.map((job) => leadFor(job));
  return {
    candidate: structuredClone(candidate),
    preferences: {
      mode: 'profile', maxPostingAgeDays: 30, includeUnverified: true,
      constraints: [
        { field: 'programmeType', value: 'internship', strength: 'hard', source: 'user-explicit' },
        { field: 'location', value: 'Auckland', strength: 'hard', source: 'user-explicit' },
        { field: 'workArrangement', value: 'hybrid', strength: 'soft', source: 'skill-default' },
      ],
    },
    searchCoverage: {
      searchFamilies: ['software test engineering', 'Java backend'],
      attempts: [
        { roleFamily: 'software test engineering', source: 'Employer careers', query: 'software test intern Auckland', status: 'searched', leadsDiscovered: leads.length, detailPagesOpened: leads.length },
        { roleFamily: 'Java backend', source: 'Public ATS', query: 'Java backend intern Auckland', status: 'searched', leadsDiscovered: 0, detailPagesOpened: 0 },
      ],
    },
    leads,
    assumptions: ['Only public vacancy and ATS pages were used.'],
    jobs,
    relatedOpportunities: [],
    ...overrides,
  };
}

test('validates the structured evidence session', () => {
  assert.equal(validateSession(session()).valid, true);
  const invalid = session();
  invalid.jobs[0].requirements[0].compatibility = 'maybe';
  assert.equal(validateSession(invalid).valid, false);
});

test('keeps a date-only closing deadline active for the whole Auckland day', () => {
  const job = activeJob({ dateEvidence: { ...activeJob().dateEvidence, closesAt: [observation('2026-09-01')] } });
  assert.equal(classifyVerification(job, session().preferences, new Date('2026-09-01T23:59:59+12:00')).status, 'verified-active');
  assert.equal(classifyVerification(job, session().preferences, new Date('2026-09-02T00:00:01+12:00')).status, 'closed');
});

test('treats conflicting date evidence as unverified', () => {
  const job = activeJob({ dateEvidence: {
    ...activeJob().dateEvidence,
    closesAt: [observation('2026-09-18'), observation('2026-09-25', 'https://ats.example.com/NZ-101')],
  } });
  const result = classifyVerification(job, session().preferences, new Date('2026-09-01T10:00:00+12:00'));
  assert.equal(result.status, 'unverified');
  assert.match(result.reasons.join('\n'), /conflicting evidence/);
});

test('recognises a full-time fixed-term summer internship as practically compatible', () => {
  const result = scorePracticalFit(candidate, session().preferences, activeJob());
  assert.equal(result.blockers.length, 0);
  assert.match(result.positives.join('\n'), /availability window/);
});

test('blocks a hard eligibility requirement that is not met', () => {
  const job = activeJob({ requirements: [{ category: 'export-control', text: 'Must satisfy ITAR citizenship rules', strength: 'hard', compatibility: 'not-met' }] });
  const report = buildReport(session([job]), { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(report.incompatible.length, 1);
  assert.match(report.incompatible[0].practicalFit.blockers.join('\n'), /ITAR/);
});

test('derives partial coverage from attempts rather than accepting a claimed status', () => {
  const result = deriveSearchCoverage({
    status: 'complete',
    searchFamilies: ['software testing', 'Java backend'],
    attempts: [
      { roleFamily: 'software testing', source: 'Employer careers', query: 'test', status: 'searched' },
      { roleFamily: 'Java backend', source: 'SEEK public page', query: 'java', status: 'blocked' },
    ],
  }, []);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.unsearchedFamilies, ['Java backend']);
});

test('separates high-value unverified leads from verified recommendations', () => {
  const job = activeJob({ verificationEvidence: { ...activeJob().verificationEvidence, detailPageOpened: false } });
  const report = buildReport(session([job]), { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(report.recommended.length, 0);
  assert.equal(report.manualVerification.length, 1);
});

test('lists recruitment programmes separately from job recommendations', () => {
  const opportunity = {
    kind: 'programme', title: 'Candidate Meet and Greet', organisation: 'Summer Programme',
    url: 'https://programme.example.nz/event', registrationStatus: 'conditional',
    audience: 'Candidates already registered for the programme',
    conditions: 'Attendance is limited to accepted candidates',
    verificationEvidence: { detailPageOpened: true, applyRouteAvailable: false, expiredIndicatorVisible: false, unavailableIndicatorVisible: false, verifiedAt },
  };
  const report = buildReport(session([], { leads: [], relatedOpportunities: [opportunity] }), { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(report.relatedOpportunities[0].status, 'conditional');
  assert.equal(report.recommended.length, 0);
  assert.match(renderMarkdown(report), /never counted as job recommendations/);
});

test('does not treat Java as JavaScript evidence', () => {
  const job = activeJob({ requiredSkills: ['JavaScript'], roleFamilies: ['frontend engineering'], responsibilityAreas: ['frontend development'] });
  const report = buildReport(session([job]), { now: '2026-09-01T10:00:00+12:00' });
  const assessed = [...report.recommended, ...report.stretch, ...report.lowFit, ...report.otherUnverified][0];
  assert.doesNotMatch(assessed.roleFit.evidence.join('\n'), /JavaScript: supported by Java/);
});

test('renders the evidence funnel and direct vacancy evidence', () => {
  const markdown = renderMarkdown(buildReport(session(), { now: '2026-09-01T10:00:00+12:00' }));
  assert.match(markdown, /## Verified recommendations/);
  assert.match(markdown, /### Search attempts/);
  assert.match(markdown, /Leads discovered/);
  assert.match(markdown, /Programme: internship; contract: fixed-term; workload: full-time/);
});

test('appends new jobs, suppresses unchanged jobs, and re-reports changed state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-history-'));
  const input = join(folder, 'session.json');
  const output = join(folder, 'nz-jobs-2026-09-01.md');
  await writeFile(input, JSON.stringify(session()), 'utf8');
  assert.equal((await writeReport(input, output, { now: '2026-09-01T10:00:00+12:00' })).writeAction, 'created');
  assert.equal((await writeReport(input, output, { now: '2026-09-01T12:00:00+12:00' })).writeAction, 'unchanged');

  const changed = activeJob({ dateEvidence: { ...activeJob().dateEvidence, closesAt: [observation('2026-10-05')] } });
  await writeFile(input, JSON.stringify(session([changed])), 'utf8');
  const update = await writeReport(input, output, { now: '2026-09-01T14:00:00+12:00' });
  const markdown = await readFile(output, 'utf8');
  assert.equal(update.writeAction, 'appended');
  assert.equal(update.updatedListingsCount, 1);
  assert.match(markdown, /Updated evidence/);
  assert.match(markdown, /2026-10-05/);
});

test('excludes unchanged roles from earlier daily reports', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-next-day-'));
  const input = join(folder, 'session.json');
  await writeFile(input, JSON.stringify(session()), 'utf8');
  await writeReport(input, join(folder, 'nz-jobs-2026-09-01.md'), { now: '2026-09-01T10:00:00+12:00' });
  const result = await writeReport(input, join(folder, 'nz-jobs-2026-09-02.md'), { now: '2026-09-02T09:00:00+12:00' });
  assert.equal(result.excludedPreviouslyReported, 1);
  assert.equal(result.newListingsCount, 0);
});
