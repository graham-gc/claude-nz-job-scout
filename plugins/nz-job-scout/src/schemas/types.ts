export type SkillLevel = 'core' | 'frequent' | 'working' | 'exposure';
export type WorkArrangement = 'on-site' | 'hybrid' | 'remote' | 'not-stated';
export type ProgrammeType = 'internship' | 'graduate' | 'standard' | 'not-stated';
export type ContractType = 'fixed-term' | 'permanent' | 'casual' | 'contract' | 'not-stated';
export type Workload = 'full-time' | 'part-time' | 'variable' | 'not-stated';
export type ConstraintStrength = 'hard' | 'soft';
export type ConstraintSource = 'user-explicit' | 'conversation-context' | 'resume-inferred' | 'skill-default';
export type RequirementStrength = 'hard' | 'preference';
export type Compatibility = 'met' | 'not-met' | 'unknown';
export type TechnicalRequirementStrength = 'required' | 'preferred' | 'exposure';
export type TechnicalRequirementMatch = 'any' | 'all';
export type EvidenceSourceKind = 'employer' | 'ats' | 'job-board' | 'aggregator' | 'search-result';

export interface CandidateSkill {
  name: string;
  level: SkillLevel;
  years?: number;
  lastUsedYear?: number;
  evidence?: string[];
}

export interface AvailabilityWindow {
  startAt: string;
  endAt: string;
  maxHoursPerWeek: number;
  note?: string;
}

export interface WorkRights {
  country: string;
  status: 'temporary' | 'unrestricted' | 'none';
  unrestricted: boolean;
  evidenceSource: 'user-explicit' | 'resume' | 'official-document' | 'unknown';
  validUntil?: string;
  visaType?: string;
  notes?: string[];
}

export interface CandidateProfile {
  name?: string;
  targetRoleFamilies: string[];
  locations: string[];
  workArrangements: WorkArrangement[];
  availabilityWindows: AvailabilityWindow[];
  workRights?: WorkRights;
  domains: string[];
  skills: CandidateSkill[];
  capabilities: CandidateSkill[];
  qualifications: string[];
}

export interface SearchConstraint {
  field: string;
  value: string;
  strength: ConstraintStrength;
  source: ConstraintSource;
}

export interface SearchPreferences {
  mode: 'profile' | 'criteria' | 'combined';
  keywords?: string[];
  maxPostingAgeDays: number;
  includeUnverified?: boolean;
  /** Include only explicitly technical volunteer work when the user asks for it. */
  includeTechnicalVolunteer?: boolean;
  constraints: SearchConstraint[];
  programmeTypes?: ProgrammeType[];
  contractTypes?: ContractType[];
  workloads?: Workload[];
  locations?: string[];
  workArrangements?: WorkArrangement[];
}

export interface SourceTarget {
  name: string;
  purpose: 'board-discovery' | 'programme-inventory' | 'employer-ats' | 'technical-volunteer';
  status: 'searched' | 'discovery-only' | 'blocked' | 'unavailable' | 'skipped';
  url: string;
  itemsInspected: number;
  inventoryScope: 'listing-page' | 'ats-board' | 'search-results' | 'single-detail' | 'event-page';
  itemUrls: string[];
  employer?: string;
  requiredForCoverage?: boolean;
  note?: string;
}

export interface DateObservation {
  value: string;
  sourceUrl: string;
  sourceType: 'employer' | 'ats' | 'job-board' | 'structured-data' | 'search-result' | 'legacy';
  confidence: 'high' | 'medium' | 'low';
  observedText?: string;
}

export interface JobRequirement {
  category: string;
  text: string;
  strength: RequirementStrength;
  compatibility: Compatibility;
  evidenceSource?: 'resume' | 'user-explicit' | 'official-document' | 'unknown';
  sourceUrl?: string;
}

