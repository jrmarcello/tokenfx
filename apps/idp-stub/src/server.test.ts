import * as jose from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { generateJwks, type JwksKit } from './jwks.js';
import { createScenarioStore, type ScenarioStore } from './scenario.js';
import { createApp, type Deps } from './server.js';

const STUB_BASE = 'http://localhost:3001';

const makeApp = async (overrides: Partial<Deps> = {}) => {
  const jwks = overrides.jwks ?? (await generateJwks());
  const scenario = overrides.scenario ?? createScenarioStore();
  const deps: Deps = {
    baseUrl: overrides.baseUrl ?? STUB_BASE,
    jwks,
    scenario,
  };
  return { app: createApp(deps), deps, jwks, scenario };
};

const form = (data: Record<string, string>): { body: string; headers: Headers } => {
  const params = new URLSearchParams(data);
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  return { body: params.toString(), headers };
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token: string;
};
type ErrorResponse = { error: { message: string } };
type DiscoveryDocResponse = {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
};
type JwksResponse = { keys: Array<{ kty: string; kid: string; n: string; e: string; use: string; alg: string }> };

const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe('Hono server', () => {
  describe('GET /.well-known/openid-configuration', () => {
    it('returns 200 with discovery doc containing all 7 required fields rooted at base URL', async () => {
      const { app } = await makeApp();
      const res = await app.request('/.well-known/openid-configuration');
      expect(res.status).toBe(200);
      const body = await readJson<DiscoveryDocResponse>(res);
      expect(body.issuer).toBe(STUB_BASE);
      expect(body.jwks_uri).toBe(`${STUB_BASE}/jwks`);
      expect(body.authorization_endpoint).toBe(`${STUB_BASE}/authorize`);
      expect(body.token_endpoint).toBe(`${STUB_BASE}/token`);
      expect(body.response_types_supported).toEqual(['code']);
      expect(body.subject_types_supported).toEqual(['public']);
      expect(body.id_token_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('returns the same body on two consecutive requests (idempotency)', async () => {
      const { app } = await makeApp();
      const a = await readJson<DiscoveryDocResponse>(await app.request('/.well-known/openid-configuration'));
      const b = await readJson<DiscoveryDocResponse>(await app.request('/.well-known/openid-configuration'));
      expect(a).toEqual(b);
    });
  });

  describe('GET /jwks', () => {
    it('returns 200 with a JWKS containing one RSA key', async () => {
      const { app, jwks } = await makeApp();
      const res = await app.request('/jwks');
      expect(res.status).toBe(200);
      const body = await readJson<JwksResponse>(res);
      expect(Array.isArray(body.keys)).toBe(true);
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].kty).toBe('RSA');
      expect(body.keys[0].kid).toBe(jwks.kid);
      expect(body.keys[0].n).toBe(jwks.publicJwk.n);
    });

    it('returns identical kid/n on two consecutive calls (cached per process)', async () => {
      const { app } = await makeApp();
      const a = (await readJson<JwksResponse>(await app.request('/jwks'))).keys[0];
      const b = (await readJson<JwksResponse>(await app.request('/jwks'))).keys[0];
      expect(a.kid).toBe(b.kid);
      expect(a.n).toBe(b.n);
    });
  });

  describe('GET /authorize', () => {
    it('happy path: 302 to redirect_uri with code+state', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&client_id=x&redirect_uri=http://localhost:3232/cb&state=ST&scope=openid+email',
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get('location') ?? '';
      expect(loc.startsWith('http://localhost:3232/cb?')).toBe(true);
      const url = new URL(loc);
      expect(url.searchParams.get('state')).toBe('ST');
      const code = url.searchParams.get('code');
      expect(code).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('two successive calls produce DIFFERENT codes', async () => {
      const { app } = await makeApp();
      const r1 = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=A',
      );
      const r2 = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=A',
      );
      const c1 = new URL(r1.headers.get('location') ?? '').searchParams.get('code');
      const c2 = new URL(r2.headers.get('location') ?? '').searchParams.get('code');
      expect(c1).not.toBe(c2);
    });

    it('400 when redirect_uri is missing', async () => {
      const { app } = await makeApp();
      const res = await app.request('/authorize?response_type=code&state=ST');
      expect(res.status).toBe(400);
      const body = await readJson<ErrorResponse>(res);
      expect(body.error.message).toMatch(/redirect_uri/);
    });

    it('400 when state is missing', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb',
      );
      expect(res.status).toBe(400);
      const body = await readJson<ErrorResponse>(res);
      expect(body.error.message).toMatch(/state/);
    });

    it('400 when state is empty string', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=',
      );
      expect(res.status).toBe(400);
    });

    it('400 when redirect_uri is javascript: (open-redirect guard)', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&redirect_uri=javascript:alert(1)&state=ST',
      );
      expect(res.status).toBe(400);
    });

    it('400 when redirect_uri is off-host (open-redirect guard)', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&redirect_uri=https://attacker.example/cb&state=ST',
      );
      expect(res.status).toBe(400);
    });

    it('TC-I-23: POST /authorize (wrong method) returns 404 or 405 (Hono default)', async () => {
      const { app } = await makeApp();
      const res = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST',
        { method: 'POST' },
      );
      expect([404, 405]).toContain(res.status);
    });

    // -----------------------------------------------------------------
    // redirect_uri allowlist — strict URL parsing + hostname allowlist
    // (review-report-2026-05-14-fixes TASK-H1, TC-U-01..07f).
    //
    // Rationale: `uri.startsWith('http://localhost')` is bypassable by
    // `http://localhost.evil.com/cb` (suffix-injection). The fix parses
    // the URI with `new URL(...)` and enforces an exact hostname
    // allowlist {`localhost`, `127.0.0.1`, `[::1]`} over `http:`, plus an
    // exact-origin allowance against `deps.baseUrl` (covers same-origin
    // calls regardless of port/scheme used by the stub itself).
    // -----------------------------------------------------------------
    describe('redirect_uri allowlist (TASK-H1)', () => {
      it.each([
        // TC-U-01..03: suffix-injection / wrong-scheme rejections.
        ['TC-U-01: rejects http://localhost.evil.com/cb (suffix injection)', 'http://localhost.evil.com/cb'],
        ['TC-U-02: rejects http://127.0.0.1.attacker.com/cb (suffix injection)', 'http://127.0.0.1.attacker.com/cb'],
        ['TC-U-03: rejects https://localhost/cb (https not in allowlist)', 'https://localhost/cb'],
        // TC-U-07b..07d: non-http schemes.
        ['TC-U-07b: rejects javascript:alert(1)', 'javascript:alert(1)'],
        ['TC-U-07c: rejects file:///etc/passwd', 'file:///etc/passwd'],
        ['TC-U-07d: rejects data:text/html,<script>alert(1)</script>', 'data:text/html,<script>alert(1)</script>'],
        // TC-U-07e: malformed URL.
        ['TC-U-07e: rejects not-a-url (URL constructor throws)', 'not-a-url'],
      ])('%s → 400', async (_label, badUri) => {
        const { app } = await makeApp();
        const url =
          `/authorize?response_type=code&redirect_uri=${encodeURIComponent(badUri)}&state=ST`;
        const res = await app.request(url);
        expect(res.status).toBe(400);
        const body = await readJson<ErrorResponse>(res);
        expect(typeof body.error.message).toBe('string');
        expect(body.error.message.length).toBeGreaterThan(0);
      });

      it.each([
        // TC-U-04: loopback localhost with port.
        ['TC-U-04: accepts http://localhost:3001/cb', 'http://localhost:3001/cb'],
        // TC-U-05: loopback 127.0.0.1 with port.
        ['TC-U-05: accepts http://127.0.0.1:3001/cb', 'http://127.0.0.1:3001/cb'],
        // TC-U-07: IPv6 loopback.
        ['TC-U-07: accepts http://[::1]:3001/cb', 'http://[::1]:3001/cb'],
      ])('%s → 302', async (_label, goodUri) => {
        const { app } = await makeApp();
        const url =
          `/authorize?response_type=code&redirect_uri=${encodeURIComponent(goodUri)}&state=ST`;
        const res = await app.request(url);
        expect(res.status).toBe(302);
        const loc = res.headers.get('location') ?? '';
        const parsed = new URL(loc);
        expect(parsed.searchParams.get('state')).toBe('ST');
        expect(parsed.searchParams.get('code')).toMatch(/^[0-9a-f-]{36}$/);
      });

      it('TC-U-06: accepts exact deps.baseUrl + "/cb" (same-origin path)', async () => {
        // Use a non-loopback baseUrl to prove the "exact origin equality"
        // branch is independent from the loopback allowlist branch.
        const baseUrl = 'http://stub.internal:9876';
        const { app } = await makeApp({ baseUrl });
        const goodUri = `${baseUrl}/cb`;
        const res = await app.request(
          `/authorize?response_type=code&redirect_uri=${encodeURIComponent(goodUri)}&state=ST`,
        );
        expect(res.status).toBe(302);
        const loc = res.headers.get('location') ?? '';
        expect(loc.startsWith(`${baseUrl}/cb?`)).toBe(true);
      });

      it('TC-U-07f: rejects request with missing redirect_uri param (Zod boundary)', async () => {
        const { app } = await makeApp();
        const res = await app.request('/authorize?response_type=code&state=ST');
        expect(res.status).toBe(400);
        const body = await readJson<ErrorResponse>(res);
        expect(body.error.message).toMatch(/redirect_uri/);
      });
    });
  });

  describe('POST /token', () => {
    const happyForm = { grant_type: 'authorization_code', code: 'x', redirect_uri: 'http://localhost:3232/cb' };

    it('happy path: 200 with id_token + access_token + token_type=Bearer + expires_in=3600', async () => {
      const { app } = await makeApp();
      const { body, headers } = form(happyForm);
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(200);
      const data = await readJson<TokenResponse>(res);
      expect(typeof data.id_token).toBe('string');
      expect(typeof data.access_token).toBe('string');
      expect(data.token_type).toBe('Bearer');
      expect(data.expires_in).toBe(3600);
    });

    it('issued id_token verifies in-process against the publicJwk', async () => {
      const { app, jwks } = await makeApp();
      const { body, headers } = form(happyForm);
      const res = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(res);
      const publicKey = await jose.importJWK(jwks.publicJwk, 'RS256');
      const verified = await jose.jwtVerify(data.id_token, publicKey);
      expect(verified.payload.iss).toBe(STUB_BASE);
      expect(verified.protectedHeader.kid).toBe(jwks.kid);
    });

    it('id_token claims (default scenario) include iss, aud, email, email_verified, exp>iat, jti UUID v4', async () => {
      const { app } = await makeApp();
      const { body, headers } = form(happyForm);
      const res = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(res);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.iss).toBe(STUB_BASE);
      expect(decoded.aud).toBe('test-client');
      expect(decoded.email).toBe('e2e-sso-new@alpha.test');
      expect(decoded.email_verified).toBe(true);
      expect((decoded.exp ?? 0) > (decoded.iat ?? 0)).toBe(true);
      expect(decoded.jti).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('TC-I-06 (sso-nonce-replay): form-body `nonce` is IGNORED — only /authorize-captured nonce flows into the id_token claim (dead-code removal regression lock)', async () => {
      // NextAuth places `nonce` on the /authorize query string, NOT on
      // the /token POST body. The previous form-body echo at
      // server.ts:84 was dead code under the real OAuth flow and
      // removed by sso-nonce-replay TASK-3. This test locks against
      // accidental re-introduction.
      const { app } = await makeApp();
      const { body, headers } = form({ ...happyForm, nonce: 'fromBody' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(res);
      const decoded = jose.decodeJwt(data.id_token);
      // Strict property-absence — matches the canonical pattern used by
      // every other nonce-absence assertion in this file (TC-I-03/04 +
      // fixtures.test.ts TC-U-08).
      expect('nonce' in decoded).toBe(false);
    });

    it('400 when Content-Type is application/json', async () => {
      const { app } = await makeApp();
      const res = await app.request('/token', {
        method: 'POST',
        body: JSON.stringify(happyForm),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      expect(res.status).toBe(400);
    });

    it('400 when grant_type is client_credentials', async () => {
      const { app } = await makeApp();
      const { body, headers } = form({ ...happyForm, grant_type: 'client_credentials' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(400);
    });

    it('400 when grant_type is missing', async () => {
      const { app } = await makeApp();
      const { body, headers } = form({ code: 'x', redirect_uri: 'http://localhost:3232/cb' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(400);
    });

    it('400 when code is missing', async () => {
      const { app } = await makeApp();
      const { body, headers } = form({ grant_type: 'authorization_code', redirect_uri: 'http://localhost:3232/cb' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(400);
    });

    it('400 when redirect_uri is missing', async () => {
      const { app } = await makeApp();
      const { body, headers } = form({ grant_type: 'authorization_code', code: 'x' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(400);
    });

    it('400 when body is empty', async () => {
      const { app } = await makeApp();
      const res = await app.request('/token', {
        method: 'POST',
        body: '',
        headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      });
      expect(res.status).toBe(400);
    });

    it('500 when underlying signing fails (Result pattern propagates)', async () => {
      const baseJwks = await generateJwks();
      const publicAsPrivate = (await jose.importJWK(baseJwks.publicJwk, 'RS256')) as jose.KeyLike;
      const brokenJwks: JwksKit = { ...baseJwks, privateKey: publicAsPrivate };
      const { app } = await makeApp({ jwks: brokenJwks });
      const { body, headers } = form(happyForm);
      const res = await app.request('/token', { method: 'POST', body, headers });
      expect(res.status).toBe(500);
      const data = await readJson<ErrorResponse>(res);
      expect(typeof data.error.message).toBe('string');
    });
  });

  describe('POST /admin/scenario', () => {
    let store: ScenarioStore;

    beforeEach(() => {
      store = createScenarioStore();
    });

    it('204 on valid patch; subsequent /token reflects override', async () => {
      const { app } = await makeApp({ scenario: store });
      const setRes = await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 'new@x.com' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      expect(setRes.status).toBe(204);

      const { body, headers } = form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'http://localhost:3232/cb',
      });
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(tokRes);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.email).toBe('new@x.com');
    });

    it('400 with {error:{message}} on invalid body shape', async () => {
      const { app } = await makeApp({ scenario: store });
      const res = await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 42 }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      expect(res.status).toBe(400);
      const data = await readJson<ErrorResponse>(res);
      expect(typeof data.error.message).toBe('string');
      expect(data.error.message.length).toBeGreaterThan(0);
    });

    it('rejects cross-origin Origin (DNS-rebinding defense — MEDIUM-1)', async () => {
      const { app } = await makeApp({ scenario: store });
      const res = await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 'evil@evil.example' }),
        headers: new Headers({
          'content-type': 'application/json',
          origin: 'https://evil.example.com',
        }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects non-JSON content-type (closes <form> DNS-rebinding payload)', async () => {
      const { app } = await makeApp({ scenario: store });
      const res = await app.request('/admin/scenario', {
        method: 'POST',
        body: 'email=evil@evil.example',
        headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      });
      expect(res.status).toBe(400);
    });

    it('204 with empty body {} (no-op merge, distinct from reset)', async () => {
      const { app } = await makeApp({ scenario: store });
      const res = await app.request('/admin/scenario', {
        method: 'POST',
        body: '{}',
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      expect(res.status).toBe(204);
    });

    it('last write wins on the same field', async () => {
      const { app } = await makeApp({ scenario: store });
      await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 'a@b.com' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 'c@d.com' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      const { body, headers } = form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'http://localhost:3232/cb',
      });
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(tokRes);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.email).toBe('c@d.com');
    });

    it('forceIssOverride changes iss in subsequent id_token', async () => {
      const { app } = await makeApp({ scenario: store });
      await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ forceIssOverride: 'https://attacker.example' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      const { body, headers } = form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'http://localhost:3232/cb',
      });
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(tokRes);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.iss).toBe('https://attacker.example');
      expect(decoded.iss).not.toBe(STUB_BASE);
    });
  });

  describe('POST /admin/scenario/reset', () => {
    it('reverts to default scenario (distinct semantics from no-op merge)', async () => {
      const store = createScenarioStore();
      const { app } = await makeApp({ scenario: store });
      await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ email: 'new@x.com' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      const resetRes = await app.request('/admin/scenario/reset', { method: 'POST' });
      expect(resetRes.status).toBe(204);

      const { body, headers } = form({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'http://localhost:3232/cb',
      });
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(tokRes);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.email).toBe('e2e-sso-new@alpha.test'); // DEFAULT_SCENARIO
    });
  });

  describe('pendingNonce flow (sso-nonce-replay TASK-3)', () => {
    const happyForm = {
      grant_type: 'authorization_code',
      code: 'x',
      redirect_uri: 'http://localhost:3232/cb',
    };

    it('TC-I-01: /authorize?nonce=abc records into pending slot; subsequent /token echoes nonce=abc', async () => {
      const { app } = await makeApp();
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=x&redirect_uri=http://localhost:3232/cb&state=ST&nonce=abc&scope=openid+email',
      );
      expect(authorizeRes.status).toBe(302);

      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(tokRes);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.nonce).toBe('abc');
    });

    it('TC-I-02: scenario.nonce pin wins over /authorize-recorded pending nonce', async () => {
      const store = createScenarioStore();
      const { app } = await makeApp({ scenario: store });

      // POST scenario { nonce: 'pinned' } sets the pin.
      await app.request('/admin/scenario', {
        method: 'POST',
        body: JSON.stringify({ nonce: 'pinned' }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
      // /authorize records 'abc' into pending — both values now coexist.
      await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST&nonce=abc',
      );

      // Slot probe: both the pin and the pending value are live.
      expect(store.get().nonce).toBe('pinned');
      expect(store.getPendingNonce()).toBe('abc');

      // /token resolves via `scenario.nonce ?? pendingNonce ?? null`
      // → 'pinned' wins.
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect(decoded.nonce).toBe('pinned');
    });

    it('TC-I-02b: pending slot survives independently — fresh store with only setPendingNonce and no scenario.nonce pin → /token echoes pending', async () => {
      const store = createScenarioStore();
      const { app } = await makeApp({ scenario: store });

      // No scenario.nonce pin. /authorize records into pending.
      await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST&nonce=abc',
      );

      // Resolution: `scenario.nonce (null) ?? pendingNonce ('abc') ?? null`
      // → 'abc'.
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect(decoded.nonce).toBe('abc');
    });

    it('TC-I-03: /authorize WITHOUT nonce param → /token id_token has no nonce claim', async () => {
      const { app } = await makeApp();
      await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST',
      );
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect('nonce' in decoded).toBe(false);
    });

    it('TC-I-04: /authorize?nonce= (empty) normalises to no record → /token id_token has no nonce claim', async () => {
      const { app } = await makeApp();
      const authorizeRes = await app.request(
        '/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST&nonce=',
      );
      expect(authorizeRes.status).toBe(302); // Empty is NOT a Zod error
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect('nonce' in decoded).toBe(false);
    });

    it('TC-I-05a: /authorize?nonce=<255 chars> accepted (valid max boundary)', async () => {
      const { app } = await makeApp();
      const nonce255 = 'a'.repeat(255);
      const authorizeRes = await app.request(
        `/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST&nonce=${nonce255}`,
      );
      expect(authorizeRes.status).toBe(302);
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect(decoded.nonce).toBe(nonce255);
    });

    it('TC-I-05b: /authorize?nonce=<256 chars> rejected with 400; pending slot is NOT poisoned', async () => {
      const store = createScenarioStore();
      const { app } = await makeApp({ scenario: store });
      const nonce256 = 'a'.repeat(256);

      const authorizeRes = await app.request(
        `/authorize?response_type=code&redirect_uri=http://localhost:3232/cb&state=ST&nonce=${nonce256}`,
      );
      expect(authorizeRes.status).toBe(400);
      const errBody = await readJson<{ error: { message: string } }>(authorizeRes);
      expect(typeof errBody.error.message).toBe('string');

      // Slot must NOT have been poisoned with the rejected value.
      expect(store.getPendingNonce()).toBe(null);

      // Subsequent /token produces no nonce claim (slot still null).
      const { body, headers } = form(happyForm);
      const tokRes = await app.request('/token', { method: 'POST', body, headers });
      const decoded = jose.decodeJwt((await readJson<TokenResponse>(tokRes)).id_token);
      expect('nonce' in decoded).toBe(false);
    });
  });
});
