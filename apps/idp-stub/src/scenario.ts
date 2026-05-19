import { z } from 'zod';

/**
 * Zod schema for partial scenario overrides accepted by
 * `POST /admin/scenario`. Strict — unknown keys are rejected so a typo in
 * a test harness fails loudly rather than silently producing the default
 * scenario.
 *
 * Bounds mirror the documented Scenario claim semantics:
 * - email: 1..254 chars, must be a valid email (NextAuth would reject otherwise)
 * - sub/aud/jti/nonce/forceIssOverride: 1..255 chars
 * - exp/iat: positive integer (epoch seconds)
 */
export const ScenarioOverrideSchema = z
  .object({
    email: z.string().min(1).max(254).email().optional(),
    email_verified: z.boolean().optional(),
    sub: z.string().min(1).max(255).optional(),
    aud: z.string().min(1).max(255).optional(),
    exp: z.number().int().positive().optional(),
    iat: z.number().int().positive().optional(),
    jti: z.string().min(1).max(255).optional(),
    nonce: z.string().min(1).max(255).optional(),
    forceIssOverride: z
      .string()
      .min(1)
      .max(255)
      .describe(
        'SECURITY-TESTING ONLY — overrides the iss claim so NextAuth rejects with InvalidIssuer. Do not use in happy-path tests.',
      )
      .optional(),
  })
  .strict();

export type ScenarioOverride = z.infer<typeof ScenarioOverrideSchema>;

/**
 * Full scenario record materialised in the store. Nullable fields
 * (`exp`, `iat`, `jti`, `nonce`, `forceIssOverride`) are filled by
 * `signIdToken` at issue time when null — keeps the default scenario
 * deterministic at config time while still producing fresh `jti`/`iat`
 * per token.
 *
 * Note: `iss` is intentionally NOT part of Scenario — it derives from
 * the discovery `issuer` URL passed to `signIdToken`. `forceIssOverride`
 * lets a test bypass this for explicit cross-IdP rejection coverage.
 */
export type Scenario = Readonly<{
  email: string;
  email_verified: boolean;
  sub: string;
  aud: string;
  exp: number | null;
  iat: number | null;
  jti: string | null;
  nonce: string | null;
  forceIssOverride: string | null;
}>;

/**
 * Default scenario emitted by the stub at startup or after
 * `POST /admin/scenario/reset`. Values pinned by the spec
 * (Context §5) — do not change without updating the spec.
 */
export const DEFAULT_SCENARIO: Scenario = {
  email: 'e2e-sso-new@e2e-sso.test',
  email_verified: true,
  sub: 'e2e-sso-test-sub-001',
  aud: 'test-client',
  exp: null,
  iat: null,
  jti: null,
  nonce: null,
  forceIssOverride: null,
};

export interface ScenarioStore {
  get(): Scenario;
  set(patch: ScenarioOverride): void;
  reset(): void;
  /**
   * Record the `nonce` value captured from a `GET /authorize` query
   * param. Read at `/token` minting time as the fallback for the
   * `id_token.nonce` claim when the scenario does not pin a `nonce`.
   *
   * Pass `null` to clear the slot (e.g. when /authorize is called
   * without a `nonce` param OR with an empty one).
   *
   * Spec: .specs/sso-nonce-replay.md TASK-1.
   */
  setPendingNonce(value: string | null): void;
  /** Read the last-recorded pending nonce. `null` when never set or cleared. */
  getPendingNonce(): string | null;
}

/**
 * In-memory scenario store factory. Each call returns an independent
 * store — required so Vitest workers / parallel test files don't share
 * state. The stub's process-lifetime singleton is `defaultScenarioStore`
 * below.
 *
 * The pending-nonce slot lives in the same factory closure as `current`
 * so per-test isolation extends to it: tests that build a fresh store
 * via `createScenarioStore()` start with `pendingNonce = null`.
 */
export const createScenarioStore = (): ScenarioStore => {
  let current: Scenario = DEFAULT_SCENARIO;
  let pendingNonce: string | null = null;
  return {
    get: () => current,
    set: (patch) => {
      current = { ...current, ...patch };
    },
    reset: () => {
      current = DEFAULT_SCENARIO;
      pendingNonce = null;
    },
    setPendingNonce: (value) => {
      pendingNonce = value;
    },
    getPendingNonce: () => pendingNonce,
  };
};

/**
 * Process-lifetime singleton used by the Hono server. Tests should
 * prefer `createScenarioStore()` to avoid cross-test pollution.
 */
export const defaultScenarioStore: ScenarioStore = createScenarioStore();
