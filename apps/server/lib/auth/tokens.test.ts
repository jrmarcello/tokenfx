import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateInviteToken, generateKeyId, hashInviteToken } from './tokens';

describe('generateInviteToken', () => {
  it('returns a 64-char hex string (TC-U-01)', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates 1000 unique tokens (TC-U-02)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateInviteToken());
    }
    expect(tokens.size).toBe(1000);
  });
});

describe('generateKeyId', () => {
  it('returns "k_" + 16 hex chars (TC-U-03)', () => {
    const keyId = generateKeyId();
    expect(keyId).toMatch(/^k_[0-9a-f]{16}$/);
  });
});

describe('hashInviteToken', () => {
  it('returns a deterministic 64-char hex SHA-256 (TC-U-07)', () => {
    const token = 'a'.repeat(64);
    const hash = hashInviteToken(token);

    // Shape: hex-encoded SHA-256 is exactly 64 lowercase hex chars.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same input always produces the same digest — this is
    // what makes the `WHERE token_hash = ?` redeem lookup work.
    expect(hashInviteToken(token)).toBe(hash);
    // Known-answer vector: pins the algorithm to plain SHA-256 (no pepper, no
    // salt) so a future refactor that changes the hash silently fails here.
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });

  it('maps two distinct tokens to distinct hashes (TC-U-08)', () => {
    const a = hashInviteToken('a'.repeat(64));
    const b = hashInviteToken('b'.repeat(64));
    expect(a).not.toBe(b);
  });
});
