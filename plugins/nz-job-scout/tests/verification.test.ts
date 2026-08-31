import { describe, expect, it } from 'vitest';
import { classifyVerification, normaliseUrl } from '../src/verification/verify.js';

describe('job verification', () => {
  it('requires both a detail page and application route', () => {
    expect(
      classifyVerification({
        detailPageOpened: true,
        applyRouteAvailable: false,
        expiredIndicatorVisible: false,
        unavailableIndicatorVisible: false,
        verifiedAt: '2026-08-31T12:00:00+12:00',
      }),
    ).toBe('unverified');
  });

  it('never treats an expired page as active', () => {
    expect(
      classifyVerification({
        detailPageOpened: true,
        applyRouteAvailable: true,
        expiredIndicatorVisible: true,
        unavailableIndicatorVisible: false,
        verifiedAt: '2026-08-31T12:00:00+12:00',
      }),
    ).toBe('expired');
  });

  it('removes tracking parameters from URLs', () => {
    expect(normaliseUrl('https://example.test/job/1?utm_source=x&ref=search&id=42')).toBe(
      'https://example.test/job/1?id=42',
    );
  });
});
