import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log as logger } from '@tokenfx/shared/logger';
import { __resetDispatcher, sendEmail } from './send-email';
import type { SendEmailFn } from './send-email-stub';

/**
 * Hand-written stub SMTP factory — replaces `createSmtpSender` for tests
 * that need to assert the dispatcher selected the SMTP branch. Mirrors
 * the production factory's contract (returns a `SendEmailFn`) but
 * synthesizes a deterministic `<...@host>` messageId so the assertion
 * shape stays stable across runs.
 */
const stubSmtpFactory: Parameters<typeof __resetDispatcher>[0] = (config) => {
  const sender: SendEmailFn = async (input) => ({
    ok: true,
    value: { messageId: `<stub-smtp-${input.subject}@${config.host}>` },
  });
  return sender;
};

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

const clearEnv = (): void => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
};

const setEnv = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): void => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k as (typeof ENV_KEYS)[number]];
    else process.env[k] = v;
  }
};

describe('sendEmail (dispatcher)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    clearEnv();
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) setEnv({ [k]: originalEnv[k] });
    infoSpy.mockRestore();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
    __resetDispatcher();
  });

  it('falls back to stub when SMTP_HOST is unset', async () => {
    clearEnv();
    __resetDispatcher();
    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 'Welcome',
      body: 'Hello',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toMatch(/^stub-/);
    }
  });

  it('falls back to stub when SMTP_HOST is empty string', async () => {
    setEnv({ SMTP_HOST: '' });
    __resetDispatcher();
    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toMatch(/^stub-/);
    }
  });

  it('returns config-error when SMTP_HOST is set but SMTP_FROM is missing', async () => {
    setEnv({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });
    __resetDispatcher();
    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('config-error');
      expect(result.error.message).toContain('SMTP_FROM');
    }
  });

  it('returns config-error on every subsequent call (fail-fast, no per-call retry)', async () => {
    setEnv({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
    });
    __resetDispatcher();
    const first = await sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
    const second = await sendEmail({ to: 'b@x.com', subject: 's', body: 'b' });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.error.reason).toBe('config-error');
      expect(second.error.reason).toBe('config-error');
    }
  });

  it('returns config-error when SMTP_PORT is non-numeric', async () => {
    setEnv({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 'abc',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM: 'noreply@example.com',
    });
    __resetDispatcher();
    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 's',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('config-error');
      expect(result.error.message).toContain('SMTP_PORT');
    }
  });

  it('delegates to SMTP factory when all env fields are valid', async () => {
    setEnv({
      SMTP_HOST: 'mail.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM: 'noreply@example.com',
    });
    __resetDispatcher(stubSmtpFactory);

    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 'Welcome',
      body: 'Hello',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toBe('<stub-smtp-Welcome@mail.example.com>');
      expect(result.value.messageId).not.toMatch(/^stub-/);
    }
  });

  it('builds the SMTP sender ONCE across many sendEmail calls (factory invoked once)', async () => {
    setEnv({
      SMTP_HOST: 'mail.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM: 'noreply@example.com',
    });

    let factoryCalls = 0;
    const countingFactory: Parameters<typeof __resetDispatcher>[0] = (config) => {
      factoryCalls += 1;
      return stubSmtpFactory(config);
    };
    __resetDispatcher(countingFactory);

    await sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
    await sendEmail({ to: 'b@x.com', subject: 's', body: 'b' });
    await sendEmail({ to: 'c@x.com', subject: 's', body: 'b' });

    expect(factoryCalls).toBe(1);
  });
});
