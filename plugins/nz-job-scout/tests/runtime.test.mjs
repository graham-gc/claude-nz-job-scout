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
  resolveReportOutput,
  scorePracticalFit,
  scoreRoleFit,
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
    validUntil: '2027-12-31', visaType: 'Student Visa', evidenceSource: 'user-explicit',
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
    detailPageOpened: true, status: 'assessed', employerExpansionRequired: false,
    priority: 'normal', directSourceStatus: 'found',
    employerExpansionReason: 'The lead came from an employer inventory already inspected in this run', ...overrides,
  };
}

function session(jobs = [activeJob()], overrides = {}) {
  const leads = jobs.map((job) => leadFor(job));
  return {
    pluginVersion: '0.6.0',
    sessionSchemaVersion: 3,
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
      searchFamilies: ['software test engineering', 'Java backend', 'software support'],
      explicitSearchFamilies: ['software support'],
      programmeFirstRequired: true,
      sourceTargets: [
        { name: 'Public board discovery', purpose: 'board-discovery', status: 'searched', url: 'https://jobs.example.nz/search', inventoryScope: 'search-results', itemUrls: ['https://jobs.example.nz/1'], itemsInspected: 1, requiredForCoverage: true },
        { name: 'Auckland student programme inventory', purpose: 'programme-inventory', status: 'searched', url: 'https://careers.example.nz/students', inventoryScope: 'listing-page', itemUrls: ['https://careers.example.nz/students/1'], itemsInspected: 1, requiredForCoverage: true },
        { name: 'Example Engineering ATS inventory', purpose: 'employer-ats', employer: 'Example Engineering', status: 'searched', url: 'https://careers.example.com/jobs', inventoryScope: 'ats-board', itemUrls: ['https://careers.example.com/jobs/NZ-101'], itemsInspected: 1, requiredForCoverage: true },
      ],
      attempts: [
        { roleFamily: 'student technology programmes', strategy: 'programme-discovery', source: 'Public programme inventories', query: 'Auckland internship and student technology opportunities', status: 'searched', leadsDiscovered: leads.length, detailPagesOpened: leads.length },
        { roleFamily: 'software test engineering', strategy: 'broad-discovery', source: 'Web search', query: 'software testing intern Auckland', status: 'searched', leadsDiscovered: leads.length, detailPagesOpened: leads.length },
        { roleFamily: 'software test engineering', strategy: 'source-inventory', source: 'Employer careers', query: 'Example Engineering current vacancies', status: 'searched', leadsDiscovered: leads.length, detailPagesOpened: leads.length },
        { roleFamily: 'Java backend', strategy: 'broad-discovery', source: 'Web search', query: 'backend intern Auckland', status: 'searched', leadsDiscovered: 0, detailPagesOpened: 0 },
        { roleFamily: 'Java backend', strategy: 'source-inventory', source: 'Public ATS', query: 'Auckland software internship vacancies', status: 'searched', leadsDiscovered: 0, detailPagesOpened: 0 },
        { roleFamily: 'software support', strategy: 'broad-discovery', source: 'Web search', query: 'technology services intern Auckland', status: 'searched', leadsDiscovered: 0, detailPagesOpened: 0 },
        { roleFamily: 'software support', strategy: 'source-inventory', source: 'Public ATS', query: 'Auckland technology and digital services vacancies', status: 'searched', leadsDiscovered: 0, detailPagesOpened: 0 },
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

test('rejects stale sessions and incomplete programme-first plans', () => {
  const stale = session();
  stale.pluginVersion = '0.5.1';
  assert.match(validateSession(stale).errors.join('\n'), /pluginVersion must be 0\.6\.0/);

  const missingProgrammePlan = session();
  missingProgrammePlan.searchCoverage.sourceTargets = missingProgrammePlan.searchCoverage.sourceTargets.filter((target) => target.purpose !== 'programme-inventory');
  missingProgrammePlan.searchCoverage.attempts = missingProgrammePlan.searchCoverage.attempts.filter((attempt) => attempt.strategy !== 'programme-discovery');
  assert.match(validateSession(missingProgrammePlan).errors.join('\n'), /programme-inventory source target/);
});

test('preserves explicit role families and detects omission', () => {
  const invalid = session();
  invalid.searchCoverage.searchFamilies = invalid.searchCoverage.searchFamilies.filter((family) => family !== 'software support');
  assert.match(validateSession(invalid).errors.join('\n'), /Explicit search family is missing/);
});

test('requires the baseline public-source plan', () => {
  const invalid = session();
  invalid.searchCoverage.sourceTargets = invalid.searchCoverage.sourceTargets.filter((target) => target.purpose !== 'employer-ats');
  assert.match(validateSession(invalid).errors.join('\n'), /needs an employer-ats target/);
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
      { roleFamily: 'software testing', strategy: 'broad-discovery', source: 'Employer careers', query: 'test', status: 'searched' },
      { roleFamily: 'software testing', strategy: 'source-inventory', source: 'Employer careers', query: 'test inventory', status: 'searched' },
      { roleFamily: 'Java backend', strategy: 'source-inventory', source: 'SEEK public page', query: 'java', status: 'blocked' },
    ],
  }, []);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.unsearchedFamilies, ['Java backend']);
});

