import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildReport, renderMarkdown, validateSession, writeReport } from '../runtime/scout.mjs';

const candidate = {
  name: 'Test Candidate',
  targetRoleFamilies: ['Software Test Engineer', 'Java Backend'],
  employmentTypes: ['internship', 'part-time'],
  locations: ['Auckland'],
  workArrangements: ['on-site', 'hybrid', 'remote'],
  domains: ['test automation'],
  skills: [
    { name: 'Java', level: 'core', years: 8, lastUsedYear: 2026 },
    { name: 'Spring Boot', level: 'frequent', years: 4, lastUsedYear: 2026 },
    { name: 'Playwright', level: 'exposure', years: 0.2, lastUsedYear: 2026 },
  ],
};

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
    employmentType: 'internship',
    engagementModel: 'employee',
    hoursPerWeek: 40,
    duringScheduledBreak: true,
    availabilityCompatible: true,
    workRightsCompatible: true,
    postedAt: '2026-08-25',
    closesAt: '2026-09-30',
    summary: 'API test automation for a Java platform',
    requiredSkills: ['Java', 'API automation'],
    preferredSkills: ['Spring Boot', 'Playwright'],
    verificationEvidence: {
      detailPageOpened: true,
      applyRouteAvailable: true,
      expiredIndicatorVisible: false,
      unavailableIndicatorVisible: false,
      verifiedAt: '2026-09-01T09:00:00+12:00',
      notes: [],
    },
    ...overrides,
  };
}

function session(jobs = [activeJob()]) {
  return {
    candidate: structuredClone(candidate),
    preferences: {
      mode: 'profile',
      maxPostingAgeDays: 30,
      employmentTypes: ['internship', 'part-time'],
      locations: ['Auckland'],
      workArrangements: ['on-site', 'hybrid', 'remote'],
      maxHoursPerWeekDuringStudy: 25,
    },
    searchCoverage: {
      status: 'complete',
      sources: [{ name: 'Employer careers site', status: 'searched', note: 'Public vacancy and application pages opened' }],
    },
    assumptions: ['Full-time hours are acceptable only during a scheduled study break.'],
    jobs,
  };
}

test('validates the evidence session contract', () => {
  assert.equal(validateSession(session()).valid, true);
  const invalid = session();
  invalid.candidate.skills[0].level = 'expert';
  assert.equal(validateSession(invalid).valid, false);
  const missingCoverage = session();
  delete missingCoverage.searchCoverage;
  assert.equal(validateSession(missingCoverage).valid, false);
  const combined = session();
  combined.preferences.mode = 'combined';
  assert.equal(validateSession(combined).valid, true);
});

