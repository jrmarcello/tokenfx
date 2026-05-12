import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { log as logger } from '@root/logger';
import { err, ok } from '@/lib/result';
import type { EmailError, EmailResult, SendEmailFn } from './send-email-stub';

/**
 * Real SMTP backend for `sendEmail`. Mirrors the contract of
 * `send-email-stub.ts` (same `EmailInput → Result<EmailResult, EmailError>`
 * shape, NEVER throws) so the two are drop-in substitutable by the
 * dispatcher.
 *
 * Built as a factory so `nodemailer.createTransport` is invoked exactly
 * ONCE per config — the resulting Transporter keeps its SMTP connection
 * pool warm across `sendEmail` calls. Re-creating the transporter per
 * call would defeat pooling.
 *
 * Privacy invariant (matches stub): NEVER logs the raw `to` address,
 * the `body`, or any plaintext form of those. Logs the SHA-256 hex of
 * `to`, the `subject` plaintext (templates are project-controlled,
 * no PII expected), and `body_length`.
 */
export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

/**
 * Subset of nodemailer's `Transporter` we actually consume.
 *
 * Keeping the surface tight (a) clarifies the contract for stub
 * Transporters in tests, and (b) avoids leaking nodemailer's `any`-
 * typed `SentMessageInfo` into our code (`SentMessageInfo = any`
 * is what `@types/nodemailer` declares at the top level).
 */
export type SmtpTransport = {
  sendMail: (msg: SmtpMessage) => Promise<{ messageId: string }>;
};

type SmtpMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

/**
 * Optional test seam — injects a stub `SmtpTransport` instead of building
 * one via `nodemailer.createTransport`. Production code never passes
 * `transportFactory`; tests in `send-email-smtp.test.ts` use it to swap
 * in a hand-written stub Transporter (no mocking framework).
 */
export type CreateSmtpSenderOptions = {
  transportFactory?: (config: SmtpConfig) => SmtpTransport;
};

// Non-negotiable timeouts (REQ-11 in central-server-onboarding-v2-sso):
// worst-case SMTP send must return `transient` in under 15s so the auth
// flow is never stalled by a hung SMTP server. Sum is bounded by
// `socketTimeout` once the connection is established; the connection
// + greeting timeouts cap the pre-handshake phase at 10s combined.
const CONNECTION_TIMEOUT_MS = 5_000;
const GREETING_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 10_000;

// Module-level sentinel — wraps `setTimeout`'s rejection in a typed
// shape `mapNodemailerError` can identify as a socket timeout fired
// by US (not by nodemailer). Keyed by a Symbol so user-supplied errors
// can't impersonate it.
const TIMEOUT_SENTINEL = Symbol('send-email-smtp.socket-timeout');

type TimeoutSentinel = { readonly [TIMEOUT_SENTINEL]: true };

const isTimeoutSentinel = (value: unknown): value is TimeoutSentinel =>
  typeof value === 'object' && value !== null && TIMEOUT_SENTINEL in value;

// nodemailer error shape we care about. We narrow `unknown` to this
// before consulting `code` / `responseCode` / `rejected`.
type NodemailerErrorShape = {
  code?: unknown;
  responseCode?: unknown;
  rejected?: unknown;
  message?: unknown;
};

const isObjectWithKnownErrorShape = (
  value: unknown,
): value is NodemailerErrorShape =>
  typeof value === 'object' && value !== null;

const sha256Hex = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex');

/**
 * Maps a thrown value from `transporter.sendMail` (or our own socket
 * timeout sentinel) into a typed `EmailError`. Conservative: unknown
 * codes default to `transient` so the auth flow can retry rather than
 * silently fail-fast on a code we haven't classified yet.
 */
