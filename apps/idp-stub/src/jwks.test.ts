import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateJwks, jwksKit } from './jwks.js';

describe('jwks module', () => {
  describe('generateJwks() — TC-U-01: happy path JWK pair shape', () => {
    it('returns a JWK pair with kty=RSA, alg=RS256, use=sig, e=AQAB and kid = SHA-256(n)[:16] hex (16 lowercase chars)', async () => {
      const kit = await generateJwks();

      expect(kit.publicJwk.kty).toBe('RSA');
      expect(kit.publicJwk.alg).toBe('RS256');
      expect(kit.publicJwk.use).toBe('sig');
      expect(kit.publicJwk.e).toBe('AQAB');
      expect(typeof kit.publicJwk.n).toBe('string');
      expect(kit.publicJwk.n.length).toBeGreaterThan(0);

      // kid is exactly 16 lowercase hex characters
      expect(kit.kid).toMatch(/^[0-9a-f]{16}$/);
      // kid on the JWK matches the top-level kid
      expect(kit.publicJwk.kid).toBe(kit.kid);

      // kid is algorithmically pinned: SHA-256(n)[:16]
      const expectedKid = createHash('sha256').update(kit.publicJwk.n).digest('hex').slice(0, 16);
      expect(kit.kid).toBe(expectedKid);
    });
  });

  describe('generateJwks() — TC-U-02: public JWK does not leak private key material', () => {
    it('exposes only public-key fields (no d, p, q, dp, dq, qi)', async () => {
      const kit = await generateJwks();
      const privateFields = ['d', 'p', 'q', 'dp', 'dq', 'qi'];
      const jwkKeys = Object.keys(kit.publicJwk);

      for (const forbidden of privateFields) {
        expect(jwkKeys).not.toContain(forbidden);
      }

      // Allow exactly the documented public-key fields
      expect(new Set(jwkKeys)).toEqual(new Set(['kty', 'use', 'alg', 'kid', 'n', 'e']));
    });
  });

  describe('generateJwks() — TC-U-24: edge case — successive calls produce distinct keypairs', () => {
    it('returns different kid and modulus n on two consecutive invocations', async () => {
      const a = await generateJwks();
      const b = await generateJwks();

      expect(a.kid).not.toBe(b.kid);
      expect(a.publicJwk.n).not.toBe(b.publicJwk.n);
    });
  });

  describe('jwksKit module-level singleton', () => {
    it('is initialized at module load with a valid JWK pair matching the same invariants', () => {
      expect(jwksKit.publicJwk.kty).toBe('RSA');
      expect(jwksKit.publicJwk.alg).toBe('RS256');
      expect(jwksKit.publicJwk.use).toBe('sig');
      expect(jwksKit.publicJwk.e).toBe('AQAB');
      expect(jwksKit.kid).toMatch(/^[0-9a-f]{16}$/);
      const expectedKid = createHash('sha256').update(jwksKit.publicJwk.n).digest('hex').slice(0, 16);
      expect(jwksKit.kid).toBe(expectedKid);
    });
  });
});
