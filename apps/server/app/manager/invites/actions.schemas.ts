/**
 * Boundary-validation schemas for invite-management Server Actions.
 *
 * Lives separately from `actions.ts` because Next.js' `'use server'`
 * directive only permits async-function exports — re-exporting a Zod
 * schema or a typed constant from the same module fails compilation
 * (caught by the build error from any E2E that visits
 * `/manager/invites/create`).
 *
 * Test-importers (`actions.test.ts`) import the schema from here so
 * the parse/transform contract is unit-testable without crossing the
 * Server Actions boundary.
 */
import { z } from 'zod';

/**
 * Supported SSO provider keys. Matches the v2-sso spec REQ-7 enumeration
 * (Google, Okta, Microsoft, Auth0). Mirrored in the form UI checkbox group.
 */
export const SSO_PROVIDER_VALUES = ['google', 'okta', 'microsoft', 'auth0'] as const;

/**
 * Standalone Zod schema for the `allowed_sso_providers` invite field.
 *
 * Extracted from `createInviteFormSchema` to enable direct unit-testing
 * of the parse/transform contract without going through the full Server
 * Action — see `.specs/sso-test-coverage-orphans.md` REQ-1.
 *
 * Behavior contract:
 *   - Write-path (this schema): `.min(1)` rejects empty arrays. A manager
 *     creating a NEW invite must select ≥1 provider explicitly.
 *   - Read-path (legacy DB rows): an empty array means "any provider
 *     allowed" — `enforceAllowedProviders` in `lib/auth/sso-auto-provision.ts`
 *     short-circuits on `[]` to preserve pre-spec-c invites.
 *   - `.transform` dedupes via `Set` (first-seen order preserved) — same
 *     provider clicked twice in the UI shouldn't bloat the DB column.
 *   - Throws `ZodError` on `.parse()` of invalid input (no `.catch()`);
 *     callers using `.safeParse()` get a tagged result.
 */
export const allowedSsoProvidersSchema = z
  .array(z.enum(SSO_PROVIDER_VALUES))
  .min(1, 'allowed_sso_providers requires at least one provider')
  .transform((arr) => Array.from(new Set(arr)));
