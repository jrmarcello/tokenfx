import { describe, it, expect } from 'vitest';
import { ipToCity } from './ip-to-city';

/**
 * v2 baseline stub: every input resolves to null (REQ-21 / TC-U-32). The
 * interface is deliberately Promise<string | null> so a future spec can swap
 * in MaxMind GeoLite2 (or equivalent) without touching call sites in
 * `auth-event-log-writer.ts` and `impossible-travel.ts`.
 */
describe('ipToCity (v2 stub)', () => {
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
