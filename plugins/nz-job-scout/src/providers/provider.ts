import type { JobPosting, SearchPreferences, VerificationEvidence } from '../schemas/types.js';

export interface ProviderSearchContext {
  preferences: SearchPreferences;
  candidateKeywords: string[];
}

export interface BrowserSearchProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  authenticatedSessionSupported: boolean;
  search(context: ProviderSearchContext): Promise<JobPosting[]>;
  verify(job: JobPosting): Promise<VerificationEvidence>;
}

export const providerCatalogue = [
  {
    id: 'seek-nz',
    displayName: 'SEEK New Zealand',
    baseUrl: 'https://www.seek.co.nz',
    authenticatedSessionSupported: true,
  },
  {
    id: 'linkedin-jobs',
    displayName: 'LinkedIn Jobs',
    baseUrl: 'https://www.linkedin.com/jobs',
    authenticatedSessionSupported: true,
  },
  {
    id: 'trademe-jobs',
    displayName: 'Trade Me Jobs',
    baseUrl: 'https://www.trademe.co.nz/a/jobs',
    authenticatedSessionSupported: true,
  },
] as const;
