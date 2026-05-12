import crypto from 'node:crypto';
import { log as logger } from '@root/logger';
import { ok, type Result } from '@/lib/result';

export type EmailInput = {
  to: string;
  subject: string;
  body: string;
};

export type EmailResult = {
  messageId: string;
};

export type EmailError = {
  reason: 'transient' | 'permanent' | 'invalid-recipient' | 'config-error';
  message: string;
};

export type SendEmailFn = (input: EmailInput) => Promise<Result<EmailResult, EmailError>>;

/**
 * Console-log stub for spec b. Real SMTP/SES backend deferred to follow-up
 * spec `central-server-email-channel.md`.
 *
 * Privacy invariant: NEVER logs the raw `to` address — only its SHA-256
 * hash. The `subject` is logged plaintext (no PII expected; templates are
 * project-controlled). The `body` is NEVER logged.
 *
 * Returns Result for typed error handling — NEVER throws. Real SMTP/SES
 * wiring preserves the same signature.
 */
export const sendEmail: SendEmailFn = async (input) => {
  const toHash = crypto.createHash('sha256').update(input.to).digest('hex');
  logger.info('email-send-stub', {
    to_hash: toHash,
    subject: input.subject,
    body_length: input.body.length,
  });
  return ok({ messageId: `stub-${crypto.randomUUID()}` });
};
