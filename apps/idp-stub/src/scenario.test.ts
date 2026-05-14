import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  ScenarioOverrideSchema,
  createScenarioStore,
  DEFAULT_SCENARIO,
  defaultScenarioStore,
  type Scenario,
} from './scenario.js';

describe('createScenarioStore', () => {
  it('returns the documented default scenario from a fresh store', () => {
    const store = createScenarioStore();
    expect(store.get()).toEqual<Scenario>({
      email: 'e2e-sso-new@alpha.test',
      email_verified: true,
      sub: 'e2e-sso-test-sub-001',
      aud: 'test-client',
      exp: null,
      iat: null,
      jti: null,
      nonce: null,
      forceIssOverride: null,
    });
  });

  it('merges a single override patch with the default scenario', () => {
    const store = createScenarioStore();
    store.set({ email: 'a@b.com' });
    const scenario = store.get();
    expect(scenario.email).toBe('a@b.com');
    // other fields stay default
    expect(scenario.email_verified).toBe(true);
    expect(scenario.sub).toBe('e2e-sso-test-sub-001');
    expect(scenario.aud).toBe('test-client');
    expect(scenario.exp).toBeNull();
    expect(scenario.iat).toBeNull();
    expect(scenario.jti).toBeNull();
    expect(scenario.nonce).toBeNull();
    expect(scenario.forceIssOverride).toBeNull();
  });

  it('accumulates successive overrides across multiple set calls', () => {
    const store = createScenarioStore();
    store.set({ email: 'a@b.com' });
    store.set({ sub: 'x' });
    const scenario = store.get();
    expect(scenario.email).toBe('a@b.com');
    expect(scenario.sub).toBe('x');
    // unchanged defaults remain
    expect(scenario.email_verified).toBe(true);
    expect(scenario.aud).toBe('test-client');
  });

  it('returns the exact DEFAULT_SCENARIO constant', () => {
    const store = createScenarioStore();
    expect(store.get()).toEqual(DEFAULT_SCENARIO);
  });

  it('reset reverts the store to defaults after overrides', () => {
    const store = createScenarioStore();
    store.set({ email: 'a@b.com', sub: 'x' });
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SCENARIO);
  });

  it('each createScenarioStore() call yields an independent store', () => {
    const a = createScenarioStore();
    const b = createScenarioStore();
    a.set({ email: 'a@b.com' });
    expect(b.get().email).toBe(DEFAULT_SCENARIO.email);
  });
});

describe('defaultScenarioStore singleton', () => {
  it('is a usable ScenarioStore returning the documented default', () => {
    // reset first to neutralize any prior test pollution
    defaultScenarioStore.reset();
    expect(defaultScenarioStore.get()).toEqual(DEFAULT_SCENARIO);
  });
});

