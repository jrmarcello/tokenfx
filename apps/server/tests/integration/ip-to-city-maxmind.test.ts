/**
 * MaxMind-backed `ipToCity` integration tests (TASK-9 of
 * `.specs/central-server-onboarding-v2-sso.manager-ui.md`).
 *
 * Coverage:
 *   - TC-U-20  : empty IP, MaxMind disabled → null
 *   - TC-U-21  : loopback IP, MaxMind enabled → null (private-IP guard)
 *   - TC-U-22  : malformed IP → null
 *   - TC-I-36  : happy path — known IP resolves to expected city
 *   - TC-I-37  : env path missing → null + warn fires once
 *   - TC-I-37b : env path corrupt/truncated → null + warn fires once;
 *                subsequent calls remain cheap (sticky init-failed flag)
 *   - TC-I-37c : env path valid but wrong databaseType → null + warn once
 *   - TC-I-38  : env unset → null (singleton stays uninitialised)
 *   - TC-I-39  : `writeAuthEvent` persists `city` column when ipToCity
 *                returns non-null (against Testcontainers Postgres)
 *   - TC-I-40  : `writeAuthEvent` persists `city = null` when ipToCity
 *                returns null
 *
 * No mocking framework. Each test owns the env state (`beforeEach` reset)
 * and re-imports `./ip-to-city` via `vi.resetModules()` so the module-
 * level singleton + warn-once flags start clean every time. This is the
 * same pattern used by `lib/auth/auth.test.ts` and friends in the repo.
 *
 * Fixtures: `tests/fixtures/GeoIP2-City-Test.mmdb` (happy path) +
 * `tests/fixtures/GeoIP2-Country-Test.mmdb` (wrong-type). Provenance +
 * regeneration are documented in `tests/fixtures/README.md`.
 */
import { sql } from 'drizzle-orm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const HAPPY_FIXTURE = path.join(FIXTURE_DIR, 'GeoIP2-City-Test.mmdb');
const WRONG_TYPE_FIXTURE = path.join(FIXTURE_DIR, 'GeoIP2-Country-Test.mmdb');

const SKIP_PG = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP_PG ? describe.skip : describe;

// Save + restore the bits of process.env we mutate. We never poke
// anything else, so the integration suite's globalSetup-injected
// DATABASE_URL is preserved.
let savedEnv: { MAXMIND_DB_PATH: string | undefined };

beforeEach(() => {
  savedEnv = { MAXMIND_DB_PATH: process.env.MAXMIND_DB_PATH };
  delete process.env.MAXMIND_DB_PATH;
  vi.resetModules();
});

afterEach(() => {
  if (savedEnv.MAXMIND_DB_PATH === undefined) {
    delete process.env.MAXMIND_DB_PATH;
  } else {
    process.env.MAXMIND_DB_PATH = savedEnv.MAXMIND_DB_PATH;
  }
  vi.restoreAllMocks();
});

/** Re-import `ip-to-city` after `vi.resetModules()` so the singleton is fresh. */
const freshIpToCity = async (): Promise<(ip: string) => Promise<string | null>> => {
  const mod = await import('@/lib/auth/ip-to-city');
  return mod.ipToCity;
};

/**
 * Spy on `log.warn` for warn-once assertions. The logger module is at
 * `@root/logger` (repo-root `lib/logger.ts`). After `vi.resetModules()`
 * the consumer module sees the spied import.
 */
const spyOnLogWarn = async (): Promise<ReturnType<typeof vi.spyOn>> => {
  const loggerMod = await import('@root/logger');
  return vi.spyOn(loggerMod.log, 'warn').mockImplementation(() => {});
};

