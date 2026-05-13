/**
 * Playwright-side control of the local OIDC stub (`apps/idp-stub`).
 *
 * Tests call `setStubScenario(...)` to pin the next id_token's claims
 * (email, sub, jti, etc.) and `resetStubScenario()` between tests to
 * isolate state. Both helpers accept an `opts.fetch` injection seam so
 * their failure-mode TCs (TC-I-18, TC-I-24) can run under Vitest
 * without a live stub process.
 *
 * Origin: `.specs/oauth-idp-stub.md` REQ-5/REQ-5a + helper module
 * Design section.
 */
export type SetStubOpts = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}>;

export type ScenarioPatch = Readonly<{
  email?: string;
  email_verified?: boolean;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  jti?: string;
  nonce?: string;
  forceIssOverride?: string;
}>;

const resolveBaseUrl = (opts: SetStubOpts): string =>
  opts.baseUrl ?? process.env.IDP_STUB_BASE_URL ?? 'http://localhost:3001';

const resolveFetch = (opts: SetStubOpts): typeof globalThis.fetch =>
  opts.fetch ?? globalThis.fetch;

export const setStubScenario = async (
  patch: ScenarioPatch,
  opts: SetStubOpts = {},
): Promise<void> => {
  const f = resolveFetch(opts);
  const base = resolveBaseUrl(opts);
  const res = await f(`${base}/admin/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`setStubScenario failed: HTTP ${res.status} — ${text}`);
  }
};

export const resetStubScenario = async (
  opts: SetStubOpts = {},
): Promise<void> => {
  const f = resolveFetch(opts);
  const base = resolveBaseUrl(opts);
  const res = await f(`${base}/admin/scenario/reset`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`resetStubScenario failed: HTTP ${res.status} — ${text}`);
  }
};

export const waitForStubReady = async (
  opts: SetStubOpts = {},
  timeoutMs = 5_000,
): Promise<void> => {
  const f = resolveFetch(opts);
  const base = resolveBaseUrl(opts);
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await f(`${base}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `idp-stub did not become ready within ${timeoutMs}ms (last error: ${String(lastErr)})`,
  );
};
