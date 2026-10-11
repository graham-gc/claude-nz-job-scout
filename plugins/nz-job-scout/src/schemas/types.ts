export type ApplicationRoute =
  | { method: 'online'; url: string; requiredMaterials?: string[] }
  | { method: 'email'; email: string; instructions: string; requiredMaterials?: string[] };

export interface CandidateProfile {
  summary: string[];
  roleFamilies: string[];
  locations: string[];
}

export interface SearchCriteria {
  roleFamilies: string[];
  locations: string[];
  employmentTypes: string[];
  workArrangements?: string[];
  maxPostingAgeDays: number;
}

/** Public ATS adapters only need the optional search terms and posting window. */
export interface SearchPreferences {
  maxPostingAgeDays: number;
  keywords?: string[];
}

export interface SourceCheck {
  name: string;
  url: string;
  status: 'searched' | 'blocked' | 'skipped';
  note?: string;
}

export interface JobPosting {
  title: string;
  employer: string;
  sourceUrl: string;
  location: string;
  workArrangement?: string;
  employmentType: string;
  compensation?: string;
  publishedAt: string;
  closesAt?: string;
  summary: string;
  match: { verdict: 'apply' | 'consider'; strengths: string[]; concern?: string };
  application: ApplicationRoute;
  verifiedAt: string;
}

export interface ScoutSession {
  pluginVersion: string;
  sessionSchemaVersion: number;
  resumeFingerprint?: string;
  candidate: CandidateProfile;
  criteria: SearchCriteria;
  sources: SourceCheck[];
  jobs: JobPosting[];
}
