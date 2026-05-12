import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log as logger } from '@root/logger';
import { createSmtpSender, type SmtpConfig } from './send-email-smtp';

/**
 * Hand-written stub Transporter — implements only the surface
 * `createSmtpSender` consumes (`sendMail`). No mocking framework.
 *
 * Each test seeds the stub's behavior (resolve / reject / hang) via
 * the `programmed` config below before invoking the sender.
 */
type Programmed =
  | { kind: 'resolve'; info: { messageId: string } }
  | { kind: 'reject'; error: NodemailerErrorShape }
  | { kind: 'hang' };

// Mirrors nodemailer's error shape that we care about — `code` is the
// primary discriminator, `responseCode` distinguishes 5xx from 4xx for
// EAUTH/EENVELOPE, and `rejected` is populated on EENVELOPE failures.
type NodemailerErrorShape = Error & {
  code?: string;
  responseCode?: number;
  rejected?: string[];
};

type StubTransporter = {
  sendMail: (msg: unknown) => Promise<{ messageId: string }>;
  sendMailCalls: Array<unknown>;
};

const makeNodemailerError = (
  message: string,
  code: string,
  extras: { responseCode?: number; rejected?: string[] } = {},
): NodemailerErrorShape => {
  const err = new Error(message) as NodemailerErrorShape;
  err.code = code;
  if (extras.responseCode !== undefined) err.responseCode = extras.responseCode;
  if (extras.rejected !== undefined) err.rejected = extras.rejected;
  return err;
};

const makeStubTransporter = (programmed: Programmed): StubTransporter => {
  const calls: Array<unknown> = [];
  return {
    sendMailCalls: calls,
    sendMail: (msg) => {
      calls.push(msg);
      switch (programmed.kind) {
        case 'resolve':
          return Promise.resolve(programmed.info);
        case 'reject':
          return Promise.reject(programmed.error);
        case 'hang':
          // Never resolves; the sender's own timeout must fire.
          return new Promise<{ messageId: string }>(() => {});
      }
    },
  };
};

const baseConfig: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  user: 'mailer',
  pass: 'secret',
  from: 'noreply@example.com',
};

