import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log as logger } from '@root/logger';
import { sendEmail } from './send-email-stub';

describe('sendEmail (stub)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns ok: true with stub-prefixed messageId', async () => {
    const result = await sendEmail({
      to: 'alice@example.com',
      subject: 'Welcome',
      body: 'Hello there',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messageId).toMatch(/^stub-/);
    }
  });

  it('logs to_hash (SHA-256 of to), never raw email address', async () => {
    const to = 'bob@example.com';
    await sendEmail({ to, subject: 'Hi', body: 'body' });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = infoSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe('email-send-stub');

    const expectedHash = crypto.createHash('sha256').update(to).digest('hex');
    expect(payload.to_hash).toBe(expectedHash);

    // Raw email must NEVER appear anywhere in the log payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(to);
    expect(serialized).not.toContain('bob');
    expect(serialized).not.toContain('@example.com');
  });

  it('never throws (typed Result error path is via return type, not exception)', async () => {
    // Normal happy input — must not throw under any condition.
    await expect(
      sendEmail({ to: 'carol@example.com', subject: 's', body: 'b' }),
    ).resolves.toBeDefined();
  });

  it('logs subject plaintext + body_length (NOT body content)', async () => {
    const body = 'super secret invitation body content';
    await sendEmail({ to: 'dan@example.com', subject: 'Invite', body });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = infoSpy.mock.calls[0]![1] as Record<string, unknown>;

    expect(payload.subject).toBe('Invite');
    expect(payload.body_length).toBe(body.length);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('super secret');
    expect(serialized).not.toContain(body);
  });

  it('each call generates a unique messageId', async () => {
    const a = await sendEmail({ to: 'a@example.com', subject: 's', body: 'b' });
    const b = await sendEmail({ to: 'a@example.com', subject: 's', body: 'b' });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.messageId).not.toBe(b.value.messageId);
    }
  });
});
