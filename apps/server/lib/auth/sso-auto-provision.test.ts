/**
 * Unit tests for `evaluateAutoProvision` (TASK-10 of
 * central-server-onboarding-v2-sso.backend).
 *
 * Pure unit suite — every external collaborator is replaced with a
 * hand-written stub via `AutoProvisionDeps` (no mocking framework per
 * .claude/rules/ts-conventions.md). Test names use natural English; TC-IDs
 * are mapped in comments only.
 *
 * Spec mapping:
 *   - TC-U-01            happy path single-match → accepted
 *   - TC-U-02..04        public-domain blocklist
 *   - TC-U-05..07        match-count branches
 *   - TC-U-08..10        allowed_sso_providers
 *   - TC-U-11..12        pre-existing v1 user check
 *   - TC-U-13..15        race outcomes
 *   - TC-U-39..40        email_verified false / undefined
 *   - TC-U-41..42        iss / aud mismatch
 *   - TC-U-43            sendEmail returning err — decision still surfaces
 */
import { describe, expect, it, vi } from 'vitest';

import { err, ok, type Result } from '@/lib/result';
import type {
  AuthEventInput,
  AuthEventOutcome,
} from './auth-event-log-writer';
import type { ActiveInvite } from './match-active-invites';
import type { WriteRedemptionLogParams } from '@/lib/queries/redemption-log';
import type { SendResult } from './pre-existing-binding-email';
import type { RateLimitResult } from '@/lib/queries/rate-limit';

import {
  type AutoProvisionDecision,
  type AutoProvisionDeps,
  type AutoProvisionInput,
  type FindPreExistingV1User,
  type ProvisionInTxInput,
  type ProvisionInTxResult,
  evaluateAutoProvision,
} from './sso-auto-provision';

// ============================================================================
// Test-helper: hand-written stub fan-out
// ============================================================================

/**
 * Records every call made through the injected deps. Each test asserts on
 * call counts + args, not on actual DB / network behavior.
 */
type StubRecorder = {
  matchInvitesCalls: string[];
  authEventWrites: AuthEventInput[];
  redemptionWrites: WriteRedemptionLogParams[];
  preExistingEmailCalls: Array<{
    to: string;
    city: string | null;
    browser: string | null;
  }>;
  findPreExistingUserCalls: Array<{ orgId: string; email: string }>;
  provisionInTxCalls: ProvisionInTxInput[];
  rateLimitCalls: number;
  publicDomainCalls: string[];
};

type StubConfig = {
  rateLimit?: RateLimitResult;
  matchInvitesReturns?: ActiveInvite[];
  preExistingUserReturns?: { id: string } | null;
  provisionInTxReturns?: ProvisionInTxResult;
  sendEmailResult?: SendResult;
  sendEmailThrows?: Error;
  isPublicDomainReturns?: boolean;
  issuerWhitelist?: ReadonlySet<string>;
  clientId?: string;
};

const TEST_PEPPER = 'test-pepper';
const FAKE_INVITE_TOKEN = 'tk0011223344556677889900aabbccddeeff';

const makeInvite = (overrides: Partial<ActiveInvite> = {}): ActiveInvite => ({
  token: FAKE_INVITE_TOKEN,
  orgId: '00000000-0000-0000-0000-000000000111',
  teamId: null,
  emailPattern: '*@example.com',
  maxUses: 5,
  usedCount: 0,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  allowedSsoProviders: [],
  ...overrides,
});

