/**
 * Pre-existing-binding confirmation email helper (T11 M11.2 + Decisão #19).
 *
 * Sends a notification email when an SSO sign-in attempt is rejected
 * because the email is already bound to a different account/provider.
 * Includes geographic + browser anomaly hints so the legitimate owner can
 * decide whether to escalate.
 *
 * ## Why an in-process rate-limiter (Decisão #19)
 *
 * The threat model bounds notification spam at **3 emails / 24h per
 * `email_hash`**. An attacker who can repeatedly trigger the rejected
 * outcome (e.g. probing email enumeration) would otherwise flood the
 * legitimate owner's inbox. We rate-limit on `email_hash` (not `to`) so
 * the bucket key matches the audit row's identity column — and we never
 * keep the plaintext address in memory longer than the call.
 *
 * The state lives in a module-level `Map<emailHash, timestamps[]>`. This is
 * acceptable here because:
 * - The central server is a single Node process (no horizontal scaling in
 *   the v2 design — see threat model §"Operational scope").
 * - The window is short (24h) and entries self-prune on every check.
 * - Restart resets the counters, which is the correct behavior: a process
 *   restart is rare enough that legitimate users aren't affected, and an
 *   attacker doesn't gain meaningfully more reach.
 *
 * If the topology ever changes (multi-instance), this needs to move to a
 * shared store (Redis / SQLite table). The contract stays the same.
 *
 * ## NEVER throws
 *
 * Per REQ-23 the underlying `sendEmail` never throws — it returns
 * `Result<EmailResult, EmailError>`. This helper passes that contract
 * through: callers (decision-engine on the `rejected-pre-existing-binding`
 * outcome) receive a typed `SendResult` and decide how to log it.
 */
import { log as logger } from '@tokenfx/shared/logger';
import { sendEmail as defaultSendEmail, type SendEmailFn } from '@/lib/email/send-email';
import { hashEmail } from './email-hash';

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * In-process rate-limit state, keyed by `hashEmail(to)`. Values are
 * timestamps (ms since epoch) of *successful* sends within the rolling
 * window. Failed sends do NOT consume a slot (a transient SMTP outage
 * should never lock the user out of legitimate notifications).
 */
const rateLimitState: Map<string, number[]> = new Map();

export type PreExistingBindingEmailInput = {
  to: string;
  city: string | null;
  browser: string | null;
  time: Date;
};

export type SendResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'rate-limited' | 'send-failed'; emailHash: string };

/**
 * Send pre-existing-binding confirmation email.
 *
 * @param input - Recipient + anomaly context (city, browser, time).
 * @param deps - Injectable `sendEmail` for testability. Defaults to the
 *   module-level `sendEmail` (TASK-6 stub today, real provider later).
 * @returns Typed `SendResult`. Caller is responsible for audit-log
 *   metadata (e.g. `email_rate_limited: true`).
 */
export const sendPreExistingBindingEmail = async (
  input: PreExistingBindingEmailInput,
  deps: { sendEmail: SendEmailFn } = { sendEmail: defaultSendEmail },
): Promise<SendResult> => {
  const emailHash = hashEmail(input.to);

  // Prune expired entries on every check (lazy eviction — no background job).
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const history = (rateLimitState.get(emailHash) ?? []).filter((ts) => ts >= windowStart);

  if (history.length >= RATE_LIMIT_MAX) {
    logger.warn('pre-existing-binding-email-rate-limited', {
      // Truncated hash prefix: enough to correlate audit rows for debugging,
      // not enough to make the value useful in a log leak.
      email_hash_prefix: emailHash.slice(0, 8),
      attempts_in_window: history.length,
    });
    rateLimitState.set(emailHash, history);
    return { sent: false, reason: 'rate-limited', emailHash };
  }

  const cityLine = input.city ?? '(location unknown)';
  // SECURITY: sanitize `browser` (raw user-agent from request headers) before
  // embedding in email body — strip CR/LF to prevent header/body injection on
  // future SMTP backends, and truncate to 512 chars (same boundary as the
  // audit-log writer applies). The stub backend ignores the body, but the
  // pluggable interface lets a future real-backend handle this string; we
  // sanitize at the source so every backend gets a safe value.
  const browserSanitized = (input.browser ?? '(browser unknown)')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 512);
  const browserLine = browserSanitized;
  const timeLine = input.time.toISOString();
  const subject = 'TokenFx — sign-in attempt asks to bind to your account';
  const body = [
    'A sign-in attempt was made for your TokenFx account.',
    '',
    `Location: ${cityLine}`,
    `Browser : ${browserLine}`,
    `Time    : ${timeLine}`,
    '',
    'If this was you, no action is needed.',
    'If this was not you, contact your org admin to revoke the attempt.',
  ].join('\n');

  // `sendEmail` is contractually non-throwing (REQ-23). We deliberately do
  // NOT wrap this in try/catch: if a future implementation violates the
  // contract by throwing, we want that bug to surface in the decision-engine
  // logs rather than being silently absorbed here.
  const result = await deps.sendEmail({ to: input.to, subject, body });

  if (!result.ok) {
    logger.warn('pre-existing-binding-email-send-failed', {
      email_hash_prefix: emailHash.slice(0, 8),
      reason: result.error.reason,
    });
    // Persist the pruned-but-not-incremented history so future calls still
    // see the correct expiration timeline for prior successful sends.
    rateLimitState.set(emailHash, history);
    return { sent: false, reason: 'send-failed', emailHash };
  }

  // Successful send: consume a rate-limit slot.
  history.push(now);
  rateLimitState.set(emailHash, history);
  return { sent: true, messageId: result.value.messageId };
};

/**
 * Test seam: clear all rate-limit state. Used by `beforeEach` in the
 * companion test file so per-test isolation is guaranteed without relying
 * on module reloads.
 */
export const __resetPreExistingBindingEmailState = (): void => {
  rateLimitState.clear();
};