describe('ipToCity (MaxMind-backed)', () => {
  describe('input-guard short-circuits (no fixture needed)', () => {
    it('returns null when MAXMIND_DB_PATH is unset (TC-U-20 / TC-I-38)', async () => {
      const ipToCity = await freshIpToCity();
      await expect(ipToCity('')).resolves.toBeNull();
      await expect(ipToCity('8.8.8.8')).resolves.toBeNull();
    });

    it.each([
      { name: 'IPv4 loopback', ip: '127.0.0.1' },
      { name: 'IPv4 link-local', ip: '169.254.1.1' },
      { name: 'IPv4 10/8',        ip: '10.0.0.1' },
      { name: 'IPv4 172.16/12 low',  ip: '172.16.0.1' },
      { name: 'IPv4 172.16/12 high', ip: '172.31.255.254' },
      { name: 'IPv4 192.168/16', ip: '192.168.1.1' },
      { name: 'IPv6 loopback',   ip: '::1' },
      { name: 'IPv6 fc00::/7',   ip: 'fc00::1' },
      { name: 'IPv6 fd00::/8',   ip: 'fd12:3456:789a::1' },
    ])('rejects private/loopback inline before DB lookup (TC-U-21): $name', async ({ ip }) => {
      // Even with MaxMind enabled, private IPs MUST NOT hit the reader.
      process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
      const ipToCity = await freshIpToCity();
      await expect(ipToCity(ip)).resolves.toBeNull();
    });

    it.each([
      { name: 'empty',     ip: '' },
      { name: 'whitespace', ip: '   ' },
      { name: 'garbage',   ip: 'not-an-ip' },
      { name: 'half-IPv4', ip: '1.2.3' },
      { name: 'IPv4 octet out of range', ip: '999.0.0.1' },
    ])('returns null for malformed input (TC-U-22): $name', async ({ ip }) => {
      process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
      const ipToCity = await freshIpToCity();
      await expect(ipToCity(ip)).resolves.toBeNull();
    });
  });

  describe('with a valid GeoIP2-City fixture', () => {
    it.each([
      { ip: '81.2.69.142',   city: 'London' },
      { ip: '2.125.160.216', city: 'Boxford' },
      { ip: '175.16.199.1',  city: 'Changchun' },
      { ip: '89.160.20.112', city: 'Linköping' },
      { ip: '216.160.83.56', city: 'Milton' },
    ])('returns $city for $ip (TC-I-36)', async ({ ip, city }) => {
      process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
      const ipToCity = await freshIpToCity();
      await expect(ipToCity(ip)).resolves.toBe(city);
    });

    it('returns null for a routable IP not present in the fixture (TC-I-36 negative)', async () => {
      process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
      const ipToCity = await freshIpToCity();
      await expect(ipToCity('8.8.8.8')).resolves.toBeNull();
    });

    it('reuses the singleton reader across concurrent first calls (Promise-gate)', async () => {
      // Race-safety: two concurrent calls before init finishes must
      // share the same Promise (not each kick off a separate open()).
      // We assert behaviour: both resolve to the same city, and a third
      // sequential call also resolves immediately.
      process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
      const ipToCity = await freshIpToCity();
      const [a, b] = await Promise.all([
        ipToCity('81.2.69.142'),
        ipToCity('2.125.160.216'),
      ]);
      expect(a).toBe('London');
      expect(b).toBe('Boxford');
      await expect(ipToCity('175.16.199.1')).resolves.toBe('Changchun');
    });
  });

  describe('failure modes (warn-once)', () => {
    it('returns null and warns once when MAXMIND_DB_PATH points to a missing file (TC-I-37)', async () => {
      process.env.MAXMIND_DB_PATH = path.join(FIXTURE_DIR, '__does_not_exist__.mmdb');
      const warn = await spyOnLogWarn();
      const ipToCity = await freshIpToCity();
      await expect(ipToCity('81.2.69.142')).resolves.toBeNull();
      // Subsequent calls do not emit additional warns.
      await expect(ipToCity('2.125.160.216')).resolves.toBeNull();
      await expect(ipToCity('216.160.83.56')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('returns null and warns once when the mmdb file is corrupt (TC-I-37b)', async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'tokenfx-mmdb-'));
      const corruptPath = path.join(tmpDir, 'corrupt.mmdb');
      // Bytes that look nothing like a MaxMind DB binary (no metadata
      // marker, truncated): forces `maxmind.open` to throw.
      writeFileSync(corruptPath, Buffer.from('not-a-real-mmdb-binary-payload'));
      process.env.MAXMIND_DB_PATH = corruptPath;
      try {
        const warn = await spyOnLogWarn();
        const ipToCity = await freshIpToCity();
        await expect(ipToCity('81.2.69.142')).resolves.toBeNull();
        await expect(ipToCity('216.160.83.56')).resolves.toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null and warns once when databaseType is unsupported (TC-I-37c)', async () => {
      // GeoIP2-Country has the same binary format as City but a
      // different `database_type` metadata string + no city records.
      process.env.MAXMIND_DB_PATH = WRONG_TYPE_FIXTURE;
      const warn = await spyOnLogWarn();
      const ipToCity = await freshIpToCity();
      await expect(ipToCity('81.2.69.142')).resolves.toBeNull();
      await expect(ipToCity('2.125.160.216')).resolves.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

// ---- TC-I-39 / TC-I-40: writer integration with Postgres ----

skipDescribe('writeAuthEvent persists city from ipToCity', () => {
  const emailHashForTest = (suffix: string): string => `task9-ip-to-city-${suffix}`;

  beforeAll(async () => {
    // Ensure we're not picking up a stale MaxMind config from another suite.
    delete process.env.MAXMIND_DB_PATH;
  });

  afterAll(async () => {
    const { closeDb, getDb } = await import('@/lib/db/client');
    const db = getDb();
    await db.execute(
      sql`DELETE FROM auth_event_log WHERE email_hash LIKE 'task9-ip-to-city-%'`,
    );
    await closeDb();
  });

  it('persists city when ipToCity returns a non-null value (TC-I-39)', async () => {
    process.env.MAXMIND_DB_PATH = HAPPY_FIXTURE;
    vi.resetModules();

    const { ipToCity } = await import('@/lib/auth/ip-to-city');
    const { writeAuthEvent } = await import('@/lib/auth/auth-event-log-writer');
    const { getDb } = await import('@/lib/db/client');

    const ip = '81.2.69.142';
    const city = await ipToCity(ip);
    expect(city).toBe('London');

    const emailHash = emailHashForTest('with-city');
    await writeAuthEvent({
      ssoProvider: 'google',
      iss: 'https://accounts.google.com',
      emailHash,
      ssoSubjectHash: 'subj-with-city',
      ip,
      city,
      userAgent: 'Mozilla/5.0 (vitest-task9)',
      outcome: 'accepted-sso-auto',
    });

    const db = getDb();
    const rows = await db.execute<{ city: string | null }>(
      sql`SELECT city FROM auth_event_log WHERE email_hash = ${emailHash}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].city).toBe('London');
  });

  it('persists null when ipToCity returns null (TC-I-40)', async () => {
    delete process.env.MAXMIND_DB_PATH;
    vi.resetModules();

    const { ipToCity } = await import('@/lib/auth/ip-to-city');
    const { writeAuthEvent } = await import('@/lib/auth/auth-event-log-writer');
    const { getDb } = await import('@/lib/db/client');

    const ip = '8.8.8.8';
    const city = await ipToCity(ip);
    expect(city).toBeNull();

    const emailHash = emailHashForTest('null-city');
    await writeAuthEvent({
      ssoProvider: 'google',
      iss: 'https://accounts.google.com',
      emailHash,
      ssoSubjectHash: 'subj-null-city',
      ip,
      city,
      userAgent: 'Mozilla/5.0 (vitest-task9)',
      outcome: 'accepted-sso-auto',
    });

    const db = getDb();
    const rows = await db.execute<{ city: string | null }>(
      sql`SELECT city FROM auth_event_log WHERE email_hash = ${emailHash}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].city).toBeNull();
  });
});
