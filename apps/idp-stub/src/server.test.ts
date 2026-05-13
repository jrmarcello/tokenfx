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

    it('echoes nonce from form body into id_token claim', async () => {
      const { app } = await makeApp();
      const { body, headers } = form({ ...happyForm, nonce: 'NONCE-123' });
      const res = await app.request('/token', { method: 'POST', body, headers });
      const data = await readJson<TokenResponse>(res);
      const decoded = jose.decodeJwt(data.id_token);
      expect(decoded.nonce).toBe('NONCE-123');
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
});
