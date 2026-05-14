/**
 * Canary lock for the NextAuth v5 `Credentials()` seam workaround.
 *
 * Context: `e2e-bypass-provider.ts` spike finding (c) — NextAuth v5's
 * `Credentials()` is a type-config helper, NOT a runtime wrapper. The
 * authorize callback you pass gets stuffed into `provider.options.authorize`;
 * the live `provider.authorize` is a default `() => null` stub. The
 * NextAuth init pipeline merges `provider.options.authorize` into the
 * live provider later, when `Auth(config)` is called from the route.
 *
 * That's why we extract `createAuthorize(loadUser)` separately and unit-
 * test it directly — calling `provider.authorize` from a test would hit
 * the stub and produce a vacuously-green pass.
 *
 * This canary asserts the current quirky behavior. When NextAuth ships a
 * version that actually wraps the authorize callback at construction
 * time, this assertion flips and the test fails LOUDLY — at which point
 * `createAuthorize` extraction can be dissolved (or this canary updated
 * to match the new contract). Without this gate, the workaround can rot
 * for years past its expiration.
 *
 * If this test fails on a NextAuth bump:
 *   1. Re-read `e2e-bypass-provider.ts` lines 43-50 for full context.
 *   2. Verify the behavior change is intentional in the new NextAuth
 *      version (release notes, changelog).
 *   3. Either inline `createAuthorize` back into `buildE2eBypassProvider`
 *      and delete this canary, or update the canary to lock the new
 *      contract.
 */
import Credentials from 'next-auth/providers/credentials';
import { describe, expect, it } from 'vitest';

describe('NextAuth Credentials() seam — canary for createAuthorize extraction', () => {
  it('provider.authorize remains the default stub (not the user-supplied fn) — locks the v5 type-config-helper contract', async () => {
    let userAuthorizeCalled = false;
    const provider = Credentials({
      // If NextAuth ever starts wrapping `authorize` at construction time,
      // this spy will flip and the assertion below will fail. That signals
      // the workaround in `e2e-bypass-provider.ts` can be dissolved.
      authorize: async () => {
        userAuthorizeCalled = true;
        return { id: 'sentinel-canary-id', email: 'sentinel@canary.test' };
      },
    });

    // Defensive: NextAuth's typing on the provider config makes
    // `provider.authorize` optional. Cast through unknown so the test
    // compiles even if the surface changes; the runtime assertion is
    // what we care about.
    const liveAuthorize = (provider as unknown as {
      authorize?: (
        creds: Record<string, unknown>,
        req: Request,
      ) => Promise<unknown>;
    }).authorize;

    expect(
      typeof liveAuthorize,
      'NextAuth Credentials() still exposes an `authorize` property on the provider — surface intact',
    ).toBe('function');

    // The actual probe: invoke the live authorize. Under v5 this hits the
    // stub and returns null/undefined; the user-supplied function is NOT
    // called. If either expectation flips, the seam may no longer be needed.
    const result = await liveAuthorize!({ email: 'probe@canary.test' }, new Request('http://localhost/'));

    expect(
      userAuthorizeCalled,
      'CANARY: NextAuth Credentials() now invokes the user-supplied authorize at runtime. ' +
        'The `createAuthorize` extraction in e2e-bypass-provider.ts may be dissolvable — ' +
        'revisit the workaround (see file header spike finding (c)).',
    ).toBe(false);

    expect(
      result,
      'CANARY: NextAuth Credentials() stub no longer returns null. ' +
        'Inspect the new contract before dissolving the createAuthorize seam.',
    ).toBeNull();
  });
});
