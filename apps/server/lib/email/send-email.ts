import { z } from 'zod';
import { log as logger } from '@tokenfx/shared/logger';
import { err } from '@/lib/result';
import {
  sendEmail as stubSendEmail,
  type EmailError,
  type EmailInput,
  type EmailResult,
  type SendEmailFn,
} from './send-email-stub';
import { createSmtpSender, type SmtpConfig } from './send-email-smtp';

// Re-export the contract types so consumers can depend on the dispatcher
// module (`@/lib/email/send-email`) without reaching into the stub —
// the dispatcher IS the public surface.
export type { EmailError, EmailInput, EmailResult, SendEmailFn };

/**
 * Dispatcher: picks between the SMTP backend (`send-email-smtp.ts`) and
 * the console-log stub (`send-email-stub.ts`) based on env at module
 * init. Public surface is a single `SendEmailFn` (the same contract
 * both backends honor) so callers never branch on backend.
 *
 * Selection rules (evaluated ONCE at module init):
 *   - `SMTP_HOST` unset or empty  → `sendEmail` IS the stub
 *   - `SMTP_HOST` set + 5-tuple valid → `sendEmail` IS the SMTP sender
 *       (built ONCE via `createSmtpSender` to preserve the nodemailer
 *        connection pool across calls)
 *   - `SMTP_HOST` set + any field missing/invalid → singleton holds a
 *       `config-error` sentinel; every `sendEmail` call returns
 *       `{ok: false, error: {reason: 'config-error', message}}`.
 *       Fail-fast — no per-call init retry.
 */
/**
 * Per-field schema fragments. We author the `error` message at the
 * field level (rather than on `.min(1)` alone) so a missing env var
 * — which fails the `string` type guard before `.min(1)` even runs —
 * still surfaces the field name in the operator-facing message.
 */
const requiredString = (field: string) =>
  z
    .string({ error: () => `${field} missing` })
    .min(1, { error: () => `${field} missing` });

const smtpConfigSchema = z.object({
  SMTP_HOST: requiredString('SMTP_HOST'),
  SMTP_PORT: z.coerce
    .number({ error: () => 'SMTP_PORT must be a number' })
    .int({ error: () => 'SMTP_PORT must be an integer' })
    .positive({ error: () => 'SMTP_PORT must be positive' }),
  SMTP_USER: requiredString('SMTP_USER'),
  SMTP_PASS: requiredString('SMTP_PASS'),
  SMTP_FROM: requiredString('SMTP_FROM'),
});

/**
 * Factory shape: production uses `createSmtpSender`; tests can inject a
 * stub via `__resetDispatcher(factory)` to exercise the SMTP-selection
 * branch without standing up a real SMTP server.
 */
export type SmtpSenderFactory = (config: SmtpConfig) => SendEmailFn;

const defaultSmtpFactory: SmtpSenderFactory = (config) => createSmtpSender(config);

/**
 * Format Zod field issues into a single human message. Lists the first
 * failing field by name so the operator can grep for "SMTP_FROM" in
 * the error and know exactly what to set.
 */
const formatConfigError = (issues: z.ZodIssue[]): string => {
  if (issues.length === 0) return 'SMTP config invalid';
  const [first] = issues;
  if (!first) return 'SMTP config invalid';
  // Each issue's `message` already names the field (e.g. "SMTP_FROM missing")
  // because we authored them in `smtpConfigSchema` above.
  return first.message;
};

const buildDispatcher = (factory: SmtpSenderFactory): SendEmailFn => {
  const host = process.env.SMTP_HOST;
  if (host === undefined || host === '') {
    logger.debug('email-dispatcher-init', { backend: 'stub' });
    return stubSendEmail;
  }

  const parsed = smtpConfigSchema.safeParse({
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
  });

  if (!parsed.success) {
    const message = formatConfigError(parsed.error.issues);
    logger.warn('email-dispatcher-init', { backend: 'config-error', message });
    const reason: EmailError['reason'] = 'config-error';
    // Compile-time exhaustiveness: any future addition to
    // `EmailError['reason']` will surface here as a type error,
    // forcing the dispatcher to consider the new case.
    const _exhaustive: EmailError['reason'] = reason satisfies EmailError['reason'];
    void _exhaustive;
    const sentinelError: EmailError = { reason, message };
    return async () => err<EmailError>(sentinelError);
  }

  const config: SmtpConfig = {
    host: parsed.data.SMTP_HOST,
    port: parsed.data.SMTP_PORT,
    user: parsed.data.SMTP_USER,
    pass: parsed.data.SMTP_PASS,
    from: parsed.data.SMTP_FROM,
  };
  logger.info('email-dispatcher-init', { backend: 'smtp', host: config.host });
  return factory(config);
};

let dispatched: SendEmailFn = buildDispatcher(defaultSmtpFactory);

/**
 * Public surface: the single `SendEmailFn` consumed by app code. The
 * underlying implementation is fixed at module init (or after
 * `__resetDispatcher`) and never re-evaluates per call.
 */
export const sendEmail: SendEmailFn = (input) => dispatched(input);

/**
 * Test seam — re-reads env and rebuilds the dispatcher. Optionally
 * accepts a stub SMTP factory so tests can assert "SMTP branch was
 * selected" without standing up a real SMTP server. Production code
 * MUST NOT call this; it exists exclusively for `*.test.ts`.
 */
export const __resetDispatcher = (factory?: SmtpSenderFactory): void => {
  dispatched = buildDispatcher(factory ?? defaultSmtpFactory);
};
