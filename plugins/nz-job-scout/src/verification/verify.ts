import type {
  JobPosting,
  VerificationEvidence,
  VerificationStatus,
  VerifiedJobPosting,
} from '../schemas/types.js';

export function classifyVerification(evidence: VerificationEvidence): VerificationStatus {
  if (evidence.expiredIndicatorVisible) return 'expired';
  if (evidence.unavailableIndicatorVisible) return 'unavailable';
  if (evidence.detailPageOpened && evidence.applyRouteAvailable) return 'verified-active';
  return 'unverified';
}

export function attachVerification(
  job: JobPosting,
  evidence: VerificationEvidence,
): VerifiedJobPosting {
  return {
    ...job,
    verificationStatus: classifyVerification(evidence),
    verificationEvidence: evidence,
  };
}

export function isWithinPostingWindow(
  postedAt: string | undefined,
  maxAgeDays: number,
  now = new Date(),
): boolean {
  if (!postedAt) return false;
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) return false;
  const ageMs = now.getTime() - posted.getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export function normaliseUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(ref|source|tracking|trk|utm_)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  return parsed.toString();
}
