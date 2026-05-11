/**
 * Flash cookie helper for the show-once invite URL (REQ-22).
 *
 * The manager creates an invite via Server Action, the action sets a flash
 * cookie containing the full `onboard_url` (with the 64-hex token in the
 * fragment), and the `/manager/invites/created` page reads + DELETES the
 * cookie before rendering. A page reload finds the cookie absent and shows
 * an empty state — the URL is shown EXACTLY once.
 *
 * Tamper resistance: the cookie value is `${b64payload}.${b64sig}` where
 * `b64sig` is HMAC-SHA256(payload, AUTH_SECRET). Reading verifies the HMAC
 * with constant-time comparison and returns `null` on any mismatch
 * (truncated, swapped, missing). The cookie is then deleted regardless of
 * verification outcome (one-shot semantics — even invalid attempts burn
 * the cookie).
 *
 * Why HMAC and not encryption: the URL contains the token, which is
 * privacy-sensitive but not a long-lived secret on its own — it's already
 * in the manager's session URL bar a moment earlier. The threat model is
 * accidental tampering / a developer hand-editing devtools, not a
 * sophisticated attacker. HMAC + httpOnly + secure + sameSite=strict +
 * 120s TTL is sufficient and keeps this module tiny.
 *
 * This module is FRAMEWORK-AGNOSTIC at the core: `signFlashPayload` and
 * `verifyFlashPayload` operate on plain strings and a secret, no
 * `next/headers` import. The Server-Action-side wrappers
 * (`setFlashCookie` / `readAndDeleteFlashCookie`) accept the cookie store
 * by parameter so unit tests inject a hand-written stub.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const FLASH_COOKIE_NAME = 'onboard_flash';
export const FLASH_COOKIE_PATH = '/manager/invites/created';
export const FLASH_COOKIE_MAX_AGE_SECONDS = 120;

/**
 * Minimal subset of Next.js's `cookies()` store the helpers depend on.
 * Defining it here lets unit tests pass a hand-written stub without
 * pulling `next/headers` into the test runtime.
 */
export type FlashCookieStore = {
  get: (name: string) => { value: string } | undefined;
  set: (
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'strict';
      path: string;
      maxAge: number;
    },
  ) => void;
  delete: (name: string) => void;
};

const b64urlEncode = (bytes: Uint8Array | Buffer): string =>
  Buffer.from(bytes).toString('base64url');

const b64urlDecode = (s: string): Buffer => Buffer.from(s, 'base64url');

/**
 * Returns the HMAC pepper for flash-cookie signing. Reads `AUTH_SECRET`
 * (primary) or `NEXTAUTH_SECRET` (alias).
 *
 * Hardened against load-order regressions: calls `assertFlashSecretAvailable`
 * on every invocation so the empty-string fallback is unreachable in
 * production regardless of whether the caller went through `auth.ts`
 * module load first. In dev/test the guard is a no-op (returns silently
 * when `NODE_ENV !== 'production'`), preserving the `''` fallback for
 * unit tests that exercise the framework-agnostic core via the
 * explicit-secret overload.
 */
const getSecret = (): string => {
  assertFlashSecretAvailable(process.env);
  const s = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!s) return '';
  return s;
};

/**
 * Boot-time guard: fails fast in production if both `AUTH_SECRET` and
 * `NEXTAUTH_SECRET` are missing/empty. Defense-in-depth alongside the
 * `auth.ts` module-scope `AUTH_SECRET` guard — that guard fires first
 * for the canonical entry path; this assertion is reachable when a
 * different entry path imports `flash-cookie` directly.
 *
 * Non-`production` `NODE_ENV` values (including `'development'`, `'test'`,
 * `'production-staging'`, unset, `''`) do NOT trigger — they delegate to
 * the existing `AUTH_SECRET` guard in `auth.ts:18-26` which uses negation
 * without checking `NODE_ENV`.
 */
export const assertFlashSecretAvailable = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (env.NODE_ENV !== 'production') return;
  if (!env.AUTH_SECRET && !env.NEXTAUTH_SECRET) {
    throw new Error(
      'AUTH_SECRET (or NEXTAUTH_SECRET) is required for flash cookies. Refusing to boot.',
    );
  }
};