export interface TechnicalRequirementGroup {
  label: string;
  strength: TechnicalRequirementStrength;
  match: TechnicalRequirementMatch;
  options: string[];
  sourceUrl?: string;
}

export interface JobSourceEvidence {
  name: string;
  url: string;
  kind: EvidenceSourceKind;
  detailPageOpened: boolean;
  applyRouteAvailable: boolean;
  expiredIndicatorVisible: boolean;
  unavailableIndicatorVisible: boolean;
  observedAt: string;
  applicationUrl?: string;
  requisitionId?: string;
  note?: string;
}

export interface VerificationEvidence {
  detailPageOpened: boolean;
  applyRouteAvailable: boolean;
  expiredIndicatorVisible: boolean;
  unavailableIndicatorVisible: boolean;
  verifiedAt: string;
  notes?: string[];
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
  programmeType: ProgrammeType;
  contractType: ContractType;
  workload: Workload;
  engagementModel?: string;
  /** Must be true before a volunteer role can be recommended. */
  isTechnicalVolunteer?: boolean;
  compensation?: {
    kind: 'paid' | 'unpaid' | 'reimbursed' | 'unknown';
    detail?: string;
  };
  hoursPerWeek?: number;
  summary?: string;
  roleFamilies: string[];
  responsibilityAreas: string[];
  domains: string[];
  technicalRequirements: TechnicalRequirementGroup[];
  sourceEvidence: JobSourceEvidence[];
  requirements: JobRequirement[];
  workRightsRequirement?: {
    country?: string;
    requiresCurrentRights?: boolean;
    requiresUnrestricted?: boolean;
    sponsorshipAvailable?: boolean;
  };
  dateEvidence: Partial<Record<'postedAt' | 'closesAt' | 'startAt' | 'endAt', DateObservation[]>>;
  selectionRisks?: string[];
  verificationEvidence: VerificationEvidence;
}

export interface SearchAttempt {
  roleFamily: string;
  source: string;
  query: string;
  strategy: 'programme-discovery' | 'broad-discovery' | 'source-inventory' | 'employer-expansion' | 'focused-follow-up';
  employer?: string;
  status: 'searched' | 'discovery-only' | 'blocked' | 'unavailable' | 'skipped';
  leadsDiscovered?: number;
  detailPagesOpened?: number;
  requiredForCoverage?: boolean;
  note?: string;
}

export interface SearchLead {
  title: string;
  employer: string;
  source: string;
  url: string;
  roleFamily: string;
  discoveredAt: string;
  detailPageOpened: boolean;
  status: 'assessed' | 'duplicate' | 'blocked' | 'not-opened' | 'out-of-scope' | 'previously-reported';
  priority: 'high' | 'normal' | 'low';
  directSourceStatus: 'found' | 'not-found' | 'not-checked';
  employerExpansionRequired: boolean;
  employerExpansionReason: string;
  reason?: string;
}

export interface RelatedOpportunity {
  kind: 'event' | 'programme' | 'talent-pool' | 'recruitment-channel';
  title: string;
  organisation: string;
  url: string;
  registrationStatus: 'open' | 'closed' | 'conditional' | 'unknown';
  audience?: string;
  conditions?: string;
  startsAt?: string;
  endsAt?: string;
  verificationEvidence: VerificationEvidence;
}

export interface ScoutSession {
  pluginVersion: string;
  sessionSchemaVersion: number;
  /** SHA-256 of the supplied resume file. Required in profile and combined modes. */
  resumeFingerprint?: string;
  candidate: CandidateProfile;
  preferences: SearchPreferences;
  searchCoverage: {
    searchFamilies: string[];
    explicitSearchFamilies: string[];
    programmeFirstRequired: boolean;
    attempts: SearchAttempt[];
    sourceTargets: SourceTarget[];
  };
  leads: SearchLead[];
  jobs: JobPosting[];
  relatedOpportunities: RelatedOpportunity[];
  assumptions?: string[];
}
