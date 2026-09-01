import type {
  CandidateProfile,
  CandidateSkill,
  ScoreBreakdown,
  SearchPreferences,
  VerifiedJobPosting,
} from '../schemas/types.js';

const SKILL_WEIGHTS: Record<CandidateSkill['level'], number> = {
  core: 1,
  frequent: 0.85,
  working: 0.6,
  exposure: 0.25,
};

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]/g, '');
}

function skillIndex(profile: CandidateProfile): Map<string, CandidateSkill> {
  return new Map([...profile.skills, ...profile.capabilities].map((item) => [normalise(item.name), item]));
}

function rounded(value: number): number {
  return Math.round(Math.max(0, Math.min(10, value)) * 10) / 10;
}

export function scoreRoleFit(
  profile: CandidateProfile,
  job: VerifiedJobPosting,
): ScoreBreakdown {
  const index = skillIndex(profile);
  const reasons: string[] = [];
  const gaps: string[] = [];

  const required = job.requiredSkills.map((name) => ({ name, skill: index.get(normalise(name)) }));
  const preferred = job.preferredSkills.map((name) => ({ name, skill: index.get(normalise(name)) }));
  const responsibilities = job.responsibilityAreas.map((name) => ({
    name,
    skill: index.get(normalise(name)),
  }));

  const requiredScore = required.length
    ? required.reduce((sum, item) => sum + (item.skill ? SKILL_WEIGHTS[item.skill.level] : 0), 0) /
      required.length
    : 0.7;
  const preferredScore = preferred.length
    ? preferred.reduce((sum, item) => sum + (item.skill ? SKILL_WEIGHTS[item.skill.level] : 0), 0) /
      preferred.length
    : requiredScore;
  const responsibilityScore = responsibilities.length
    ? responsibilities.reduce((sum, item) => sum + (item.skill ? SKILL_WEIGHTS[item.skill.level] : 0), 0) /
      responsibilities.length
    : 0.45;

  for (const item of required) {
    if (!item.skill) gaps.push(`No evidence for required skill: ${item.name}`);
    else if (item.skill.level === 'exposure') gaps.push(`${item.name} is exposure-level only`);
    else reasons.push(`${item.name}: ${item.skill.level}`);
  }

  const domainText = [...job.domains, ...job.roleFamilies, job.title, job.summary ?? ''].join(' ').toLowerCase();
  const domainMatch = [...profile.domains, ...profile.targetRoleFamilies].some((domain) =>
    domainText.includes(domain.toLowerCase()),
  );
  if (domainMatch) reasons.push('Relevant domain experience');
  for (const item of responsibilities) {
    if (item.skill) reasons.push(`${item.name}: supported by ${item.skill.name} (${item.skill.level})`);
  }

  return {
    score: rounded(requiredScore * 4 + preferredScore + responsibilityScore * 3.5 + (domainMatch ? 1.5 : 0.5)),
    reasons,
    gaps,
    blockers: [],
    cautions: required.length ? [] : ['No concrete required technologies were stated'],
  };
}

export function scorePracticalFit(
  profile: CandidateProfile,
  preferences: SearchPreferences,
  job: VerifiedJobPosting,
): ScoreBreakdown {
  const reasons: string[] = [];
  const gaps: string[] = [];
  const blockers: string[] = [];
  const cautions: string[] = [];
  let score = 0;

  if (job.verificationStatus !== 'verified-active') {
    blockers.push(`Listing is ${job.verificationStatus}`);
    score = 0;
  }

  if (job.employmentType && !preferences.employmentTypes.includes(job.employmentType)) {
    blockers.push(`Employment type is ${job.employmentType}`);
  } else if (job.employmentType) {
    reasons.push(`Employment type matches: ${job.employmentType}`);
    score += 2;
  } else {
    gaps.push('Employment type not stated');
    score += 0.75;
  }

  const locationMatch = preferences.locations.some((location) =>
    job.location.toLowerCase().includes(location.toLowerCase()),
  );
  if (!locationMatch && job.workArrangement !== 'remote') {
    blockers.push(`Location does not match: ${job.location}`);
  } else {
    reasons.push(`Location/work arrangement is acceptable: ${job.location}`);
    score += 2;
  }

  if (job.availabilityCompatible === true) {
    reasons.push('Availability appears compatible');
    score += 2;
  } else if (job.availabilityCompatible === false) blockers.push('Availability is incompatible');
  else cautions.push('Availability compatibility was not verified');

  if (job.workRightsCompatible === true) {
    reasons.push('Work rights appear compatible');
    score += 2;
  } else if (job.workRightsCompatible === false) blockers.push('Work rights are incompatible');
  else cautions.push('Work-right compatibility was not verified');

  if (job.eligibilityCompatible === true) {
    reasons.push('Eligibility appears compatible');
    score += 2;
  } else if (job.eligibilityCompatible === false) blockers.push('Eligibility is incompatible');
  else cautions.push('Eligibility compatibility was not verified');

  return { score: rounded(score), reasons, gaps, blockers, cautions };
}
