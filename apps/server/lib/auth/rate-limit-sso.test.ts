/**
 * Unit tests for the SSO rate-limit wrapper (TASK-8 of
 * `central-server-onboarding-v2-sso.backend`).
 *
 * Pure-unit suite. The underlying counters are in-memory (no DB / no
 * Postgres / no Drizzle), so we use vitest's built-in fake timers (allowed
 * under the project's "no mocking frameworks" rule — fake timers ship with
 * vitest itself) to advance the clock deterministically for the sliding
 * window assertion.
 *
 * TC mappings:
 *   - TC-U-19 — 9 attempts from same IP within 5 min all allowed.
 *   - TC-U-20 — 11th attempt from same IP within 5 min exceeds with
 *               dimension: 'ip'.
 *   - TC-U-21 — 4th attempt for same email_hash within 24h exceeds with
 *               dimension: 'email_hash'.
 *   - TC-U-22 — 6th attempt for same sso_subject_hash within 24h exceeds
 *               with dimension: 'sso_subject_hash'.
 *   - TC-U-23 — first dimension hit short-circuits (IP exceeded before
 *               email_hash would).
 *   - TC-U-24 — sliding window expires (per-IP 10/5min stays under cap
 *               when spaced 31 min apart).
 *   - TC-I-20 / TC-I-21 — null ssoSubjectHash skips the per-subject
 *               dimension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSsoRateLimit, checkSsoRateLimit } from './rate-limit-sso';

describe('checkSsoRateLimit (TASK-8)', () => {
  beforeEach(() => {
    __resetSsoRateLimit();
    vi.useFakeTimers();
    // Anchor at a fixed instant so window math is easy to read.
    vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('9 attempts from same IP within 5 min are all allowed', () => {
    const ip = '203.0.113.0/24';
    const emailHash = 'eh-happy-9';
    for (let i = 0; i < 9; i += 1) {
      // Distinct email_hash per attempt to isolate the IP dimension
      // (avoids hitting the 3/24h per-email-hash cap before we hit 9).
      const r = checkSsoRateLimit({
        ip,
        emailHash: `${emailHash}-${i}`,
        ssoSubjectHash: null,
      });
      expect(r.ok).toBe(true);
    }
  });

  it('11th attempt from same IP within 5 min returns ok: false with dimension: ip', () => {
    const ip = '203.0.113.0/24';
    // Spread email_hash + sso_subject across attempts so only the per-IP
    // 10/5min cap can be the one that trips on attempt #11.
    for (let i = 0; i < 10; i += 1) {
      const r = checkSsoRateLimit({
        ip,
        emailHash: `eh-burst-${i}`,
        ssoSubjectHash: `sub-burst-${i}`,
      });
      expect(r.ok).toBe(true);
    }
    const eleventh = checkSsoRateLimit({
      ip,
      emailHash: 'eh-burst-11',
      ssoSubjectHash: 'sub-burst-11',
    });
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) {
      expect(eleventh.dimension).toBe('ip');
      expect(eleventh.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('4th attempt for same email_hash within 24h returns ok: false with dimension: email_hash', () => {
    const emailHash = 'eh-enum-target';
    // Distinct IPs + distinct subjects so neither of those caps trips
    // before the per-email_hash 3/24h cap.
    for (let i = 0; i < 3; i += 1) {
      const r = checkSsoRateLimit({
        ip: `198.51.100.${i}/24`,
        emailHash,
        ssoSubjectHash: `sub-enum-${i}`,
      });
      expect(r.ok).toBe(true);
    }
    const fourth = checkSsoRateLimit({
      ip: '198.51.100.99/24',
      emailHash,
      ssoSubjectHash: 'sub-enum-99',
    });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.dimension).toBe('email_hash');
      expect(fourth.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('6th attempt for same sso_subject_hash within 24h returns ok: false with dimension: sso_subject_hash', () => {
    const ssoSubjectHash = 'sub-stuffing-target';
    // Distinct IPs + distinct emails so neither of those caps trips
    // before the per-subject 5/24h cap.
    for (let i = 0; i < 5; i += 1) {
      const r = checkSsoRateLimit({
        ip: `192.0.2.${i}/24`,
        emailHash: `eh-stuffing-${i}`,
        ssoSubjectHash,
      });
      expect(r.ok).toBe(true);
    }
    const sixth = checkSsoRateLimit({
      ip: '192.0.2.99/24',
      emailHash: 'eh-stuffing-99',
      ssoSubjectHash,
    });
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.dimension).toBe('sso_subject_hash');
      expect(sixth.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('first dimension hit short-circuits (IP exceeded before email_hash would)', () => {
    const ip = '203.0.113.10/24';
    // Burn through the per-IP 10/5min cap using DISTINCT emails so the
    // per-email_hash 3/24h cap is nowhere near being tripped.
    for (let i = 0; i < 10; i += 1) {
      const r = checkSsoRateLimit({
        ip,
        emailHash: `eh-order-${i}`,
        ssoSubjectHash: null,
      });
      expect(r.ok).toBe(true);
    }
    // Now hit ONE MORE on the same IP with a fresh email_hash. The IP
    // dimension should report first (it's iterated first by
    // checkSsoRateLimit), proving deterministic ordering — not the email
    // dimension which would only have 1 hit.
    const overflow = checkSsoRateLimit({
      ip,
      emailHash: 'eh-order-fresh',
      ssoSubjectHash: null,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.dimension).toBe('ip');
    }
  });

  it('sliding window expires: 11 attempts spaced 31min apart never exceed per-IP 10/5min', () => {
    const ip = '203.0.113.20/24';
    for (let i = 0; i < 11; i += 1) {
      const r = checkSsoRateLimit({
        ip,
        // Each attempt uses a fresh email + subject so only the per-IP
        // window-expiry behaviour is under test.
        emailHash: `eh-window-${i}`,
        ssoSubjectHash: `sub-window-${i}`,
      });
      expect(r.ok).toBe(true);
      // Advance by 31 min — past the per-IP 5-min window so each entry
      // has expired by the time the next one is checked. The per-email
      // and per-subject windows are 24h, but each iteration uses a fresh
      // value so they're irrelevant.
      vi.advanceTimersByTime(31 * 60 * 1000);
    }
  });

  it('null ssoSubjectHash skips the per-subject dimension', () => {
    // Repeat with the SAME (ip, emailHash) but ssoSubjectHash=null. The
    // per-IP cap is 10/5min and per-email_hash is 3/24h; the 4th call
    // must trip on email_hash, never on sso_subject_hash (which isn't
    // checked at all when null).
    const ip = '198.51.100.50/24';
    const emailHash = 'eh-null-subject';
    for (let i = 0; i < 3; i += 1) {
      const r = checkSsoRateLimit({ ip, emailHash, ssoSubjectHash: null });
      expect(r.ok).toBe(true);
    }
    const fourth = checkSsoRateLimit({ ip, emailHash, ssoSubjectHash: null });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      // Critically: dimension is 'email_hash', NOT 'sso_subject_hash' —
      // null subjects mean that dimension is skipped entirely.
      expect(fourth.dimension).toBe('email_hash');
    }
  });
});