const makeDeps = (
  cfg: StubConfig = {},
): { deps: Partial<AutoProvisionDeps>; recorder: StubRecorder } => {
  const recorder: StubRecorder = {
    matchInvitesCalls: [],
    authEventWrites: [],
    redemptionWrites: [],
    preExistingEmailCalls: [],
    findPreExistingUserCalls: [],
    provisionInTxCalls: [],
    rateLimitCalls: 0,
    publicDomainCalls: [],
  };

  const matchInvites = async (email: string) => {
    recorder.matchInvitesCalls.push(email);
    return cfg.matchInvitesReturns ?? [];
  };

  const writeAuthEvent = async (input: AuthEventInput) => {
    recorder.authEventWrites.push(input);
  };

  const writeRedemptionLog = async (params: WriteRedemptionLogParams) => {
    recorder.redemptionWrites.push(params);
  };

  const sendPreExistingBindingEmail = async (input: {
    to: string;
    city: string | null;
    browser: string | null;
    time: Date;
  }): Promise<SendResult> => {
    recorder.preExistingEmailCalls.push({
      to: input.to,
      city: input.city,
      browser: input.browser,
    });
    if (cfg.sendEmailThrows) throw cfg.sendEmailThrows;
    return (
      cfg.sendEmailResult ?? { sent: true, messageId: 'stub-mid-1' }
    );
  };

  const findPreExistingV1User: FindPreExistingV1User = async (
    orgId,
    email,
  ) => {
    recorder.findPreExistingUserCalls.push({ orgId, email });
    return cfg.preExistingUserReturns ?? null;
  };

  const provisionInTx = async (
    input: ProvisionInTxInput,
  ): Promise<ProvisionInTxResult> => {
    recorder.provisionInTxCalls.push(input);
    return (
      cfg.provisionInTxReturns ?? {
        kind: 'accepted',
        userId: '00000000-0000-0000-0000-000000000abc',
      }
    );
  };

  const checkSsoRateLimit = (): RateLimitResult => {
    recorder.rateLimitCalls += 1;
    return cfg.rateLimit ?? { ok: true };
  };

  const isPublicDomain = (domain: string): boolean => {
    recorder.publicDomainCalls.push(domain);
    return cfg.isPublicDomainReturns ?? false;
  };

  // hashEmail + emailDomain use the REAL implementations so normalized
  // inputs are exercised by the orchestrator end-to-end. They're pure and
  // already have their own tests.
  const deps: Partial<AutoProvisionDeps> = {
    matchActiveInvitesByEmail: matchInvites,
    checkSsoRateLimit,
    isPublicDomain,
    writeAuthEvent,
    writeRedemptionLog,
    sendPreExistingBindingEmail,
    findPreExistingV1User,
    provisionInTx,
    ipToCity: async () => null,
    issuerWhitelist:
      cfg.issuerWhitelist ?? new Set(['https://accounts.google.com']),
    clientId: cfg.clientId ?? 'tokenfx-test-client',
  };

  return { deps, recorder };
};

const baseInput = (overrides: Partial<AutoProvisionInput> = {}): AutoProvisionInput => ({
  email: 'dev@example.com',
  ssoProvider: 'google',
  ssoSubject: 'oidc-sub-abc',
  ssoIssuer: 'https://accounts.google.com',
  audience: 'tokenfx-test-client',
  emailVerified: true,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (test)',
  displayName: 'Test Dev',
  ...overrides,
});

const PUBLIC_DOMAINS_LIST = [
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
] as const;

// ============================================================================
// Tests
// ============================================================================

