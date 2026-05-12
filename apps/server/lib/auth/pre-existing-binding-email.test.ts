import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { err, ok, type Result } from '@/lib/result';
import type {
  EmailError,
  EmailInput,
  EmailResult,
  SendEmailFn,
} from '@/lib/email/send-email-stub';
import {
  __resetPreExistingBindingEmailState,
  sendPreExistingBindingEmail,
  type PreExistingBindingEmailInput,
} from './pre-existing-binding-email';

/**
 * Hand-written stub for `sendEmail` (no mocking framework — per
 * `.claude/rules/ts-conventions.md`). Each test instantiates a fresh stub
 * via `makeStub()` and asserts on `calls` + `lastInput`.
 */
type Stub = {
  calls: EmailInput[];
  fn: SendEmailFn;
};

const makeStub = (
  response: Result<EmailResult, EmailError> = ok({ messageId: 'mid-1' }),
): Stub => {
  const calls: EmailInput[] = [];
  const fn: SendEmailFn = async (input) => {
    calls.push(input);
    return response;
  };
  return { calls, fn };
};

/**
 * Deterministic pepper so `hashEmail` results stay stable test-to-test
 * without relying on the dev fallback (which would still work but we want
 * to be explicit).
 */
const ENV_KEYS = ['NODE_ENV', 'ONBOARDING_EMAIL_HASH_PEPPER'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const mutableEnv = process.env as Record<string, string | undefined>;
let envSnapshot: Partial<Record<EnvKey, string | undefined>> = {};

const baseInput = (overrides: Partial<PreExistingBindingEmailInput> = {}): PreExistingBindingEmailInput => ({
  to: 'user@example.com',
  city: 'Berlin',
  browser: 'Firefox 130',
  time: new Date('2026-05-12T10:00:00Z'),
  ...overrides,
});

describe('sendPreExistingBindingEmail', () => {
  beforeEach(() => {
    envSnapshot = {
      NODE_ENV: process.env.NODE_ENV,
      ONBOARDING_EMAIL_HASH_PEPPER: process.env.ONBOARDING_EMAIL_HASH_PEPPER,
    };
    mutableEnv.ONBOARDING_EMAIL_HASH_PEPPER = 'test-pepper';
    __resetPreExistingBindingEmailState();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) {
      if (envSnapshot[k] === undefined) delete mutableEnv[k];
      else mutableEnv[k] = envSnapshot[k];
    }
  });

  it('sends an email on first invocation, calls sendEmail with expected fields (to, subject, body containing city + browser + time)', async () => {
    const stub = makeStub(ok({ messageId: 'mid-first' }));
    const result = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(result).toEqual({ sent: true, messageId: 'mid-first' });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.to).toBe('user@example.com');
    expect(call.subject.length).toBeGreaterThan(0);
    expect(call.body).toContain('Berlin');
    expect(call.body).toContain('Firefox 130');
    expect(call.body).toContain('2026-05-12T10:00:00.000Z');
  });

  it('1st email allowed', async () => {
    const stub = makeStub();
    const r = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    expect(r.sent).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('2nd email to same email_hash within 24h allowed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const stub = makeStub();

    const r1 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    expect(r1.sent).toBe(true);

    vi.setSystemTime(new Date('2026-05-12T05:00:00Z'));
    const r2 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    expect(r2.sent).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });

  it('3rd email to same email_hash within 24h allowed (still under cap of 3)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const stub = makeStub();

    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T05:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    const r3 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(r3.sent).toBe(true);
    expect(stub.calls).toHaveLength(3);
  });

  it('4th email to same email_hash within 24h suppressed, returns { sent: false, reason: rate-limited }', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const stub = makeStub();

    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T05:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    vi.setSystemTime(new Date('2026-05-12T15:00:00Z'));
    const r4 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(r4.sent).toBe(false);
    expect(r4).toMatchObject({ sent: false, reason: 'rate-limited' });
    if (r4.sent === false) {
      expect(typeof r4.emailHash).toBe('string');
      expect(r4.emailHash.length).toBeGreaterThan(0);
    }
    expect(stub.calls).toHaveLength(3);
  });

  it('4th email > 24h after first allowed (window expired)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const stub = makeStub();

    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T05:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    // > 24h after 1st send (1st aged out; only 2 in window)
    vi.setSystemTime(new Date('2026-05-13T01:00:00Z'));
    const r4 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(r4.sent).toBe(true);
    expect(stub.calls).toHaveLength(4);
  });

  it('4th email at EXACTLY 24h after first — boundary is inclusive (>=), 1st send still in window → suppressed', async () => {
    // Window convention (per spec implementation): `filter((ts) => ts >= windowStart)`
    // where `windowStart = now - 24h`. At exactly t0 + 24h, `windowStart === t0`
    // and the 1st send's timestamp (== windowStart) satisfies `>=`, so it is
    // retained and counts toward the cap → 4th blocked. The very next tick
    // (24h + 1ms) is when the 1st send falls out (covered by the
    // "> 24h after first allowed" test above).
    vi.useFakeTimers();
    const t0 = new Date('2026-05-12T00:00:00Z');
    vi.setSystemTime(t0);
    const stub = makeStub();

    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T05:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    vi.setSystemTime(new Date(t0.getTime() + 24 * 60 * 60 * 1000));
    const r4 = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(r4.sent).toBe(false);
    expect(r4).toMatchObject({ sent: false, reason: 'rate-limited' });
    expect(stub.calls).toHaveLength(3);
  });

  it('sendEmail throwing an error is propagated (NOT caught) — caller must handle', async () => {
    // Per REQ-23, sendEmail NEVER throws. This test asserts the contract:
    // the helper does NOT swallow a throw from a misbehaving sendEmail; it
    // propagates so the caller (decision-engine) sees the bug and reports it.
    const throwing: SendEmailFn = async () => {
      throw new Error('contract violation: sendEmail must not throw');
    };
    await expect(
      sendPreExistingBindingEmail(baseInput(), { sendEmail: throwing }),
    ).rejects.toThrow(/contract violation/);
  });

  it('sendEmail returns { ok: false, error: { reason: transient, message } } → helper returns { sent: false, reason: send-failed }', async () => {
    const stub = makeStub(err({ reason: 'transient', message: 'smtp timeout' }));
    const r = await sendPreExistingBindingEmail(baseInput(), { sendEmail: stub.fn });

    expect(r.sent).toBe(false);
    expect(r).toMatchObject({ sent: false, reason: 'send-failed' });
    if (r.sent === false) {
      expect(typeof r.emailHash).toBe('string');
      expect(r.emailHash.length).toBeGreaterThan(0);
    }
    expect(stub.calls).toHaveLength(1);
  });

  it('failed send does NOT count toward rate-limit (only successful sends consume slots)', async () => {
    // Important business rule: if 3 sends fail with `send-failed`, a 4th attempt
    // must still be allowed (otherwise transient SMTP outages would lock the
    // user out of legitimate notifications).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const failing = makeStub(err({ reason: 'transient', message: 'down' }));

    await sendPreExistingBindingEmail(baseInput(), { sendEmail: failing.fn });
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: failing.fn });
    await sendPreExistingBindingEmail(baseInput(), { sendEmail: failing.fn });

    const recovered = makeStub(ok({ messageId: 'mid-ok' }));
    const r = await sendPreExistingBindingEmail(baseInput(), { sendEmail: recovered.fn });

    expect(r.sent).toBe(true);
    expect(recovered.calls).toHaveLength(1);
  });

  it('null city / null browser → email body uses fallback strings', async () => {
    const stub = makeStub();
    await sendPreExistingBindingEmail(
      baseInput({ city: null, browser: null }),
      { sendEmail: stub.fn },
    );

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.body).toContain('(location unknown)');
    expect(call.body).toContain('(browser unknown)');
  });

  it('different email_hashes have independent rate-limit buckets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
    const stub = makeStub();

    // Hit cap for user-a
    await sendPreExistingBindingEmail(baseInput({ to: 'a@x.com' }), { sendEmail: stub.fn });
    await sendPreExistingBindingEmail(baseInput({ to: 'a@x.com' }), { sendEmail: stub.fn });
    await sendPreExistingBindingEmail(baseInput({ to: 'a@x.com' }), { sendEmail: stub.fn });
    const aBlocked = await sendPreExistingBindingEmail(baseInput({ to: 'a@x.com' }), { sendEmail: stub.fn });
    expect(aBlocked.sent).toBe(false);

    // user-b unaffected
    const bAllowed = await sendPreExistingBindingEmail(baseInput({ to: 'b@x.com' }), { sendEmail: stub.fn });
    expect(bAllowed.sent).toBe(true);
  });
});
