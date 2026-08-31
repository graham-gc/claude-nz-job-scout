import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
    source: 'SEEK',
    sourceUrl: 'https://nz.seek.com/job/99900001?tracking=test',
    applicationUrl: 'https://careers.example.com/jobs/NZ-101',
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
    assumptions: ['Full-time hours are acceptable only during a scheduled study break.'],
    jobs,
  };
}

test('validates the evidence session contract', () => {
  assert.equal(validateSession(session()).valid, true);
  const invalid = session();
  invalid.candidate.skills[0].level = 'expert';
  assert.equal(validateSession(invalid).valid, false);
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
});

test('writes the report to disk', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-'));
  const input = join(folder, 'session.json');
  const output = join(folder, 'report.md');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(input, JSON.stringify(session()), 'utf8'));
  await writeReport(input, output, { now: '2026-09-01T10:00:00+12:00' });
  assert.match(await readFile(output, 'utf8'), /Software Test Engineer Intern/);
});