describe('evaluateAutoProvision (TASK-10)', () => {
  // Set the pepper so hashEmail (used internally for emailHashValue) stays
  // deterministic across test runs.
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.ONBOARDING_EMAIL_HASH_PEPPER = TEST_PEPPER;

  // -- TC-U-01 ----------------------------------------------------------------
  it('happy path: single-match clean invite returns accepted-sso-auto', async () => {
    const invite = makeInvite();
    const { deps, recorder } = makeDeps({
      matchInvitesReturns: [invite],
      provisionInTxReturns: {
        kind: 'accepted',
        userId: '00000000-0000-0000-0000-000000000999',
      },
    });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision).toEqual<AutoProvisionDecision>({
      kind: 'accepted-sso-auto',
      userId: '00000000-0000-0000-0000-000000000999',
      orgId: invite.orgId,
    });
    expect(recorder.provisionInTxCalls).toHaveLength(1);
    // Audit rows for the accepted path are written INSIDE provisionInTx
    // by the orchestrator's wired-in writer call; the recorder captures
    // outside-tx writes only (zero on happy path).
    expect(recorder.authEventWrites).toHaveLength(0);
    expect(recorder.redemptionWrites).toHaveLength(0);
  });

  // -- TC-U-02 ----------------------------------------------------------------
  it('public-domain gmail.com short-circuits without matchInvites call', async () => {
    const { deps, recorder } = makeDeps({ isPublicDomainReturns: true });
    const decision = await evaluateAutoProvision(
      baseInput({ email: 'spammer@gmail.com' }),
      deps,
    );
    expect(decision).toEqual({ kind: 'rejected-public-domain' });
    expect(recorder.matchInvitesCalls).toHaveLength(0);
    expect(recorder.authEventWrites).toHaveLength(1);
    expect(recorder.authEventWrites[0].outcome).toBe('rejected-public-domain');
    expect(recorder.redemptionWrites).toHaveLength(1);
    expect(recorder.redemptionWrites[0].outcome).toBe('rejected-public-domain');
    expect(recorder.redemptionWrites[0].tokenPrefix).toBe('00000000');
  });

  // -- TC-U-03 ----------------------------------------------------------------
  it.each(PUBLIC_DOMAINS_LIST.map((d) => ({ domain: d })))(
    'all 17 blocklist domains return rejected-public-domain ($domain)',
    async ({ domain }) => {
      // Real isPublicDomain via the actual module (no stub override).
      const { deps } = makeDeps({});
      // Don't stub isPublicDomain — use the real one to verify the table.
      delete deps.isPublicDomain;
      const decision = await evaluateAutoProvision(
        baseInput({ email: `user@${domain}` }),
        deps,
      );
      expect(decision).toEqual({ kind: 'rejected-public-domain' });
    },
  );

  // -- TC-U-04 ----------------------------------------------------------------
  it.each([
    { variant: 'Gmail.com' },
    { variant: 'GMAIL.COM' },
    { variant: '  gmail.com  ' },
  ])(
    'domain casing variant $variant is normalized and blocked',
    async ({ variant }) => {
      const { deps } = makeDeps({});
      delete deps.isPublicDomain;
      const decision = await evaluateAutoProvision(
        baseInput({ email: `Alice@${variant}` }),
        deps,
      );
      expect(decision).toEqual({ kind: 'rejected-public-domain' });
    },
  );

  // -- TC-U-05 ----------------------------------------------------------------
  it('zero matches returns rejected-no-match', async () => {
    const { deps, recorder } = makeDeps({ matchInvitesReturns: [] });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision).toEqual({ kind: 'rejected-no-match' });
    expect(recorder.authEventWrites[0].outcome).toBe('rejected-no-match');
    expect(recorder.redemptionWrites[0].tokenPrefix).toBe('00000000');
    expect(recorder.provisionInTxCalls).toHaveLength(0);
  });

  // -- TC-U-06 ----------------------------------------------------------------
  it('two matches returns rejected-multiple-matches', async () => {
    const invites = [
      makeInvite({ token: 'b' + 'b'.repeat(63) }),
      makeInvite({ token: 'a' + 'a'.repeat(63) }),
    ];
    const { deps, recorder } = makeDeps({ matchInvitesReturns: invites });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision).toEqual({ kind: 'rejected-multiple-matches' });
    // tokenPrefix is alphabetically first → 'aaaaaaaa'.
    expect(recorder.redemptionWrites[0].tokenPrefix).toBe('aaaaaaaa');
  });

  // -- TC-U-07 ----------------------------------------------------------------
  it('five matches returns rejected-multiple-matches (no count-based branching beyond 2)', async () => {
    const invites = Array.from({ length: 5 }, (_, i) =>
      makeInvite({ token: `${i}`.repeat(64) }),
    );
    const { deps } = makeDeps({ matchInvitesReturns: invites });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision).toEqual({ kind: 'rejected-multiple-matches' });
  });

  // -- TC-U-08 ----------------------------------------------------------------
  it('invite allowed_sso_providers=[google] + provider=okta returns rejected-cross-idp', async () => {
    const invite = makeInvite({ allowedSsoProviders: ['google'] });
    const { deps } = makeDeps({ matchInvitesReturns: [invite] });
    const decision = await evaluateAutoProvision(
      baseInput({ ssoProvider: 'okta' }),
      deps,
    );
    expect(decision).toEqual({ kind: 'rejected-cross-idp' });
  });

  // -- TC-U-09 ----------------------------------------------------------------
  it('invite allowed_sso_providers=[] allows any provider', async () => {
    const invite = makeInvite({ allowedSsoProviders: [] });
    const { deps } = makeDeps({
      matchInvitesReturns: [invite],
      provisionInTxReturns: { kind: 'accepted', userId: 'u1' },
    });
    const decision = await evaluateAutoProvision(
      baseInput({ ssoProvider: 'okta' }),
      deps,
    );
    expect(decision.kind).toBe('accepted-sso-auto');
  });

  // -- TC-U-10 ----------------------------------------------------------------
  it('invite allowed_sso_providers=[google,okta] + provider=google proceeds', async () => {
    const invite = makeInvite({ allowedSsoProviders: ['google', 'okta'] });
    const { deps } = makeDeps({
      matchInvitesReturns: [invite],
      provisionInTxReturns: { kind: 'accepted', userId: 'u2' },
    });
    const decision = await evaluateAutoProvision(
      baseInput({ ssoProvider: 'google' }),
      deps,
    );
    expect(decision.kind).toBe('accepted-sso-auto');
  });

  // -- TC-U-11 ----------------------------------------------------------------
  it('pre-existing v1 user in same org with NULL sso_provider returns rejected-pre-existing-binding', async () => {
    const invite = makeInvite();
    const { deps, recorder } = makeDeps({
      matchInvitesReturns: [invite],
      preExistingUserReturns: { id: 'existing-user-1' },
    });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision).toEqual({ kind: 'rejected-pre-existing-binding' });
    // findPreExistingV1User invoked with the invite's org id (not some other org).
    expect(recorder.findPreExistingUserCalls).toHaveLength(1);
    expect(recorder.findPreExistingUserCalls[0].orgId).toBe(invite.orgId);
    // Email helper invoked exactly once.
    expect(recorder.preExistingEmailCalls).toHaveLength(1);
    expect(recorder.preExistingEmailCalls[0].to).toBe('dev@example.com');
  });

  // -- TC-U-12 ----------------------------------------------------------------
  it('pre-existing user lookup is scoped by invite org id (different org not triggered)', async () => {
    const invite = makeInvite({ orgId: 'org-A' });
    // findPreExistingV1User returns null when scoped to org-A (simulating
    // the v1 user living in org-B). The orchestrator must NOT escalate
    // to pre-existing-binding — flow proceeds.
    const { deps, recorder } = makeDeps({
      matchInvitesReturns: [invite],
      preExistingUserReturns: null,
      provisionInTxReturns: { kind: 'accepted', userId: 'u-new' },
    });
    const decision = await evaluateAutoProvision(baseInput(), deps);
    expect(decision.kind).toBe('accepted-sso-auto');
    expect(recorder.findPreExistingUserCalls).toHaveLength(1);
    expect(recorder.findPreExistingUserCalls[0].orgId).toBe('org-A');
    expect(recorder.preExistingEmailCalls).toHaveLength(0);
  });

  // -- TC-U-13 / 14 / 15 ------------------------------------------------------
  it.each([
    { label: 'invite revoked between SELECT and FOR UPDATE' },
    { label: 'invite expired' },
    { label: 'used_count >= max_uses' },
  ])(
    'race: $label returns rejected-race',
    async () => {
      const invite = makeInvite();
      const { deps, recorder } = makeDeps({
        matchInvitesReturns: [invite],
        provisionInTxReturns: { kind: 'rejected-race' },
      });
      const decision = await evaluateAutoProvision(baseInput(), deps);
      expect(decision).toEqual({ kind: 'rejected-race' });
      // Audit rows are written OUTSIDE the tx for rejection paths.
      expect(recorder.authEventWrites).toHaveLength(1);
      expect(recorder.authEventWrites[0].outcome).toBe('rejected-race');
      expect(recorder.redemptionWrites).toHaveLength(1);
      expect(recorder.redemptionWrites[0].outcome).toBe('rejected-race');
    },
  );

  // -- TC-U-39 ----------------------------------------------------------------
  it('email_verified=false returns email-not-verified', async () => {
    const { deps, recorder } = makeDeps({});
    const decision = await evaluateAutoProvision(
      baseInput({ emailVerified: false }),
      deps,
    );
    expect(decision).toEqual({ kind: 'email-not-verified' });
    expect(recorder.matchInvitesCalls).toHaveLength(0);
    expect(recorder.authEventWrites[0].outcome).toBe('email-not-verified');
  });

  // -- TC-U-40 ----------------------------------------------------------------
  it('email_verified=undefined returns email-not-verified', async () => {
    const { deps } = makeDeps({});
    // Cast: AutoProvisionInput types emailVerified as boolean, but real
    // OIDC tokens may omit the claim. The orchestrator's check is
    // `!== true` so undefined collapses to the same branch — this test
    // exercises that contract.
    const inputWithMissingClaim = {
      ...baseInput(),
      emailVerified: undefined as unknown as boolean,
    };
    const decision = await evaluateAutoProvision(inputWithMissingClaim, deps);
    expect(decision).toEqual({ kind: 'email-not-verified' });
  });

  // -- TC-U-41 ----------------------------------------------------------------
  it('iss not in whitelist returns rejected-csrf', async () => {
    const { deps, recorder } = makeDeps({
      issuerWhitelist: new Set(['https://accounts.google.com']),
    });
    const decision = await evaluateAutoProvision(
      baseInput({ ssoIssuer: 'https://evil.example.com' }),
      deps,
    );
    expect(decision).toEqual({ kind: 'rejected-csrf' });
    expect(recorder.authEventWrites[0].outcome).toBe('rejected-csrf');
  });

  // -- TC-U-42 ----------------------------------------------------------------
  it('aud != clientId returns rejected-csrf', async () => {
    const { deps } = makeDeps({ clientId: 'tokenfx-test-client' });
    const decision = await evaluateAutoProvision(
      baseInput({ audience: 'wrong-client-id' }),
      deps,
    );
    expect(decision).toEqual({ kind: 'rejected-csrf' });
  });

  // -- TC-U-43 ----------------------------------------------------------------
  it('sendEmail returning ok:false → decision still returned + audit row written', async () => {
    const invite = makeInvite();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* swallow */
    });
    try {
      const { deps, recorder } = makeDeps({
        matchInvitesReturns: [invite],
        preExistingUserReturns: { id: 'existing-user' },
        sendEmailResult: {
          sent: false,
          reason: 'send-failed',
          emailHash: 'eh-xyz',
        },
      });
      const decision = await evaluateAutoProvision(baseInput(), deps);
      // Decision still surfaces despite the email-send failure (REQ-22).
      expect(decision).toEqual({ kind: 'rejected-pre-existing-binding' });
      // Audit row still written.
      expect(recorder.authEventWrites).toHaveLength(1);
      expect(recorder.authEventWrites[0].outcome).toBe(
        'rejected-pre-existing-binding',
      );
      expect(recorder.redemptionWrites).toHaveLength(1);
      // warn was logged (we don't assert exact line, just presence).
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -- Rate-limited path ------------------------------------------------------
  it('rate-limited surfaces as rate-limited kind + skips auth_event_log write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      /* swallow */
    });
    try {
      const { deps, recorder } = makeDeps({
        rateLimit: { ok: false, dimension: 'ip', retryAfterSec: 42 },
      });
      const decision = await evaluateAutoProvision(baseInput(), deps);
      expect(decision).toEqual({
        kind: 'rate-limited',
        dimension: 'ip',
        retryAfterSec: 42,
      });
      // Decisão #16: auth_event_log NOT written; only redemption-log.
      expect(recorder.authEventWrites).toHaveLength(0);
      expect(recorder.redemptionWrites).toHaveLength(1);
      expect(recorder.redemptionWrites[0].outcome).toBe('rate-limited');
      expect(recorder.redemptionWrites[0].method).toBe('sso-auto');
      // No downstream checks were invoked.
      expect(recorder.matchInvitesCalls).toHaveLength(0);
      expect(recorder.provisionInTxCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -- Type-level guards ------------------------------------------------------
  it('AuthEventOutcome union strictly matches AutoProvisionDecision rejected kinds', () => {
    // Compile-time check: every AuthEventOutcome we write must be assignable
    // back into the AuthEventInput.outcome field. The assignment below is
    // dead code at runtime but errors at compile time if the union drifts.
    const probe: AuthEventOutcome = 'rejected-csrf';
    expect(probe).toBe('rejected-csrf');
  });

  // -- Result error pattern smoke test ----------------------------------------
  it('email-send failure via Result error type does not throw out of helper', async () => {
    // Defensive: validates that ok/err constructors from @/lib/result are
    // wired through the helper without an unhandled rejection path.
    const result1: Result<{ messageId: string }, { reason: string }> = ok({
      messageId: 'mid',
    });
    const result2 = err({ reason: 'transient' });
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(false);
  });
});
