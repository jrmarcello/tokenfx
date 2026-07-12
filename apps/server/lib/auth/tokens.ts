/**
 * Token + key-id generators for the onboarding flow.
 *
 * - `generateInviteToken` produces 256 bits of entropy as 64 hex chars. The
 *   token is the natural primary key for `onboarding_invites`; the UNIQUE PK
 *   constraint defends against the (astronomically improbable) collision —
 *   we treat a unique-violation on insert as paranoia and retry once.
 * - `generateKeyId` produces a short, human-readable identifier (`k_` + 16
 *   hex chars = 64 bits of entropy) for `user_machines.key_id`. The shorter
 *   length keeps reporter logs and Bearer headers compact while staying well
 *   above any practical collision risk for a single-tenant fleet.
 *
 * Both generators are pure: every call uses fresh `crypto.randomBytes`. They do
 * not read environment, do not log, and have no DB dependency.
 */
import { createHash, randomBytes } from 'node:crypto';

export const generateInviteToken = (): string =>
  randomBytes(32).toString('hex');

export const generateKeyId = (): string => `k_${randomBytes(8).toString('hex')}`;

/**
 * Hashes an invite token for at-rest storage. The digest is the primary key
 * of `onboarding_invites` (`token_hash`) and the value redeem looks up; the
 * plaintext token exists only transiently (creation → invite URL → redeem
 * body) and is never persisted.
 *
 * Why plain SHA-256 (not bcrypt, not a peppered SHA-256):
 * - **The token is already brute-force-proof, so slow hashing buys nothing.**
 *   `generateInviteToken` yields 256 bits of crypto-random entropy. bcrypt
 *   (and other slow KDFs) exist to defend *low-entropy* secrets — passwords —
 *   against offline guessing. A 256-bit random value has no guessable
 *   structure, so the deliberate slowness only adds latency to the public
 *   redeem path with zero security benefit.
 * - **Equality-indexed lookup is a STRUCTURAL requirement, not a preference.**
 *   Redeem resolves the invite via `WHERE token_hash = ?` — a primary-key
 *   equality probe. bcrypt applies a fresh per-call salt, so the same token
 *   hashes to a different digest every time; that makes an indexed equality
 *   lookup impossible and would force a full-table `bcrypt.compare` scan on
 *   every unauthenticated redeem call. A fast, deterministic hash is required
 *   for the lookup to work at all.
 * - **No pepper.** Unlike `email-hash.ts` (which hashes low-entropy,
 *   enumerable emails and needs a pepper to resist rainbow tables), the token
 *   is high-entropy and non-enumerable — a precomputed table is infeasible, so
 *   a pepper would only add key-management surface for no gain.
 *
 * @param token - The raw invite token (64 hex chars from `generateInviteToken`).
 * @returns Hex-encoded SHA-256 of the token (64 hex chars).
 */
export const hashInviteToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
