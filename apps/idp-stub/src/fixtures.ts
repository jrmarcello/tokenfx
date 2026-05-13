import { randomUUID } from 'node:crypto';
import * as jose from 'jose';

import type { JwksKit } from './jwks.js';
import type { Scenario } from './scenario.js';

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type DiscoveryDoc = Readonly<{
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: readonly ['code'];
  subject_types_supported: readonly ['public'];
  id_token_signing_alg_values_supported: readonly ['RS256'];
}>;

const stripTrailingSlash = (url: string): string =>
  url.endsWith('/') ? url.slice(0, -1) : url;

export const buildDiscoveryDoc = (baseUrl: string): DiscoveryDoc => {
  const base = stripTrailingSlash(baseUrl);
  return {
    issuer: base,
    jwks_uri: `${base}/jwks`,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ['code'] as const,
    subject_types_supported: ['public'] as const,
    id_token_signing_alg_values_supported: ['RS256'] as const,
  };
};

export type SignInput = Readonly<{
  jwks: JwksKit;
  issuer: string;
  scenario: Scenario;
}>;

export const signIdToken = async (
  input: SignInput,
): Promise<Result<string, Error>> => {
  const { jwks, issuer, scenario } = input;
  const now = Math.floor(Date.now() / 1000);

  const iss = scenario.forceIssOverride ?? issuer;
  const iat = scenario.iat ?? now;
  const exp = scenario.exp ?? now + 3600;
  const jti = scenario.jti ?? randomUUID();

  const payload: jose.JWTPayload = {
    sub: scenario.sub,
    email: scenario.email,
    email_verified: scenario.email_verified,
  };
  if (scenario.nonce !== null) {
    payload.nonce = scenario.nonce;
  }

  try {
    const token = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: jwks.kid, typ: 'JWT' })
      .setIssuer(iss)
      .setAudience(scenario.aud)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(jwks.privateKey);
    return { ok: true, value: token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
};
