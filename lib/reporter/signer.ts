import { createHmac, timingSafeEqual } from 'node:crypto';

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

/**
 * HMAC-SHA256 signature in hex over canonical JSON of the payload.
 */
export const sign = (payload: unknown, secret: string): string => {
  return createHmac('sha256', secret)
    .update(canonicalJSON(payload))
    .digest('hex');
};

/**
 * Constant-time signature verification.
 *
 * Returns `false` (not throws) for malformed signatures so callers do not
 * leak information about the failure mode through exception types.
 */
export const verify = (
  payload: unknown,
  signature: string,
  secret: string,
): boolean => {
  const expected = sign(payload, secret);
  // timingSafeEqual requires equal-length buffers; an attacker can supply
  // any length, so reject mismatches before the constant-time compare.
  if (expected.length !== signature.length) return false;
  // Reject anything that isn't pure lowercase hex of the expected length.
  // Buffer.from('zz...', 'hex') silently returns an empty/short Buffer
  // rather than throwing, which would otherwise sneak past the check above
  // because we've already validated string length, not byte length.
  if (!/^[0-9a-f]+$/.test(signature)) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
};
