import { describe, expect, it } from 'vitest';
import { scoreRoleFit } from '../src/matching/score.js';
import type { CandidateProfile, VerifiedJobPosting } from '../src/schemas/types.js';

const job: VerifiedJobPosting = {
  source: 'SEEK',
  sourceUrl: 'https://example.test/job/1',
  title: 'Java Automation Engineer',
  employer: 'Example Ltd',
  location: 'Auckland',
  employmentType: 'internship',
  requiredSkills: ['Java', 'Spring Boot'],
  preferredSkills: ['SQL'],
  verificationStatus: 'verified-active',
  verificationEvidence: {
    detailPageOpened: true,
    applyRouteAvailable: true,
    expiredIndicatorVisible: false,
    unavailableIndicatorVisible: false,
    verifiedAt: '2026-08-31T12:00:00+12:00',
  },
};

function profile(javaLevel: 'core' | 'exposure'): CandidateProfile {
  return {
    targetRoleFamilies: ['Software Engineer in Test'],
    employmentTypes: ['internship'],
    locations: ['Auckland'],
    workArrangements: ['on-site', 'hybrid'],
    domains: ['test automation'],
    skills: [
      { name: 'Java', level: javaLevel },
      { name: 'Spring Boot', level: 'frequent' },
      { name: 'SQL', level: 'frequent' },
    ],
  };
}

describe('scoreRoleFit', () => {
  it('rewards demonstrated depth over keyword-only exposure', () => {
    const core = scoreRoleFit(profile('core'), job);
    const exposure = scoreRoleFit(profile('exposure'), job);

    expect(core.score).toBeGreaterThan(exposure.score);
    expect(exposure.gaps).toContain('Java is exposure-level only');
  });
});