test('keeps verified roles and rejects stale, aggregator, and duplicate listings', () => {
  const result = buildReport(session([
    activeJob(),
    activeJob({ sourceUrl: 'https://bebee.com/nz/job/123', applicationUrl: '', requisitionId: 'AGG-1' }),
    activeJob({ sourceUrl: 'https://nz.seek.com/job/99900002', applicationUrl: '', requisitionId: 'OLD-1', postedAt: '2026-06-01' }),
    activeJob({ sourceUrl: 'https://nz.seek.com/job/99900003' }),
  ]), { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(result.recommended.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.ok(result.recommended[0].roleFit.score > 5);
  assert.equal(result.recommended[0].practicalFit.blockers.length, 0);
});

test('renders a Markdown report with direct evidence and rejection reasons', () => {
  const result = buildReport(session(), { now: '2026-09-01T10:00:00+12:00' });
  const markdown = renderMarkdown(result);
  assert.match(markdown, /## Verified roles/);
  assert.match(markdown, /Example Engineering/);
  assert.match(markdown, /Role fit/);
  assert.match(markdown, /Pacific\/Auckland/);
});

test('labels criteria-only results without implying CV analysis', () => {
  const criteriaOnly = session();
  criteriaOnly.preferences.mode = 'criteria';
  criteriaOnly.candidate.name = 'Not supplied';
  criteriaOnly.candidate.skills = [];
  const markdown = renderMarkdown(buildReport(criteriaOnly, { now: '2026-09-01T10:00:00+12:00' }));
  assert.match(markdown, /Criteria fit/);
  assert.doesNotMatch(markdown, /CV emphasis/);
});

test('does not report no vacancies when search access was blocked', () => {
  const blocked = session([]);
  blocked.searchCoverage = {
    status: 'blocked',
    sources: [
      { name: 'Employer careers site', status: 'blocked', note: '403 from anonymous request; source skipped' },
      { name: 'Public ATS pages', status: 'unavailable', note: 'No public page could be opened' },
    ],
  };
  const markdown = renderMarkdown(buildReport(blocked, { now: '2026-09-01T10:00:00+12:00' }));
  assert.match(markdown, /Search incomplete/);
  assert.doesNotMatch(markdown, /Today there are no new qualified vacancies/);
});

test('writes the report to disk', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-'));
  const input = join(folder, 'session.json');
  const output = join(folder, 'report.md');
  await writeFile(input, JSON.stringify(session()), 'utf8');
  await writeReport(input, output, { now: '2026-09-01T10:00:00+12:00' });
  assert.match(await readFile(output, 'utf8'), /Software Test Engineer Intern/);
});

test('appends only new jobs to an existing same-day report and leaves it unchanged when there are no new jobs', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-same-day-'));
  const input = join(folder, 'session.json');
  const output = join(folder, 'nz-jobs-2026-09-01.md');
  const secondJob = activeJob({
    sourceUrl: 'https://careers.example.net/jobs/NZ-202',
    applicationUrl: 'https://careers.example.net/jobs/NZ-202/apply',
    requisitionId: 'NZ-202',
    title: 'Java Backend Intern',
    employer: 'Second Engineering',
  });

  await writeFile(input, JSON.stringify(session()), 'utf8');
  const first = await writeReport(input, output, { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(first.writeAction, 'created');
  const original = await readFile(output, 'utf8');
  const originalFirstRoleCount = original.split('Software Test Engineer Intern').length - 1;

  await writeFile(input, JSON.stringify(session([activeJob(), secondJob])), 'utf8');
  const second = await writeReport(input, output, { now: '2026-09-01T14:00:00+12:00' });
  assert.equal(second.writeAction, 'appended');
  assert.equal(second.excludedPreviouslyReported, 1);
  const updated = await readFile(output, 'utf8');
  assert.ok(updated.startsWith(original));
  assert.match(updated, /## Incremental scan/);
  assert.match(updated, /Java Backend Intern/);
  assert.equal(updated.split('Software Test Engineer Intern').length - 1, originalFirstRoleCount);

  const third = await writeReport(input, output, { now: '2026-09-01T18:00:00+12:00' });
  assert.equal(third.writeAction, 'unchanged');
  assert.equal(third.excludedPreviouslyReported, 2);
  assert.equal(await readFile(output, 'utf8'), updated);
});

test('excludes jobs from earlier daily reports when creating the next day report', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-next-day-'));
  const input = join(folder, 'session.json');
  const firstOutput = join(folder, 'nz-jobs-2026-09-01.md');
  const nextOutput = join(folder, 'nz-jobs-2026-09-02.md');
  const nextJob = activeJob({
    sourceUrl: 'https://careers.example.org/jobs/NZ-303',
    applicationUrl: 'https://careers.example.org/jobs/NZ-303/apply',
    requisitionId: 'NZ-303',
    title: 'API Automation Intern',
    employer: 'Next Day Systems',
  });

  await writeFile(input, JSON.stringify(session()), 'utf8');
  await writeReport(input, firstOutput, { now: '2026-09-01T10:00:00+12:00' });
  await writeFile(input, JSON.stringify(session([activeJob(), nextJob])), 'utf8');
  const result = await writeReport(input, nextOutput, { now: '2026-09-02T09:00:00+12:00' });
  const markdown = await readFile(nextOutput, 'utf8');

  assert.equal(result.writeAction, 'created');
  assert.equal(result.excludedPreviouslyReported, 1);
  assert.doesNotMatch(markdown, /Software Test Engineer Intern/);
  assert.match(markdown, /API Automation Intern/);
  assert.match(markdown, /Previously reported listings excluded: 1/);
});
