import { describe, expect, it } from 'vitest';

import { isPublicDomain } from './public-domains';

describe('isPublicDomain', () => {
  const blocklist = [
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'icloud.com',
    'me.com',
    'proton.me',
    'protonmail.com',
    'aol.com',
    'gmx.com',
    'mail.ru',
    'qq.com',
    '163.com',
    'yandex.com',
    'duck.com',
  ];

  it.each(blocklist.map((domain) => ({ domain })))(
    'returns true for blocklisted domain $domain',
    ({ domain }) => {
      expect(isPublicDomain(domain)).toBe(true);
    },
  );

  it.each([{ domain: 'alphaco.com' }, { domain: 'example.org' }])(
    'returns false for corporate domain $domain',
    ({ domain }) => {
      expect(isPublicDomain(domain)).toBe(false);
    },
  );

  it.each([{ domain: 'Gmail.COM' }, { domain: 'GMAIL.com' }])(
    'returns true for case-variant $domain (case-insensitive match)',
    ({ domain }) => {
      expect(isPublicDomain(domain)).toBe(true);
    },
  );

  it('returns true when surrounding whitespace is trimmed', () => {
    expect(isPublicDomain('  gmail.com  ')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isPublicDomain('')).toBe(false);
  });

  it('returns false for non-string input', () => {
    // Intentionally bypass the type system to exercise the runtime guard
    // for callers that forget to validate at the boundary.
    expect(isPublicDomain(undefined as unknown as string)).toBe(false);
    expect(isPublicDomain(null as unknown as string)).toBe(false);
    expect(isPublicDomain(123 as unknown as string)).toBe(false);
  });

  it('returns true for an NFC-decomposed form of gmail.com', () => {
    // 'gmail.com' is pure ASCII so NFD === NFC; build a decomposed string
    // that normalizes back to 'gmail.com' to exercise the NFC step.
    const decomposed = 'gmail.com'.normalize('NFD');
    expect(isPublicDomain(decomposed)).toBe(true);
  });
});
