/**
 * Canonical JSON serialization:
 * - Object keys sorted lexicographically at every level
 * - Arrays preserve order (not sorted)
 * - No whitespace, no trailing commas
 * - Recursively applied — nested objects get the same treatment
 *
 * Implements RFC 8785-style determinism without depending on a third-party
 * canonicalization library (the JS ecosystem has several incompatible
 * implementations; rolling our own keeps the wire format under our control).
 *
 * Rejects `undefined`, functions, symbols, and non-finite numbers explicitly
 * so the caller cannot accidentally produce a payload that round-trips
 * differently between sign and verify.
 *
 * Used for two purposes after the Bearer-auth refactor:
 *   - Idempotency-Key derivation on the reporter (sha256(canonicalJSON(...))).
 *   - Per-session idempotency hash on the server.
 *
 * (Previously also used for HMAC signing — the HMAC code path was deleted in
 * the central-server-onboarding spec; this module keeps only the canonicalizer.)
 */
export const canonicalJSON = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJSON: non-finite number not allowed');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJSON(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`,
    );
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonicalJSON: unsupported value type ${typeof value}`);
};
