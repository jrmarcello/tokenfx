/**
 * Integration tests for `lib/auth/impossible-travel.ts` — baseline
 * anomaly heuristic (central-server-onboarding-v2-sso.backend.md — REQ
 * "impossible-travel"; Decisão #7).
 *
 * Covers TC-U-25..31 + TC-U-44/45 (the test plan classifies these as
 * "U" but the heuristic queries the DB, so they run as integration
 * tests against testcontainers Postgres — gated on `SKIP_PG_TESTS`).
 *
 * Conventions:
 *   - Hand-written stubs only (none needed; the function takes
 *     `(hash, city, time)` and reads `auth_event_log` directly — we
 *     seed real rows via Drizzle).
 *   - Test names in natural English, no TC-IDs in the title.
 *   - Boundary cases use synthetic `TestCity{A,B,C}` coords engineered
 *     on the equator/prime-meridian to hit *exact* 500km and 500.01km
 *     thresholds without floating-point slop.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { authEventLog } from '@/lib/db/schema';
import { checkImpossibleTravel } from './impossible-travel';

const SKIP_PG = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP_PG ? describe.skip : describe;

skipDescribe('checkImpossibleTravel — baseline heuristic (Decisão #7)', () => {
  // Anchor time used by every test (deterministic; avoids `Date.now()` flake).
  // Picked well in the future so seed `occurred_at` deltas fit comfortably.
  const NOW_MS = new Date('2026-01-01T12:00:00Z').getTime();
  const ONE_HOUR_MS = 60 * 60 * 1000;

  // Fixed subject hashes — function takes hash strings; we don't go through
  // the pepper helper here (irrelevant to the heuristic under test).
  const HASH_TRAVELER = 'hash-traveler-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const HASH_NEW = 'hash-newcomer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const HASH_NULL_PRIOR = 'hash-nullcity-ccccccccccccccccccccccccccccccccccccccccc';
  const HASH_UNKNOWN_PRIOR = 'hash-unkprior-dddddddddddddddddddddddddddddddddddddddd';

  beforeAll(async () => {
    // Apply migration 0004 manually (same rationale as load-user.test.ts:155-197):
    // testcontainers `setup-pg.ts` only applies migrations whose Drizzle
    // journal entry exists. Migration 0004's journal entry is generated
    // post-batch; without explicit application the `auth_event_log` table
    // is missing.
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL unset — setup-pg did not initialize');
    const migration0004Path = path.resolve(
      __dirname,
      '../db/migrations/0004_sso_auto_provision_schema.sql',
    );
    const migration0004Raw = readFileSync(migration0004Path, 'utf8');
    const migration0004 = migration0004Raw.replace(/:"app_role"/g, '"test"');
    const pool = new Pool({ connectionString: dbUrl });
    try {
      const chunks = migration0004
        .split(/^--> statement-breakpoint$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const chunk of chunks) {
        await pool.query(chunk);
      }
    } finally {
      await pool.end();
    }

    // Wipe auth_event_log so prior test files don't leak rows; the table
    // is append-only with no FK fan-out, so a focused TRUNCATE is safe.
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE auth_event_log RESTART IDENTITY`);
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(authEventLog);
  });

  /**
   * Seed a single prior accepted-sso-auto event. Returns nothing; the
   * function under test reads the row by (subject_hash, outcome).
   */
  const seedPriorEvent = async (
    hash: string,
    city: string | null,
    occurredAt: Date,
  ): Promise<void> => {
    const db = getDb();
    await db.insert(authEventLog).values({
      ssoProvider: 'google',
      iss: 'https://accounts.google.com',
      emailHash: 'email-hash-stub-not-relevant-to-heuristic',
      ssoSubjectHash: hash,
      ip: '203.0.113.1',
      city,
      userAgent: 'test-agent',
      outcome: 'accepted-sso-auto',
      occurredAt,
    });
  };

  // TC-U-25 — same city, well within the window: no alert.
  it('same city + 30min apart -> no alert', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'New York', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-26 — classic impossible-travel: NYC -> Tokyo in 30min.
  it('NYC + Tokyo + 30min apart -> alert fires with reason containing impossible-travel', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'Tokyo', NOW_MS);
    expect(result.alert).toBe(true);
    if (result.alert) {
      expect(result.reason).toContain('impossible-travel');
      expect(result.reason).toContain('New York');
      expect(result.reason).toContain('Tokyo');
      expect(result.reason).toContain('30min');
    }
  });

  // TC-U-27 — same geography but 2h elapsed; outside the window -> no alert.
  it('NYC + Tokyo + 2h apart -> no alert (>1h window)', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - 2 * ONE_HOUR_MS));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'Tokyo', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-28 — prior event's city column is NULL (ipToCity returned null);
  // heuristic has insufficient data so it fails safe.
  it('prior city NULL -> no alert', async () => {
    await seedPriorEvent(HASH_NULL_PRIOR, null, new Date(NOW_MS - 10 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_NULL_PRIOR, 'Tokyo', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-29 — no prior accepted-sso-auto event at all.
  it('no prior event -> no alert', async () => {
    const result = await checkImpossibleTravel(HASH_NEW, 'Tokyo', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-30 — exactly 500km apart (TestCityA <-> TestCityB engineered to hit
  // the boundary). Strict greater-than means equality does NOT trigger.
  it('500km exact threshold -> no alert (strict greater-than)', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'TestCityA', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'TestCityB', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-31 — 500.01km (TestCityA <-> TestCityC): just over the threshold.
  it('500.01km -> alert', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'TestCityA', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'TestCityC', NOW_MS);
    expect(result.alert).toBe(true);
    if (result.alert) {
      expect(result.reason).toContain('impossible-travel');
    }
  });

  // TC-U-44 — elapsed time exactly 3,600,000ms (1h). Strict less-than means
  // equality does NOT trigger.
  it('1h exact (3600000ms) -> no alert (strict less-than)', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - ONE_HOUR_MS));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'Tokyo', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // TC-U-45 — 1ms inside the window. Together with TC-U-44 this pins the
  // boundary on the "strictly less than" side.
  it('3599999ms elapsed -> alert (just inside window)', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - (ONE_HOUR_MS - 1)));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'Tokyo', NOW_MS);
    expect(result.alert).toBe(true);
    if (result.alert) {
      expect(result.reason).toContain('impossible-travel');
    }
  });

  // Current city not in CITY_COORDS: heuristic has no way to measure
  // distance, so it fails safe (no alert).
  it('current city not in CITY_COORDS -> no alert (insufficient data)', async () => {
    await seedPriorEvent(HASH_TRAVELER, 'New York', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_TRAVELER, 'Atlantis', NOW_MS);
    expect(result).toEqual({ alert: false });
  });

  // Prior city not in CITY_COORDS: same fail-safe rationale (the prior
  // city was written to the DB by some earlier MaxMind version that's no
  // longer in our hardcoded list — happens in real upgrade scenarios).
  it('prior city not in CITY_COORDS -> no alert (insufficient data)', async () => {
    await seedPriorEvent(HASH_UNKNOWN_PRIOR, 'Atlantis', new Date(NOW_MS - 30 * 60 * 1000));
    const result = await checkImpossibleTravel(HASH_UNKNOWN_PRIOR, 'Tokyo', NOW_MS);
    expect(result).toEqual({ alert: false });
  });
});
