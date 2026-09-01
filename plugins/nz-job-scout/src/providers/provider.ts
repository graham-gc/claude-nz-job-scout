import type { JobPosting, SearchPreferences, VerificationEvidence } from '../schemas/types.js';

export interface ProviderSearchContext {
  preferences: SearchPreferences;
  candidateKeywords: string[];
}

export interface PublicSearchProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  publicAccessOnly: true;
  search(context: ProviderSearchContext): Promise<JobPosting[]>;
  verify(job: JobPosting): Promise<VerificationEvidence>;
}

/** Discovery adapters use public pages and public ATS data only. */

export const providerCatalogue = [
  {
    id: 'greenhouse',
    displayName: 'Greenhouse job boards',
    baseUrl: 'https://boards.greenhouse.io',
    publicAccessOnly: true,
  },
  {
    id: 'lever',
    displayName: 'Lever job boards',
    baseUrl: 'https://jobs.lever.co',
    publicAccessOnly: true,
  },
  {
    id: 'smartrecruiters',
    displayName: 'SmartRecruiters job boards',
    baseUrl: 'https://jobs.smartrecruiters.com',
    publicAccessOnly: true,
  },
  {
    id: 'workday',
    displayName: 'Public Workday career sites',
    baseUrl: 'https://myworkdayjobs.com',
    publicAccessOnly: true,
  },
] as const;