test('does not call one broad query per family complete coverage', () => {
  const result = deriveSearchCoverage({
    searchFamilies: ['software testing'],
    attempts: [
      { roleFamily: 'software testing', strategy: 'broad-discovery', source: 'Web search', query: 'software testing intern Auckland', status: 'searched' },
    ],
  }, []);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingSourceInventoryFamilies, ['software testing']);
});

test('programme-first coverage is partial without the generic programme pass', () => {
  const coverage = structuredClone(session().searchCoverage);
  coverage.attempts = coverage.attempts.filter((attempt) => attempt.strategy !== 'programme-discovery');
  const result = deriveSearchCoverage(coverage, []);
  assert.equal(result.status, 'partial');
  assert.equal(result.missingProgrammeDiscovery, true);
});

test('marks coverage partial when a required planned source was not completed', () => {
  const result = deriveSearchCoverage({
    searchFamilies: ['software testing'],
    sourceTargets: [
      { name: 'Public board discovery', purpose: 'board-discovery', status: 'searched', requiredForCoverage: true },
      { name: 'Employer ATS inventory', purpose: 'employer-ats', status: 'blocked', requiredForCoverage: true },
    ],
    attempts: [
      { roleFamily: 'software testing', strategy: 'broad-discovery', source: 'Web search', query: 'software testing intern Auckland', status: 'searched' },
      { roleFamily: 'software testing', strategy: 'source-inventory', source: 'Employer careers', query: 'testing internship vacancies', status: 'searched' },
    ],
  }, []);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingRequiredSourceTargets, ['Employer ATS inventory']);
});

