import { createHash } from 'node:crypto';
import * as jose from 'jose';

/**
 * Public JWK shape exposed via `GET /jwks`. Strictly limited to the public-key
 * fields — no private-key material (`d`, `p`, `q`, `dp`, `dq`, `qi`).
 */
export type PublicJwk = Readonly<{
  kty: 'RSA';
  use: 'sig';
  alg: 'RS256';
  kid: string;
  n: string;
  e: string;
}>;

/**
 * Result of generating an RSA keypair for the IdP stub.
 *
 * `privateKey` is retained for signing `id_token`s; `publicJwk` is what we
 * serve via `GET /jwks`. The `kid` is algorithmically pinned as
 * `SHA-256(modulus n, hex-encoded)[:16]` so consumers can derive it
 * deterministically from the public JWK alone.
 */
export type JwksKit = Readonly<{
  privateKey: jose.KeyLike;
  publicJwk: PublicJwk;
  kid: string;
}>;

const buildKit = async (): Promise<JwksKit> => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const exported = await jose.exportJWK(publicKey);

  if (typeof exported.n !== 'string' || typeof exported.e !== 'string') {
    throw new Error('jose.exportJWK did not return RSA modulus/exponent fields');
  }

  const n = exported.n;
  const e = exported.e;
  const kid = createHash('sha256').update(n).digest('hex').slice(0, 16);

  const publicJwk: PublicJwk = {
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
    kid,
    n,
    e,
  };

  return { privateKey, publicJwk, kid };
};

/**
 * Module-level singleton: generated once at module load via top-level
 * `await` (ESM). Reused for the lifetime of the process so every signed
 * `id_token` matches the JWK served at `GET /jwks`.
 */
export const jwksKit: JwksKit = await buildKit();

/**
 * Generate a fresh, independent JWK pair. Primarily used by tests that need
 * to assert "two consecutive calls produce different keys"; production code
 * paths read from the `jwksKit` singleton above.
 */
export const generateJwks = async (): Promise<JwksKit> => buildKit();
