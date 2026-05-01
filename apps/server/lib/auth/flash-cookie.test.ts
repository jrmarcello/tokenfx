/**
 * Unit tests for the show-once flash cookie helper (REQ-22).
 *
 * Covers the round-trip set/read/delete cycle (TC-I-74) and HMAC
 * tamper-detection (TC-I-75). Hand-written cookie-store stub — no Next.js
 * runtime, no mocking framework.
 */
import { describe, expect, it } from 'vitest';
import {
  FLASH_COOKIE_NAME,
  FLASH_COOKIE_PATH,
  FLASH_COOKIE_MAX_AGE_SECONDS,
  readAndDeleteFlashCookie,
  setFlashCookie,
  signFlashPayload,
  verifyFlashPayload,
  type FlashCookieStore,
} from './flash-cookie';

type SetCall = {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict';
    path: string;
    maxAge: number;
  };
};

type StubState = {
  store: Map<string, string>;
  setCalls: SetCall[];
  deleteCalls: string[];
};

const stubStore = (initial?: Record<string, string>): { state: StubState; cookies: FlashCookieStore } => {
  const state: StubState = {
    store: new Map(Object.entries(initial ?? {})),
    setCalls: [],
    deleteCalls: [],
  };
  const cookies: FlashCookieStore = {
    get: (name) => {
      const v = state.store.get(name);
      return v === undefined ? undefined : { value: v };
    },
    set: (name, value, options) => {
      state.setCalls.push({ name, value, options });
      state.store.set(name, value);
    },
    delete: (name) => {
      state.deleteCalls.push(name);
      state.store.delete(name);
    },
  };
  return { state, cookies };
};

const SECRET = 'unit-test-secret-shhh';

describe('signFlashPayload + verifyFlashPayload', () => {
  it('round-trips a UTF-8 payload', () => {
    const payload = 'https://central.example/onboard#token=' + 'a'.repeat(64);
    const signed = signFlashPayload(payload, SECRET);
    expect(verifyFlashPayload(signed, SECRET)).toBe(payload);
  });

  it('round-trips an empty string', () => {
    const signed = signFlashPayload('', SECRET);
    expect(verifyFlashPayload(signed, SECRET)).toBe('');
  });

  it('round-trips a payload with non-ASCII chars', () => {
    const payload = 'https://central/onboard#token=💀café';
    const signed = signFlashPayload(payload, SECRET);
    expect(verifyFlashPayload(signed, SECRET)).toBe(payload);
  });

  it('returns null when the signature is tampered', () => {
    const signed = signFlashPayload('hello', SECRET);
    // Flip the last char of the signature segment.
    const dot = signed.lastIndexOf('.');
    const flipped = signed.slice(0, dot + 1) + (signed.endsWith('A') ? 'B' : 'A');
    expect(verifyFlashPayload(flipped, SECRET)).toBeNull();
  });

  it('returns null when the payload is tampered (signature now mismatches)', () => {
    const signed = signFlashPayload('hello', SECRET);
    const dot = signed.lastIndexOf('.');
    // Replace payload portion with a different b64 value.
    const malicious = Buffer.from('evil').toString('base64url') + signed.slice(dot);
    expect(verifyFlashPayload(malicious, SECRET)).toBeNull();
  });

  it('returns null when the cookie value has no separator', () => {
    expect(verifyFlashPayload('not-a-valid-cookie', SECRET)).toBeNull();
  });

  it('returns null when the signature is empty', () => {
    expect(verifyFlashPayload('payload.', SECRET)).toBeNull();
  });

  it('returns null when verified with the wrong secret', () => {
    const signed = signFlashPayload('hello', SECRET);
    expect(verifyFlashPayload(signed, 'different-secret')).toBeNull();
  });
});

describe('setFlashCookie', () => {
  it('TC-I-74: sets a cookie with the spec-mandated attributes', () => {
    const { state, cookies } = stubStore();
    setFlashCookie(cookies, 'https://example/onboard#token=abc', {
      secret: SECRET,
      secure: true,
    });
    expect(state.setCalls).toHaveLength(1);
    const call = state.setCalls[0];
    expect(call.name).toBe(FLASH_COOKIE_NAME);
    expect(call.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: FLASH_COOKIE_PATH,
      maxAge: FLASH_COOKIE_MAX_AGE_SECONDS,
    });
    // Value is signed; verifying it round-trips back to the URL.
    expect(verifyFlashPayload(call.value, SECRET)).toBe(
      'https://example/onboard#token=abc',
    );
  });

  it('respects explicit `secure: false` regardless of NODE_ENV', () => {
    const { state, cookies } = stubStore();
    setFlashCookie(cookies, 'http://localhost/onboard#token=abc', {
      secret: SECRET,
      secure: false,
    });
    expect(state.setCalls[0].options.secure).toBe(false);
  });

  it('respects explicit `secure: true` regardless of NODE_ENV', () => {
    const { state, cookies } = stubStore();
    setFlashCookie(cookies, 'https://central/onboard#token=abc', {
      secret: SECRET,
      secure: true,
    });
    expect(state.setCalls[0].options.secure).toBe(true);
  });
});

describe('readAndDeleteFlashCookie', () => {
  it('TC-I-74: returns the payload and deletes the cookie on a valid signed value', () => {
    const signed = signFlashPayload('https://central/onboard#token=valid-token', SECRET);
    const { state, cookies } = stubStore({ [FLASH_COOKIE_NAME]: signed });

    const result = readAndDeleteFlashCookie(cookies, { secret: SECRET });
    expect(result).toBe('https://central/onboard#token=valid-token');
    expect(state.deleteCalls).toEqual([FLASH_COOKIE_NAME]);
    expect(state.store.has(FLASH_COOKIE_NAME)).toBe(false);
  });

  it('returns null when no cookie is present (no delete attempted)', () => {
    const { state, cookies } = stubStore({});
    const result = readAndDeleteFlashCookie(cookies, { secret: SECRET });
    expect(result).toBeNull();
    expect(state.deleteCalls).toEqual([]);
  });

  it('TC-I-75: returns null AND deletes the cookie on HMAC tamper', () => {
    // Build a valid cookie with a different secret; verify with our secret.
    const tampered = signFlashPayload('https://evil/onboard#token=stolen', 'WRONG');
    const { state, cookies } = stubStore({ [FLASH_COOKIE_NAME]: tampered });

    const result = readAndDeleteFlashCookie(cookies, { secret: SECRET });
    expect(result).toBeNull();
    // One-shot semantics — even invalid attempts burn the cookie so they
    // don't survive a refresh.
    expect(state.deleteCalls).toEqual([FLASH_COOKIE_NAME]);
  });

  it('TC-I-75b: a second read after the first finds an empty store and returns null', () => {
    const signed = signFlashPayload('https://central/onboard#token=t', SECRET);
    const { cookies } = stubStore({ [FLASH_COOKIE_NAME]: signed });

    const first = readAndDeleteFlashCookie(cookies, { secret: SECRET });
    const second = readAndDeleteFlashCookie(cookies, { secret: SECRET });
    expect(first).toBe('https://central/onboard#token=t');
    expect(second).toBeNull();
  });
});
