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
 * Both helpers are pure: every call uses fresh `crypto.randomBytes`. They do
 * not read environment, do not log, and have no DB dependency.
 */
import { randomBytes } from 'node:crypto';

export const generateInviteToken = (): string =>
  randomBytes(32).toString('hex');

export const generateKeyId = (): string => `k_${randomBytes(8).toString('hex')}`;
