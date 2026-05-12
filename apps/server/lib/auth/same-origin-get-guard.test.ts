import { describe, expect, it } from 'vitest';
import { checkSameOriginGet, type HasHeaderGetter } from './same-origin-get-guard';

/**
 * Builds a minimal `HasHeaderGetter` from a plain header record. Keys are
 * case-insensitive (matches the contract of `Headers.get()` in Node + browser).
 */
const reqWith = (headers: Record<string, string | null>): HasHeaderGetter => ({
  headers: {
    get(name: string): string | null {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    },
  },
});

const BASE = 'https://app.tokenfx.io';

describe('checkSameOriginGet', () => {
  // ---- Sec-Fetch-Site primary signal ---------------------------------------

  it('accepts Sec-Fetch-Site=same-origin', () => {
    const result = checkSameOriginGet(reqWith({ 'sec-fetch-site': 'same-origin' }), BASE);
    expect(result).toEqual({ ok: true });
  });

  it('accepts Sec-Fetch-Site=none (typed URL or bookmark)', () => {
    const result = checkSameOriginGet(reqWith({ 'sec-fetch-site': 'none' }), BASE);
    expect(result).toEqual({ ok: true });
  });

  it('rejects Sec-Fetch-Site=cross-site', () => {
    const result = checkSameOriginGet(reqWith({ 'sec-fetch-site': 'cross-site' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'cross-site' });
  });

  it('rejects Sec-Fetch-Site=same-site (single-subdomain hardening)', () => {
    const result = checkSameOriginGet(reqWith({ 'sec-fetch-site': 'same-site' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'same-site-rejected' });
  });

  // ---- Fallback path (no Sec-Fetch-Site) ----------------------------------

  it('accepts when Sec-Fetch-Site is absent and Origin equals baseUrl (URL.origin exact equality)', () => {
    const result = checkSameOriginGet(reqWith({ origin: BASE }), BASE);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when Sec-Fetch-Site is absent and Origin is the literal string "null"', () => {
    const result = checkSameOriginGet(reqWith({ origin: 'null' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'null-origin' });
  });

  it('rejects when Sec-Fetch-Site is absent and Origin is a different origin', () => {
    const result = checkSameOriginGet(reqWith({ origin: 'https://evil.example.com' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'cross-origin' });
  });

  it('accepts when Sec-Fetch-Site is absent, Origin is absent, but Referer.origin equals baseUrl', () => {
    const result = checkSameOriginGet(
      reqWith({ referer: 'https://app.tokenfx.io/manager/audit-log' }),
      BASE,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects when Sec-Fetch-Site is absent, Origin is absent, and Referer is a different origin', () => {
    const result = checkSameOriginGet(
      reqWith({ referer: 'https://evil.example.com/page' }),
      BASE,
    );
    expect(result).toEqual({ ok: false, reason: 'cross-origin' });
  });

  it('rejects when Sec-Fetch-Site, Origin, and Referer are all absent', () => {
    const result = checkSameOriginGet(reqWith({}), BASE);
    expect(result).toEqual({ ok: false, reason: 'missing-origin' });
  });

  // ---- Forward-compat: unknown Sec-Fetch-Site values fall through ----------

  it('falls through to Origin fallback when Sec-Fetch-Site has an unknown value (accept path)', () => {
    const result = checkSameOriginGet(
      reqWith({ 'sec-fetch-site': 'future-value', origin: BASE }),
      BASE,
    );
    expect(result).toEqual({ ok: true });
  });

  it('falls through to fallback when Sec-Fetch-Site has an unknown value and no Origin/Referer present', () => {
    const result = checkSameOriginGet(reqWith({ 'sec-fetch-site': 'future-value' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'missing-origin' });
  });

  // ---- Edge cases ----------------------------------------------------------

  it('treats Origin with default-port suffix the same as base origin', () => {
    // URL.origin normalizes :443 for https and :80 for http away.
    const result = checkSameOriginGet(
      reqWith({ origin: 'https://app.tokenfx.io:443' }),
      BASE,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects suffix-injection attempt (https://app.tokenfx.io.evil.com)', () => {
    // A naive startsWith(baseUrl) would accept this; URL.origin equality rejects.
    const result = checkSameOriginGet(
      reqWith({ origin: 'https://app.tokenfx.io.evil.com' }),
      BASE,
    );
    expect(result).toEqual({ ok: false, reason: 'cross-origin' });
  });

  it('accepts Referer with a trailing path (path is stripped by URL.origin)', () => {
    const result = checkSameOriginGet(
      reqWith({ referer: 'https://app.tokenfx.io/manager/teams/abc/export?provisioned_via=all' }),
      BASE,
    );
    expect(result).toEqual({ ok: true });
  });

  // Defensive case (no spec TC-ID): guards `tryUrlOrigin` returning null when
  // the Origin header is not a valid URL. Spec spec assumes browsers send a
  // well-formed value but a malicious client could send anything.
  it('rejects when Origin is unparseable as URL (defensive — treat as cross-origin)', () => {
    const result = checkSameOriginGet(reqWith({ origin: 'not-a-url' }), BASE);
    expect(result).toEqual({ ok: false, reason: 'cross-origin' });
  });
});