const mapNodemailerError = (thrown: unknown): EmailError => {
  if (isTimeoutSentinel(thrown)) {
    return { reason: 'transient', message: 'socket timeout' };
  }

  if (!isObjectWithKnownErrorShape(thrown)) {
    // Non-Error thrown value (e.g. a bare string) — surface as transient.
    return {
      reason: 'transient',
      message:
        typeof thrown === 'string' ? thrown : 'unknown SMTP transport error',
    };
  }

  const code = typeof thrown.code === 'string' ? thrown.code : '';
  const responseCode =
    typeof thrown.responseCode === 'number' ? thrown.responseCode : undefined;
  const rejected = Array.isArray(thrown.rejected) ? thrown.rejected : undefined;
  const message =
    typeof thrown.message === 'string' && thrown.message.length > 0
      ? thrown.message
      : 'SMTP send failed';

  switch (code) {
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'EDNS':
      return { reason: 'transient', message };
    case 'EAUTH':
      return { reason: 'permanent', message };
    case 'EENVELOPE': {
      // nodemailer raises EENVELOPE for two distinct conditions:
      //   1. Recipient(s) explicitly rejected by the server (populates
      //      `rejected`) — caller should NOT retry the same address.
      //   2. Permanent envelope error (e.g. 5xx response without a
      //      rejected list — e.g. malformed sender, policy denial) —
      //      treat as `permanent`.
      if (rejected && rejected.length > 0) {
        return { reason: 'invalid-recipient', message };
      }
      if (responseCode !== undefined && responseCode >= 500) {
        return { reason: 'permanent', message };
      }
      // Unknown EENVELOPE flavor — conservative transient.
      return { reason: 'transient', message };
    }
    default:
      return { reason: 'transient', message };
  }
};

/**
 * Builds a `SendEmailFn` bound to the given SMTP config. The underlying
 * `nodemailer.Transporter` is constructed ONCE here (preserving the
 * SMTP connection pool across calls) and reused for every dispatched
 * email.
 *
 * Never throws — every failure mode is captured as `{ok: false, error}`.
 */
export const createSmtpSender = (
  config: SmtpConfig,
  options: CreateSmtpSenderOptions = {},
): SendEmailFn => {
  const factory =
    options.transportFactory ??
    ((cfg: SmtpConfig): SmtpTransport =>
      nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        // `secure` is implicit: nodemailer enables TLS automatically for
        // port 465; ports 587/25 negotiate STARTTLS as the server
        // advertises it. We don't override `secure` — relying on the
        // library default is correct for the standard ports we support.
        auth: { user: cfg.user, pass: cfg.pass },
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      }));

  // Built ONCE per `createSmtpSender` call — pool is preserved.
  const transport: SmtpTransport = factory(config);

  return async (input) => {
    const toHash = sha256Hex(input.to);

    // Hard wall-clock cap. nodemailer's own `socketTimeout` fires only
    // after the TCP connection is established and idle; a transport
    // stub that returns a never-resolving Promise (TC-I-28b) would
    // otherwise hang forever. This wrapper guarantees the contract:
    // "auth flow never stalls > SOCKET_TIMEOUT_MS on email send".
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        const sentinel: TimeoutSentinel = { [TIMEOUT_SENTINEL]: true };
        reject(sentinel);
      }, SOCKET_TIMEOUT_MS);
      // Don't keep the process alive solely for this timer (e.g. CLI
      // script that exits after sending one email).
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    try {
      const info = await Promise.race([
        transport.sendMail({
          from: config.from,
          to: input.to,
          subject: input.subject,
          text: input.body,
        }),
        timeoutPromise,
      ]);

      logger.info('email-send-smtp', {
        to_hash: toHash,
        subject: input.subject,
        body_length: input.body.length,
        message_id: info.messageId,
      });

      return ok<EmailResult>({ messageId: info.messageId });
    } catch (thrown) {
      const mapped = mapNodemailerError(thrown);
      logger.warn('email-send-smtp-failed', {
        to_hash: toHash,
        subject: input.subject,
        body_length: input.body.length,
        reason: mapped.reason,
        // `message` is nodemailer's own error message — known to be
        // free of the raw recipient under the standard error codes we
        // map. We deliberately do NOT log `error.rejected` (it contains
        // the raw address), `error.response`, or `error.command` (may
        // echo address fragments via the `RCPT TO:<addr>` command).
        error_message: mapped.message,
      });
      return err<EmailError>(mapped);
    }
  };
};
