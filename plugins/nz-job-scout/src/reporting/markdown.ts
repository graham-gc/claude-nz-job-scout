import type { JobAssessment, JobReport } from '../schemas/types.js';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function bullets(items: string[], empty = 'None recorded'): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`;
}

function detailSection(assessment: JobAssessment, index: number): string {
  const { job, roleFit, practicalFit } = assessment;
  return [
    `### ${index + 1}. ${job.title} — ${job.employer}`,
    '',
    `- Location: ${job.location}`,
    `- Employment type: ${job.employmentType ?? 'Not stated'}`,
    `- Source: ${job.source}`,
    `- Verified: ${job.verificationEvidence.verifiedAt}`,
    `- Direct link: ${job.sourceUrl}`,
    '',
    `Role-fit evidence (${roleFit.score}/10):`,
    bullets(roleFit.reasons),
    '',
    'Gaps:',
    bullets(roleFit.gaps),
    '',
    `Practical-fit evidence (${practicalFit.score}/10):`,
    bullets(practicalFit.reasons),
    '',
    'Blockers:',
    bullets(practicalFit.blockers),
  ].join('\n');
}

export function renderMarkdownReport(report: JobReport): string {
  const rows = report.recommended.map(({ job, roleFit, practicalFit }) =>
    [
      escapeCell(job.title),
      escapeCell(job.employer),
      escapeCell(job.location),
      roleFit.score.toFixed(1),
      practicalFit.score.toFixed(1),
      `[Open](${job.sourceUrl})`,
    ].join(' | '),
  );

  const rejected = report.rejected.length
    ? report.rejected
        .map(({ job, reason }) => `- [${job.title} — ${job.employer}](${job.sourceUrl}): ${reason}`)
        .join('\n')
    : '- None';

  return [
    '# New Zealand Job Scout Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Search criteria',
    '',
    `- Mode: ${report.criteria.mode}`,
    `- Maximum posting age: ${report.criteria.maxPostingAgeDays} days`,
    `- Employment types: ${report.criteria.employmentTypes.join(', ')}`,
    `- Locations: ${report.criteria.locations.join(', ')}`,
    `- Work arrangements: ${report.criteria.workArrangements.join(', ')}`,
    '',
    '## Assumptions',
    '',
    bullets(report.assumptions),
    '',
    '## Verified opportunities',
    '',
    'Role | Employer | Location | Role fit | Practical fit | Link',
    '--- | --- | --- | ---: | ---: | ---',
    ...(rows.length ? rows : ['No verified opportunities found.']),
    '',
    '## Detailed assessment',
    '',
    ...(report.recommended.length
      ? report.recommended.map(detailSection).flatMap((section) => [section, ''])
      : ['No detailed assessments available.', '']),
    '## Rejected or unverified',
    '',
    rejected,
    '',
  ].join('\n');
}