describe('ScenarioOverrideSchema', () => {
  it('accepts an empty patch as valid', () => {
    expect(() => ScenarioOverrideSchema.parse({})).not.toThrow();
  });

  it('accepts a valid email override', () => {
    expect(() => ScenarioOverrideSchema.parse({ email: 'a@b.com' })).not.toThrow();
  });

  it('rejects an empty email (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ email: '' })).toThrow(ZodError);
  });

  it('rejects an email longer than the documented max (254)', () => {
    const tooLong = 'a'.repeat(255) + '@b.com';
    expect(() => ScenarioOverrideSchema.parse({ email: tooLong })).toThrow(ZodError);
  });

  it('rejects email_verified as a string (must be boolean)', () => {
    expect(() => ScenarioOverrideSchema.parse({ email_verified: 'true' })).toThrow(ZodError);
  });

  it('rejects an empty sub (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ sub: '' })).toThrow(ZodError);
  });

  it('rejects an empty jti (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ jti: '' })).toThrow(ZodError);
  });

  it('rejects exp = 0 (must be positive int)', () => {
    expect(() => ScenarioOverrideSchema.parse({ exp: 0 })).toThrow(ZodError);
  });

  it('rejects exp = -1 (must be positive int)', () => {
    expect(() => ScenarioOverrideSchema.parse({ exp: -1 })).toThrow(ZodError);
  });

  it('rejects an empty forceIssOverride (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ forceIssOverride: '' })).toThrow(ZodError);
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() => ScenarioOverrideSchema.parse({ unknown_key: 1 })).toThrow(ZodError);
  });

  // Max-length boundaries — every string field has .max(255) (email is .max(254)).
  it('rejects sub longer than 255 chars (max length)', () => {
    expect(() => ScenarioOverrideSchema.parse({ sub: 'a'.repeat(256) })).toThrow(ZodError);
  });

  it('rejects an empty aud (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ aud: '' })).toThrow(ZodError);
  });

  it('rejects aud longer than 255 chars (max length)', () => {
    expect(() => ScenarioOverrideSchema.parse({ aud: 'a'.repeat(256) })).toThrow(ZodError);
  });

  it('rejects jti longer than 255 chars (max length)', () => {
    expect(() => ScenarioOverrideSchema.parse({ jti: 'a'.repeat(256) })).toThrow(ZodError);
  });

  it('rejects an empty nonce (min length 1)', () => {
    expect(() => ScenarioOverrideSchema.parse({ nonce: '' })).toThrow(ZodError);
  });

  it('rejects nonce longer than 255 chars (max length)', () => {
    expect(() => ScenarioOverrideSchema.parse({ nonce: 'a'.repeat(256) })).toThrow(ZodError);
  });

  it('rejects forceIssOverride longer than 255 chars (max length)', () => {
    expect(() => ScenarioOverrideSchema.parse({ forceIssOverride: 'a'.repeat(256) })).toThrow(ZodError);
  });

  // iat boundaries — same Zod chain as exp; without independent tests a
  // schema change that drops .positive() on iat would go undetected.
  it('rejects iat = 0 (must be positive int)', () => {
    expect(() => ScenarioOverrideSchema.parse({ iat: 0 })).toThrow(ZodError);
  });

  it('rejects iat = -1 (must be positive int)', () => {
    expect(() => ScenarioOverrideSchema.parse({ iat: -1 })).toThrow(ZodError);
  });
});

describe('createScenarioStore — pendingNonce slot (sso-nonce-replay TASK-1)', () => {
  it('TC-U-01: setPendingNonce stores the value; get() and getPendingNonce() are independent surfaces', () => {
    const store = createScenarioStore();
    store.setPendingNonce('abc');
    expect(store.getPendingNonce()).toBe('abc');
    expect(store.get().nonce).toBe(null);
  });

  it('TC-U-02: reset() clears the pending slot AND restores DEFAULT_SCENARIO (one TC, two assertions)', () => {
    const store = createScenarioStore();
    store.set({ email: 'overridden@example.com' });
    store.setPendingNonce('abc');
    store.reset();
    expect(store.getPendingNonce()).toBe(null);
    expect(store.get()).toEqual(DEFAULT_SCENARIO);
  });

  it('TC-U-03: last-write-wins on repeated setPendingNonce calls (no overwrite guard regression)', () => {
    const store = createScenarioStore();
    store.setPendingNonce('first');
    store.setPendingNonce('second');
    expect(store.getPendingNonce()).toBe('second');
  });

  it('TC-U-04: setPendingNonce(null) clears the slot explicitly', () => {
    const store = createScenarioStore();
    store.setPendingNonce('abc');
    store.setPendingNonce(null);
    expect(store.getPendingNonce()).toBe(null);
  });

  it('TC-U-05: two independent createScenarioStore() instances do NOT share pending state (per-test isolation lock)', () => {
    const a = createScenarioStore();
    const b = createScenarioStore();
    a.setPendingNonce('only-a');
    expect(b.getPendingNonce()).toBe(null);
    b.setPendingNonce('only-b');
    expect(a.getPendingNonce()).toBe('only-a');
  });
});
