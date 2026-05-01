import { describe, it, expect } from 'vitest';
import { generateInviteToken, generateKeyId } from './tokens';

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
