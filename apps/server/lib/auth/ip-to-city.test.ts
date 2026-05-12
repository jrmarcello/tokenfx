import { beforeEach, describe, it, expect } from 'vitest';
import { ipToCity } from './ip-to-city';

// Ensure no sibling test or shell env enables MaxMind for this file —
// every assertion below depends on the disabled-mode contract.
beforeEach(() => {
  delete process.env.MAXMIND_DB_PATH;
});

/**
 * Disabled-mode behaviour: with `MAXMIND_DB_PATH` unset every input
 * resolves to null. This file pins the signature + the
 * "no-config = no work" contract. The MaxMind-enabled behaviour
 * (happy path, warn-once failure modes, private-IP guards) is
 * covered by `tests/integration/ip-to-city-maxmind.test.ts`.
 */
describe('ipToCity (disabled mode — MAXMIND_DB_PATH unset)', () => {
  it.each([
    { name: 'IPv4 loopback', ip: '127.0.0.1' },
    { name: 'IPv4 public', ip: '8.8.8.8' },
    { name: 'IPv4 private', ip: '192.168.1.1' },
  ])('returns null for any IP (v2 stub baseline): $name', async ({ ip }) => {
    await expect(ipToCity(ip)).resolves.toBeNull();
  });

  it.each([
    { name: 'empty string', ip: '' },
    { name: 'malformed', ip: 'not-an-ip' },
    { name: 'whitespace', ip: '   ' },
  ])('returns null for invalid input: $name', async ({ ip }) => {
    await expect(ipToCity(ip)).resolves.toBeNull();
  });

  it.each([
    { name: 'IPv6 loopback', ip: '::1' },
    { name: 'IPv6 full', ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
    { name: 'IPv6 compressed', ip: '2001:db8::1' },
  ])('returns null for IPv6: $name', async ({ ip }) => {
    await expect(ipToCity(ip)).resolves.toBeNull();
  });
});
