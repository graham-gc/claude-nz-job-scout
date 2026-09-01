export type EmploymentType =
  | 'internship'
  | 'part-time'
  | 'full-time'
  | 'fixed-term'
  | 'contract'
  | 'casual';

export type WorkArrangement = 'on-site' | 'hybrid' | 'remote';
export type SkillLevel = 'core' | 'frequent' | 'working' | 'exposure';
export type VerificationStatus = 'verified-active' | 'expired' | 'unavailable' | 'unverified';

export interface CandidateSkill {
  name: string;
  level: SkillLevel;
  years?: number;
  lastUsedYear?: number;
  evidence?: string[];
}

export interface CandidateProfile {
  name?: string;
  targetRoleFamilies: string[];
  employmentTypes: EmploymentType[];
  locations: string[];
  workArrangements: WorkArrangement[];
  availability?: string;
  workRights?: string;
  domains: string[];
  skills: CandidateSkill[];
}

export interface SearchPreferences {
  mode: 'profile' | 'criteria' | 'combined';
  keywords?: string[];
  maxPostingAgeDays: number;
  employmentTypes: EmploymentType[];
  locations: string[];
  workArrangements: WorkArrangement[];
  includeUnverified: boolean;
}

export interface JobPosting {
  source: string;
  sourceUrl: string;
  applicationUrl?: string;
  requisitionId?: string;
  title: string;
  employer: string;
  location: string;
  workArrangement?: WorkArrangement;
  employmentType?: EmploymentType;
  postedAt?: string;
  closesAt?: string;
  summary?: string;
  requiredSkills: string[];
  preferredSkills: string[];
}

export interface VerificationEvidence {
  detailPageOpened: boolean;
  applyRouteAvailable: boolean;
  expiredIndicatorVisible: boolean;
  unavailableIndicatorVisible: boolean;
  verifiedAt: string;
  notes?: string[];
}

export interface VerifiedJobPosting extends JobPosting {
  verificationStatus: VerificationStatus;
  verificationEvidence: VerificationEvidence;
}

export interface ScoreBreakdown {
  score: number;
  reasons: string[];
  gaps: string[];
  blockers: string[];
}

export interface JobAssessment {
  job: VerifiedJobPosting;
  roleFit: ScoreBreakdown;
  practicalFit: ScoreBreakdown;
}

export interface JobReport {
  generatedAt: string;
  criteria: SearchPreferences;
  assumptions: string[];
  recommended: JobAssessment[];
  rejected: Array<{
    job: VerifiedJobPosting;
    reason: string;
  }>;
}
