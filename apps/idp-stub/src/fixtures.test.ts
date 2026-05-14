import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDiscoveryDoc, signIdToken } from './fixtures.js';
import { generateJwks } from './jwks.js';
import { DEFAULT_SCENARIO, type Scenario } from './scenario.js';

const STUB_ISS = 'http://localhost:3001';

describe('fixtures module', () => {
  describe('buildDiscoveryDoc', () => {
    it('returns all required RFC 8414 fields rooted at the base URL', () => {
      const doc = buildDiscoveryDoc(STUB_ISS);
      expect(doc.issuer).toBe(STUB_ISS);
      expect(doc.jwks_uri).toBe(`${STUB_ISS}/jwks`);
      expect(doc.authorization_endpoint).toBe(`${STUB_ISS}/authorize`);
      expect(doc.token_endpoint).toBe(`${STUB_ISS}/token`);
      expect(doc.response_types_supported).toEqual(['code']);
      expect(doc.subject_types_supported).toEqual(['public']);
      expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('strips trailing slash from baseUrl before composing endpoint URLs', () => {
      const doc = buildDiscoveryDoc('https://example.com/foo/');
      expect(doc.issuer).toBe('https://example.com/foo');
      expect(doc.jwks_uri).toBe('https://example.com/foo/jwks');
      expect(doc.authorization_endpoint).toBe('https://example.com/foo/authorize');
      expect(doc.token_endpoint).toBe('https://example.com/foo/token');
      // Ensure no double-slash anywhere in URL fields
      for (const url of [doc.issuer, doc.jwks_uri, doc.authorization_endpoint, doc.token_endpoint]) {
        const afterScheme = url.split('://')[1];
        expect(afterScheme.includes('//')).toBe(false);
      }
    });
  });

  describe('signIdToken', () => {
    it('produces a JWT whose decoded payload matches scenario claims (iss, sub, email, email_verified, aud, exp, jti)', async () => {
      const kit = await generateJwks();
      const scenario: Scenario = {
        ...DEFAULT_SCENARIO,
        email: 'alice@alpha.test',
        sub: 'sub-alice-123',
        aud: 'test-client',
        exp: 9_999_999_999,
        iat: 1_700_000_000,
        jti: 'jti-abc-123',
      };

      const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('signIdToken should have succeeded');

      const decoded = jose.decodeJwt(result.value);
      expect(decoded.iss).toBe(STUB_ISS);
      expect(decoded.aud).toBe('test-client');
      expect(decoded.sub).toBe('sub-alice-123');
      expect(decoded.email).toBe('alice@alpha.test');
      expect(decoded.email_verified).toBe(true);
      expect(decoded.exp).toBe(9_999_999_999);
      expect(decoded.iat).toBe(1_700_000_000);
      expect(decoded.jti).toBe('jti-abc-123');
    });

    it('emits nonce claim when scenario.nonce is set', async () => {
      const kit = await generateJwks();
      const scenario: Scenario = { ...DEFAULT_SCENARIO, nonce: 'NONCE-XYZ' };
      const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario });
      if (!result.ok) throw new Error('signIdToken should have succeeded');
      const decoded = jose.decodeJwt(result.value);
      expect(decoded.nonce).toBe('NONCE-XYZ');
    });

    it('omits nonce claim when scenario.nonce is null', async () => {
      const kit = await generateJwks();
      const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario: DEFAULT_SCENARIO });
      if (!result.ok) throw new Error('signIdToken should have succeeded');
      const decoded = jose.decodeJwt(result.value);
      expect('nonce' in decoded).toBe(false);
    });

    it('signed id_token verifies against the public JWK via jose.jwtVerify (in-process)', async () => {
      const kit = await generateJwks();
      const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario: DEFAULT_SCENARIO });
      if (!result.ok) throw new Error('signIdToken should have succeeded');

      const publicKey = await jose.importJWK(kit.publicJwk, 'RS256');
      const verified = await jose.jwtVerify(result.value, publicKey);
      expect(verified.payload.iss).toBe(STUB_ISS);
      expect(verified.protectedHeader.alg).toBe('RS256');
      expect(verified.protectedHeader.kid).toBe(kit.kid);
    });

    describe('with fake timers pinning Date.now() to 2026-01-15T00:00:00Z', () => {
      const FROZEN = new Date('2026-01-15T00:00:00Z');
      const FROZEN_SEC = Math.floor(FROZEN.getTime() / 1000);

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(FROZEN);
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('defaults iat to NOW and exp to NOW+3600 when scenario provides neither', async () => {
        const kit = await generateJwks();
        const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario: DEFAULT_SCENARIO });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect(decoded.iat).toBe(FROZEN_SEC);
        expect(decoded.exp).toBe(FROZEN_SEC + 3600);
      });

      it('defaults jti to a UUID v4 when scenario.jti is null', async () => {
        const kit = await generateJwks();
        const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario: DEFAULT_SCENARIO });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect(typeof decoded.jti).toBe('string');
        expect(decoded.jti).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      });
    });

    it('emits iss=forceIssOverride when scenario.forceIssOverride is set (cross-IdP rejection test)', async () => {
      const kit = await generateJwks();
      const scenario: Scenario = {
        ...DEFAULT_SCENARIO,
        forceIssOverride: 'https://attacker.example',
      };
      const result = await signIdToken({ jwks: kit, issuer: STUB_ISS, scenario });
      if (!result.ok) throw new Error('signIdToken should have succeeded');
      const decoded = jose.decodeJwt(result.value);
      expect(decoded.iss).toBe('https://attacker.example');
      expect(decoded.iss).not.toBe(STUB_ISS);
    });

    it('returns {ok:false, error} when the injected private key fails signing (Result pattern)', async () => {
      const kit = await generateJwks();
      // Inject a broken kit where the privateKey is something jose can't use to sign.
      // Using a public key as the "private" key will reject inside SignJWT.sign().
      const publicKey = (await jose.importJWK(kit.publicJwk, 'RS256')) as jose.KeyLike;
      const brokenKit = {
        ...kit,
        privateKey: publicKey, // jose.SignJWT will reject — public keys can't sign
      };

      const result = await signIdToken({ jwks: brokenKit, issuer: STUB_ISS, scenario: DEFAULT_SCENARIO });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('signIdToken should have failed');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message.length).toBeGreaterThan(0);
    });

    describe('pendingNonce resolution (sso-nonce-replay TASK-2)', () => {
      it('TC-U-06: pendingNonce is used when scenario.nonce is null', async () => {
        const kit = await generateJwks();
        const scenario: Scenario = { ...DEFAULT_SCENARIO, nonce: null };
        const result = await signIdToken({
          jwks: kit,
          issuer: STUB_ISS,
          scenario,
          pendingNonce: 'abc',
        });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect(decoded.nonce).toBe('abc');
      });

      it('TC-U-07: scenario.nonce wins over pendingNonce (pin > pending)', async () => {
        const kit = await generateJwks();
        const scenario: Scenario = { ...DEFAULT_SCENARIO, nonce: 'pinned' };
        const result = await signIdToken({
          jwks: kit,
          issuer: STUB_ISS,
          scenario,
          pendingNonce: 'abc',
        });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect(decoded.nonce).toBe('pinned');
      });

      it('TC-U-08: both null/absent → claim absent (strict property absence)', async () => {
        const kit = await generateJwks();
        const result = await signIdToken({
          jwks: kit,
          issuer: STUB_ISS,
          scenario: { ...DEFAULT_SCENARIO, nonce: null },
          pendingNonce: null,
        });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect('nonce' in decoded).toBe(false);
      });

      it('TC-U-09: pendingNonce omitted (legacy callers) is treated identically to null — claim absent', async () => {
        const kit = await generateJwks();
        const result = await signIdToken({
          jwks: kit,
          issuer: STUB_ISS,
          scenario: { ...DEFAULT_SCENARIO, nonce: null },
          // pendingNonce omitted — undefined collapses via `??` same as null
        });
        if (!result.ok) throw new Error('signIdToken should have succeeded');
        const decoded = jose.decodeJwt(result.value);
        expect('nonce' in decoded).toBe(false);
      });
    });
  });
});