test('requires expansion of a relevant employer discovered outside its inventory', () => {
  const lead = leadFor(activeJob(), {
    employer: 'Aderant',
    employerExpansionRequired: true,
    employerExpansionReason: 'A related role was discovered on a public job board',
  });
  const coverage = {
    searchFamilies: ['software test engineering'],
    attempts: [
      { roleFamily: 'software test engineering', strategy: 'broad-discovery', source: 'Web search', query: 'software testing intern Auckland', status: 'searched' },
      { roleFamily: 'software test engineering', strategy: 'source-inventory', source: 'Public job board', query: 'Auckland testing internships', status: 'searched' },
    ],
  };
  const missing = deriveSearchCoverage(coverage, [lead]);
  assert.equal(missing.status, 'partial');
  assert.deepEqual(missing.unexpandedEmployers, ['Aderant']);

  coverage.attempts.push({
    roleFamily: 'software test engineering', strategy: 'employer-expansion', employer: 'Aderant',
    source: 'Employer careers', query: 'Aderant Auckland vacancies', status: 'searched',
  });
  assert.equal(deriveSearchCoverage(coverage, [lead]).status, 'complete');
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

test('recognises generic technology-services titles from their sustained duties', () => {
  const job = activeJob({
    title: 'Technology Services Intern',
    roleFamilies: ['technology services'],
    responsibilityAreas: ['application support', 'backend debugging', 'API test automation'],
    requiredSkills: [],
    preferredSkills: ['SQL'],
  });
  const result = scoreRoleFit(candidate, job, new Date('2026-09-01T10:00:00+12:00'));
  assert.ok(result.score >= 3, `expected generic technology-services duties to produce a viable fit, got ${result.score}`);
  assert.match(result.evidence.join('\n'), /support|troubleshooting|SQL/i);
});

test('does not verify a job-board application route as a final direct link', () => {
  const job = activeJob({
    source: 'SEEK',
    sourceUrl: 'https://www.seek.co.nz/job/12345678',
    applicationUrl: 'https://www.seek.co.nz/job/12345678/apply',
  });
  const result = classifyVerification(job, session().preferences, new Date('2026-09-01T10:00:00+12:00'));
  assert.equal(result.status, 'unverified');
  assert.match(result.reasons.join('\n'), /discovery job board/);
});

test('only permits a clearly technical volunteer role when the user requested it', () => {
  const job = activeJob({
    engagementModel: 'volunteer',
    isTechnicalVolunteer: true,
    compensation: { kind: 'unpaid' },
  });
  const withoutPermission = scorePracticalFit(candidate, session().preferences, job);
  assert.match(withoutPermission.blockers.join('\n'), /not requested/);

  const preferences = { ...session().preferences, includeTechnicalVolunteer: true };
  const withPermission = scorePracticalFit(candidate, preferences, job);
  assert.equal(withPermission.blockers.length, 0);
  assert.match(withPermission.positives.join('\n'), /technical volunteer/);
});

test('blocks a role whose required core technology is explicitly excluded', () => {
  const job = activeJob({ requiredSkills: ['C#/.NET'] });
  const preferences = {
    ...session().preferences,
    constraints: [...session().preferences.constraints, {
      field: 'excludeCoreSkill', value: 'C#/.NET', strength: 'hard', source: 'user-explicit',
    }],
  };
  const result = scorePracticalFit(candidate, preferences, job);
  assert.match(result.blockers.join('\n'), /explicit core-technology exclusion/);
});

test('renders the evidence funnel and direct vacancy evidence', () => {
  const markdown = renderMarkdown(buildReport(session(), { now: '2026-09-01T10:00:00+12:00' }));
  assert.match(markdown, /## Verified recommendations/);
  assert.match(markdown, /### Search attempts/);
  assert.match(markdown, /Leads discovered/);
  assert.match(markdown, /Programme: internship; contract: fixed-term; workload: full-time/);
  assert.match(markdown, /Plugin version: 0\.6\.0/);
  assert.match(markdown, /Session schema: 3/);
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

test('defaults reports to the project output directory and guards custom locations', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-output-'));
  assert.equal(
    resolveReportOutput(undefined, { cwd: folder, now: '2026-10-06T14:00:00+13:00' }),
    join(folder, 'output', 'nz-jobs-2026-10-06.md'),
  );
  assert.throws(
    () => resolveReportOutput('nz-jobs-2026-10-06.md', { cwd: folder, now: '2026-10-06T14:00:00+13:00' }),
    /must be inside/,
  );
  assert.equal(
    resolveReportOutput('custom/report.md', { cwd: folder, allowCustomOutput: true }),
    join(folder, 'custom', 'report.md'),
  );
});

test('rejects a shared vacancy URL assigned to different roles', () => {
  const first = activeJob();
  const second = activeJob({ requisitionId: 'NZ-202', title: 'Backend Engineer Intern' });
  const invalid = session([first, second]);
  assert.match(validateSession(invalid).errors.join('\n'), /reuses .* for a different employer\/title/);
});

test('requires every assessed lead to have a matching evidence record', () => {
  const invalid = session([], { leads: [leadFor(activeJob())] });
  assert.match(validateSession(invalid).errors.join('\n'), /assessed but has no matching jobs\[\] evidence record/);
});

test('keeps unresolved high-priority leads visible for manual verification', () => {
  const lead = leadFor(activeJob(), {
    status: 'blocked', detailPageOpened: false, priority: 'high', directSourceStatus: 'not-found',
    reason: 'The discovery page was visible but no primary vacancy page could be found',
  });
  const report = buildReport(session([], { leads: [lead] }), { now: '2026-09-01T10:00:00+12:00' });
  assert.equal(report.unresolvedHighValueLeads.length, 1);
  assert.match(renderMarkdown(report), /The discovery page was visible/);
});

test('rejects aggregator employer inventories and fake programme inventories', () => {
  const aggregator = session();
  aggregator.searchCoverage.sourceTargets[2].url = 'https://omnijobs.io/jobs/example';
  assert.match(validateSession(aggregator).errors.join('\n'), /public employer or ATS inventory/);

  const eventPage = session();
  eventPage.searchCoverage.sourceTargets[1].inventoryScope = 'event-page';
  assert.match(validateSession(eventPage).errors.join('\n'), /cannot use a event-page as a programme inventory/);
});

test('requires inspected inventory items to be individually evidenced', () => {
  const invalid = session();
  invalid.searchCoverage.sourceTargets[0].itemsInspected = 2;
  assert.match(validateSession(invalid).errors.join('\n'), /itemsInspected must equal itemUrls.length/);
});

test('rejects unsupported unrestricted or post-study work-right assumptions', () => {
  const invalid = session();
  invalid.assumptions.push('Post-graduation work rights apply from November.');
  assert.match(validateSession(invalid).errors.join('\n'), /without explicit evidence/);

  const evidenced = session();
  evidenced.candidate.workRights = {
    country: 'New Zealand', status: 'unrestricted', unrestricted: true, evidenceSource: 'official-document',
  };
  evidenced.assumptions.push('Unrestricted work rights confirmed by an official document.');
  assert.equal(validateSession(evidenced).valid, true);
});

test('project state permanently excludes a decided role from output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-state-'));
  const input = join(folder, 'session.json');
  const output = join(folder, 'nz-jobs-2026-09-01.md');
  await writeFile(input, JSON.stringify(session()), 'utf8');
  await writeFile(join(folder, '.nz-job-scout-state.json'), JSON.stringify({
    schemaVersion: 1,
    excludedRoles: [{
      employer: 'Example Engineering', requisitionId: 'NZ-101', decision: 'rejected',
      decidedAt: '2026-08-31', reason: 'Application rejected',
    }],
  }), 'utf8');
  const result = await writeReport(input, output, { now: '2026-09-01T10:00:00+12:00' });
  const markdown = await readFile(output, 'utf8');
  assert.equal(result.recommended.length, 0);
  assert.equal(result.excludedByProjectState, 2);
  assert.match(markdown, /Persistently excluded roles\/leads: 2/);
  assert.doesNotMatch(markdown, /### 1\. Software Test Engineer Intern/);
});

test('unchanged related opportunities stay suppressed when only verification time changes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nz-job-scout-opportunity-'));
  const input = join(folder, 'session.json');
  const opportunity = {
    kind: 'programme', title: 'Student Technology Programme', organisation: 'Example Programme',
    url: 'https://programme.example.nz/students', registrationStatus: 'open',
    verificationEvidence: { detailPageOpened: true, applyRouteAvailable: true, expiredIndicatorVisible: false, unavailableIndicatorVisible: false, verifiedAt },
  };
  await writeFile(input, JSON.stringify(session([], { leads: [], relatedOpportunities: [opportunity] })), 'utf8');
  await writeReport(input, join(folder, 'nz-jobs-2026-09-01.md'), { now: '2026-09-01T10:00:00+12:00' });
  opportunity.verificationEvidence.verifiedAt = '2026-09-02T09:00:00+12:00';
  await writeFile(input, JSON.stringify(session([], { leads: [], relatedOpportunities: [opportunity] })), 'utf8');
  const result = await writeReport(input, join(folder, 'nz-jobs-2026-09-02.md'), { now: '2026-09-02T10:00:00+12:00' });
  assert.equal(result.writeAction, 'created');
  assert.equal(result.relatedOpportunities.length, 0);
  assert.equal(result.excludedPreviouslyReported, 1);
});
