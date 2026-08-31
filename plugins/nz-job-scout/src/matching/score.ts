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
  return new Map(profile.skills.map((skill) => [normalise(skill.name), skill]));
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

  const requiredScore = required.length
    ? required.reduce((sum, item) => sum + (item.skill ? SKILL_WEIGHTS[item.skill.level] : 0), 0) /
      required.length
    : 0.7;
  const preferredScore = preferred.length
    ? preferred.reduce((sum, item) => sum + (item.skill ? SKILL_WEIGHTS[item.skill.level] : 0), 0) /
      preferred.length
    : requiredScore;

  for (const item of required) {
    if (!item.skill) gaps.push(`No evidence for required skill: ${item.name}`);
    else if (item.skill.level === 'exposure') gaps.push(`${item.name} is exposure-level only`);
    else reasons.push(`${item.name}: ${item.skill.level}`);
  }

  const domainText = `${job.title} ${job.summary ?? ''}`.toLowerCase();
  const domainMatch = profile.domains.some((domain) => domainText.includes(domain.toLowerCase()));
  if (domainMatch) reasons.push('Relevant domain experience');

  return {
    score: rounded((requiredScore * 0.75 + preferredScore * 0.15 + (domainMatch ? 0.1 : 0.05)) * 10),
    reasons,
    gaps,
    blockers: [],
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
  let score = 10;

  if (job.verificationStatus !== 'verified-active') {
    blockers.push(`Listing is ${job.verificationStatus}`);
    score = 0;
  }

  if (job.employmentType && !preferences.employmentTypes.includes(job.employmentType)) {
    blockers.push(`Employment type is ${job.employmentType}`);
    score -= 5;
  } else if (job.employmentType) {
    reasons.push(`Employment type matches: ${job.employmentType}`);
  } else {
    gaps.push('Employment type not stated');
    score -= 1;
  }

  const locationMatch = preferences.locations.some((location) =>
    job.location.toLowerCase().includes(location.toLowerCase()),
  );
  if (!locationMatch && job.workArrangement !== 'remote') {
    blockers.push(`Location does not match: ${job.location}`);
    score -= 4;
  } else {
    reasons.push(`Location/work arrangement is acceptable: ${job.location}`);
  }

  if (profile.workRights) reasons.push(`Work rights to confirm: ${profile.workRights}`);

  return { score: rounded(score), reasons, gaps, blockers };
}
