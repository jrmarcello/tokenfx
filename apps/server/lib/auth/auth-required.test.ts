import { describe, expect, it } from 'vitest';
import {
  type AuthRequiredEnv,
  LOCAL_ORG_ID,
  buildLocalDevSession,
  isAuthRequired,
  isLocalhostHost,
} from './auth-required';

describe('isAuthRequired', () => {
  it.each<{
    name: string;
    env: AuthRequiredEnv;
    expected: boolean;
    tc: string;
  }>([
    {
      tc: 'TC-U-01',
      name: 'AUTH_REQUIRED unset → fail-safe true',
      env: {},
      expected: true,
    },
    {
      tc: 'TC-U-02',
      name: "AUTH_REQUIRED='true' → true",
      env: { AUTH_REQUIRED: 'true' },
      expected: true,
    },
    {
      tc: 'TC-U-03',
      name: "AUTH_REQUIRED='false' → false (only literal 'false' flips it)",
      env: { AUTH_REQUIRED: 'false' },
      expected: false,
    },
    {
      tc: 'TC-U-04',
      name: "AUTH_REQUIRED='0' → true (not the literal 'false')",
      env: { AUTH_REQUIRED: '0' },
      expected: true,
    },
    {
      tc: 'TC-U-05',
      name: "AUTH_REQUIRED='' → true (empty string is not 'false')",
      env: { AUTH_REQUIRED: '' },
      expected: true,
    },
    {
      tc: 'TC-U-06',
      name: "AUTH_REQUIRED='False' → true (case-sensitive)",
      env: { AUTH_REQUIRED: 'False' },
      expected: true,
    },
    {
      tc: 'TC-U-07',
      name: "AUTH_REQUIRED='false ' (trailing space) → true (no trim)",
      env: { AUTH_REQUIRED: 'false ' },
      expected: true,
    },
  ])('$tc: $name', ({ env, expected }) => {
    expect(isAuthRequired(env)).toBe(expected);
  });
});

describe('buildLocalDevSession', () => {
  it('TC-U-08: returns the demo session with the fixed local org id', () => {
    const session = buildLocalDevSession();
    expect(session.user.id).toBe('local-dev');
    expect(session.user.email).toBe('dev@localhost');
    expect(session.user.role).toBe('admin');
    expect(session.user.orgId).toBe(LOCAL_ORG_ID);
    // expires set ~1y out (Session contract requires it)
    expect(Date.parse(session.expires)).toBeGreaterThan(Date.now());
  });
});

describe('isLocalhostHost', () => {
  it.each<{ tc: string; host: string | null; expected: boolean }>([
    { tc: 'TC-U-09', host: 'localhost:3232', expected: true },
    { tc: 'TC-U-10', host: '127.0.0.1:3232', expected: true },
    { tc: 'TC-U-11', host: '[::1]:3232', expected: true },
    { tc: 'TC-U-12', host: 'localhost', expected: true },
    { tc: 'TC-U-13', host: '192.168.1.5:3232', expected: false },
    { tc: 'TC-U-14', host: 'evil.example.com', expected: false },
    { tc: 'TC-U-15', host: 'localhost.evil.com', expected: false },
    { tc: 'TC-U-16', host: '0.0.0.0:3232', expected: false },
    { tc: 'TC-U-17', host: null, expected: false },
  ])('$tc: host=$host', ({ host, expected }) => {
    expect(isLocalhostHost(host)).toBe(expected);
  });

  it('TC-U-15b: literal "127.0.0.1.evil.com" does not match', () => {
    expect(isLocalhostHost('127.0.0.1.evil.com')).toBe(false);
  });
});