/**
 * Sign an arbitrary payload string into the cookie value. Returns
 * `${b64urlPayload}.${b64urlSig}`. Pass `secret` explicitly in tests;
 * production calls omit it and the env-resolved secret is used.
 */
export const signFlashPayload = (payload: string, secret?: string): string => {
  const s = secret ?? getSecret();
  const sig = createHmac('sha256', s).update(payload, 'utf8').digest();
  return `${b64urlEncode(Buffer.from(payload, 'utf8'))}.${b64urlEncode(sig)}`;
};

/**
 * Verify a signed cookie value. Returns the payload string on success or
 * `null` on any tampering / shape mismatch. Constant-time signature
 * comparison via `crypto.timingSafeEqual`.
 */
export const verifyFlashPayload = (
  cookieValue: string,
  secret?: string,
): string | null => {
  const s = secret ?? getSecret();
  const dot = cookieValue.lastIndexOf('.');
  // Reject only when no separator OR no signature segment after it. An
  // empty payload (`.{sig}`) is legal — `signFlashPayload('', ...)` produces
  // exactly that shape.
  if (dot < 0 || dot === cookieValue.length - 1) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  const sigB64 = cookieValue.slice(dot + 1);

  let payloadBuf: Buffer;
  let sigBuf: Buffer;
  try {
    payloadBuf = b64urlDecode(payloadB64);
    sigBuf = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (sigBuf.length === 0) return null;

  const expected = createHmac('sha256', s).update(payloadBuf).digest();
  if (expected.length !== sigBuf.length) return null;
  if (!timingSafeEqual(expected, sigBuf)) return null;

  return payloadBuf.toString('utf8');
};

/**
 * Set the flash cookie on the given cookie store. Caller supplies the
 * payload (typically the full onboard URL). Attributes are fixed by the
 * spec: `httpOnly`, `secure` (production only), `sameSite=strict`,
 * `path=/manager/invites/created`, `maxAge=120`.
 */
export const setFlashCookie = (
  store: FlashCookieStore,
  payload: string,
  options?: { secret?: string; secure?: boolean },
): void => {
  const value = signFlashPayload(payload, options?.secret);
  const secure = options?.secure ?? process.env.NODE_ENV === 'production';
  store.set(FLASH_COOKIE_NAME, value, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: FLASH_COOKIE_PATH,
    maxAge: FLASH_COOKIE_MAX_AGE_SECONDS,
  });
};

/**
 * Read the flash cookie WITHOUT deleting it. Returns the verified payload
 * (the URL) or `null` if absent / tampered. Use from Server Components
 * (Next.js 15 forbids `cookies().delete()` in Server Components — they
 * can read but not write). For the actual delete, use `deleteFlashCookie`
 * from a Server Action / Route Handler. Pair with a Client useEffect
 * fired AFTER render to invalidate the cookie one-shot.
 */
export const readFlashCookie = (
  store: FlashCookieStore,
  options?: { secret?: string },
): string | null => {
  const cookie = store.get(FLASH_COOKIE_NAME);
  if (!cookie) return null;
  return verifyFlashPayload(cookie.value, options?.secret);
};

/**
 * Delete the flash cookie. Must be called from a Server Action or
 * Route Handler (Next.js 15 cookie-mutation constraint). Idempotent —
 * safe to call when the cookie is absent.
 */
export const deleteFlashCookie = (store: FlashCookieStore): void => {
  store.delete(FLASH_COOKIE_NAME);
};

/**
 * Read + delete in one shot. Use ONLY from a Server Action or Route
 * Handler — Server Components must use `readFlashCookie` (read-only)
 * instead. Kept here for callers that don't need the split.
 */
export const readAndDeleteFlashCookie = (
  store: FlashCookieStore,
  options?: { secret?: string },
): string | null => {
  const cookie = store.get(FLASH_COOKIE_NAME);
  if (!cookie) return null;
  const verified = verifyFlashPayload(cookie.value, options?.secret);
  // One-shot: delete regardless of verification outcome (only when cookie was present).
  store.delete(FLASH_COOKIE_NAME);
  return verified;
};