describe('createSmtpSender', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    vi.useRealTimers();
  });

  // TC-I-27 — happy path: nodemailer transport is created once, sendMail
  // is invoked with subject/body, and the messageId is returned.
  it('sends email via SMTP transport on happy path', async () => {
    const stub = makeStubTransporter({
      kind: 'resolve',
      info: { messageId: '<abc@smtp.example.com>' },
    });
    let factoryCalls = 0;
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => {
        factoryCalls++;
        return stub;
      },
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 'Welcome',
      body: 'Hello there',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toBe('<abc@smtp.example.com>');
    }
    // Factory called exactly once at sender creation (preserves pool).
    expect(factoryCalls).toBe(1);
    // sendMail called once with the right envelope.
    expect(stub.sendMailCalls).toHaveLength(1);
    const mail = stub.sendMailCalls[0] as Record<string, unknown>;
    expect(mail.from).toBe('noreply@example.com');
    expect(mail.to).toBe('alice@example.com');
    expect(mail.subject).toBe('Welcome');
    // Body is sent either as `text` or `html`; we accept either as long
    // as the content matches. Spec doesn't mandate HTML — text is fine.
    expect(mail.text ?? mail.html).toBe('Hello there');
  });

  // TC-I-27b — factory called once across multiple sends (preserves pool).
  it('reuses the same transport across multiple sendEmail calls', async () => {
    const stub = makeStubTransporter({
      kind: 'resolve',
      info: { messageId: '<pooled@smtp.example.com>' },
    });
    let factoryCalls = 0;
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => {
        factoryCalls++;
        return stub;
      },
    });

    await sendEmail({ to: 'a@example.com', subject: 's', body: 'b' });
    await sendEmail({ to: 'b@example.com', subject: 's', body: 'b' });
    await sendEmail({ to: 'c@example.com', subject: 's', body: 'b' });

    expect(factoryCalls).toBe(1);
    expect(stub.sendMailCalls).toHaveLength(3);
  });

  // TC-I-28 — transport throws ETIMEDOUT → transient.
  it('maps ETIMEDOUT to transient error', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('connection timed out', 'ETIMEDOUT'),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('transient');
    }
  });

  // TC-I-28 variants — ECONNREFUSED / ESOCKET also map to transient.
  it.each([
    ['ECONNREFUSED', 'connection refused'],
    ['ESOCKET', 'socket error'],
    ['ECONNECTION', 'connection closed unexpectedly'],
    ['EDNS', 'dns failure'],
  ])('maps %s to transient error', async (code, message) => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError(message, code),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('transient');
    }
  });

  // TC-I-28b — transport that never resolves → transient within socketTimeout.
  it('returns transient error within configured socketTimeout when transport hangs', async () => {
    vi.useFakeTimers();
    const stub = makeStubTransporter({ kind: 'hang' });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const resultPromise = sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    // Advance past socketTimeout (10s). Use runAllTimersAsync so
    // microtasks queued by the timeout callback flush before we await.
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('transient');
    }
  });

  // TC-I-29 — EENVELOPE with rejected recipients → invalid-recipient.
  it('maps EENVELOPE with rejected recipients to invalid-recipient', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('invalid recipient', 'EENVELOPE', {
        rejected: ['alice@example.com'],
      }),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid-recipient');
    }
  });

  // EAUTH → permanent (5xx implied by AUTH semantics).
  it('maps EAUTH to permanent error', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('authentication failed', 'EAUTH', {
        responseCode: 535,
      }),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('permanent');
    }
  });

  // EENVELOPE with 5xx response and no rejected list → permanent
  // (distinguishes "address malformed/permanent" from "transient").
  it('maps EENVELOPE 5xx without rejected list to permanent error', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('mailbox unavailable', 'EENVELOPE', {
        responseCode: 550,
      }),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('permanent');
    }
  });

  // Unknown error code → transient (safe default — auth flow can retry).
  it('maps unknown error codes to transient', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('mystery failure', 'EWHATEVER'),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('transient');
    }
  });

  // Non-Error thrown values (e.g. string, undefined) still produce a typed
  // Result — never propagates as an exception.
  it('never throws even when transport throws non-Error values', async () => {
    const stub: StubTransporter = {
      sendMailCalls: [],
      sendMail: () => {
        // Tests defensive narrowing — return a rejected Promise with a
        // non-Error value (same handling path as `throw 'boom'`).
        return Promise.reject('boom' as unknown as Error);
      },
    };
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });

    await expect(
      sendEmail({ to: 'alice@example.com', subject: 's', body: 'b' }),
    ).resolves.toMatchObject({ ok: false });
  });

  // TC-I-31 — privacy invariant: raw `to` address NEVER appears in any
  // log payload from this module. Only the SHA-256 hex hash may be logged.
  it('never logs the raw recipient address on happy path', async () => {
    const stub = makeStubTransporter({
      kind: 'resolve',
      info: { messageId: '<x@smtp.example.com>' },
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });
    const to = 'bob.unique-marker-9f3a@example.com';

    await sendEmail({ to, subject: 'Hi', body: 'body' });

    const allLogCalls = [
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...debugSpy.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain(to);
    expect(serialized).not.toContain('bob.unique-marker-9f3a');

    // If anything was logged with a to_hash, it must equal SHA-256(to).
    const expectedHash = crypto.createHash('sha256').update(to).digest('hex');
    // At minimum we want SOME observability — assert at least one log
    // entry exists and contains the hash (not the raw address).
    expect(allLogCalls.length).toBeGreaterThan(0);
    expect(serialized).toContain(expectedHash);
  });

  // TC-I-31 (error path) — error-path logging also strips the raw `to`.
  it('never logs the raw recipient address on error path', async () => {
    const stub = makeStubTransporter({
      kind: 'reject',
      error: makeNodemailerError('boom', 'ETIMEDOUT'),
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });
    const to = 'carol.unique-marker-7b2c@example.com';

    await sendEmail({ to, subject: 'Hi', body: 'body' });

    const allLogCalls = [
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...debugSpy.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain(to);
    expect(serialized).not.toContain('carol.unique-marker-7b2c');
  });

  // Body content is never logged (PII / message content safety).
  it('never logs the raw body content', async () => {
    const stub = makeStubTransporter({
      kind: 'resolve',
      info: { messageId: '<x@smtp.example.com>' },
    });
    const sendEmail = createSmtpSender(baseConfig, {
      transportFactory: () => stub,
    });
    const body = 'super-secret-invitation-token-marker-3d8e';

    await sendEmail({ to: 'dan@example.com', subject: 'Invite', body });

    const allLogCalls = [
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...debugSpy.mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain('super-secret-invitation-token-marker');
  });
});
