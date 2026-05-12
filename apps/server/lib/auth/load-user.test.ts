/**
 * Unit + integration tests for `lib/auth/load-user.ts` after the
 * central-server-onboarding-v2-sso.schema-migrations refactor.
 *
 * Covers TC-U-01..09, TC-U-12 (unit, no DB) + TC-I-33..37 (integration,
 * Postgres via testcontainers — gated on `SKIP_PG_TESTS`).
 *
 * Scope by REQ:
 *   REQ-11: `loadUserByEmail` returns `LoadedUser[]` ordered by
 *           `created_at ASC` (TC-I-33..35, TC-U-07).
 *   REQ-12: `loadUserBySsoIdentity(provider, subject)` returns
 *           `LoadedUser | null`; throws on >1-row constraint drift
 *           (TC-U-08, TC-U-12, TC-I-36..37).
 *   REQ-13: `evaluateSignIn(oauth, existing[])` with 5-branch decision
 *           tree including new `ambiguous-multi-org` kind
 *           (TC-U-01..06, TC-U-09).
 *
 * Conventions: hand-written stubs (no mocking framework), descriptive
 * natural-English test names, table-driven via `it.each` where branching
 * is uniform.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { orgs, users } from '@/lib/db/schema';
import {
  evaluateSignIn,
  loadUserByEmail,
  loadUserBySsoIdentity,
  type LoadedUser,
  type SignInDecision,
  type SignInExisting,
} from './load-user';

// ---------------------------------------------------------------------------
// Unit tests — pure `evaluateSignIn` decision tree + typecheck assertions.
// No DB involvement; safe to run regardless of SKIP_PG_TESTS.
// ---------------------------------------------------------------------------

describe('evaluateSignIn — pure decision helper (REQ-13)', () => {
  // TC-U-01
  it('returns { kind: "bootstrap" } when existing is empty array', () => {
    const decision = evaluateSignIn(
      { provider: 'google', providerAccountId: 'sub-x' },
      [],
    );
    expect(decision).toEqual({ kind: 'bootstrap' });
  });

  // TC-U-02
  it('returns { kind: "allow" } with 1 row whose SSO matches the OAuth tuple', () => {
    const decision = evaluateSignIn(
      { provider: 'google', providerAccountId: 'sub-2' },
      [{ ssoProvider: 'google', ssoSubject: 'sub-2' }],
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  // TC-U-03 — fill-sso payload MUST come from `oauth`, not from `existing[0]`.
  // Stresses the invariant that the new SSO identity is written from the
  // incoming OAuth attempt (since the existing row's SSO columns are null).
  it('returns fill-sso with payload sourced from oauth (NOT existing[0]) when row has null ssoProvider', () => {
    const decision = evaluateSignIn(
      { provider: 'okta', providerAccountId: 'okta-sub-3' },
      [{ ssoProvider: null, ssoSubject: null }],
    );
    expect(decision).toEqual({
      kind: 'fill-sso',
      provider: 'okta',
      subject: 'okta-sub-3',
    });
  });

  // TC-U-04 — provider mismatch.
  it('returns reject-mismatch when 1 row\'s ssoProvider differs from OAuth provider', () => {
    const decision = evaluateSignIn(
      { provider: 'okta', providerAccountId: 'okta-sub-4' },
      [{ ssoProvider: 'google', ssoSubject: 'google-sub-4' }],
    );
    expect(decision).toEqual({ kind: 'reject-mismatch' });
  });

  // TC-U-04 — subject mismatch with same provider (account-hijack defense).
  it('returns reject-mismatch when provider matches but subject differs (account-hijack defense)', () => {
    const decision = evaluateSignIn(
      { provider: 'google', providerAccountId: 'sub-OTHER' },
      [{ ssoProvider: 'google', ssoSubject: 'sub-OWNER' }],
    );
    expect(decision).toEqual({ kind: 'reject-mismatch' });
  });

  // TC-U-05 / TC-U-06 — `length >= 2` always → ambiguous-multi-org, no
  // count-based branching beyond the boundary.
  it.each<[number, SignInExisting[]]>([
    [2, [
      { ssoProvider: 'google', ssoSubject: 'g1' },
      { ssoProvider: 'okta', ssoSubject: 'o1' },
    ]],
    [5, [
      { ssoProvider: 'google', ssoSubject: 'g1' },
      { ssoProvider: 'google', ssoSubject: 'g2' },
      { ssoProvider: 'okta', ssoSubject: 'o1' },
      { ssoProvider: null, ssoSubject: null },
      { ssoProvider: null, ssoSubject: null },
    ]],
  ])('returns ambiguous-multi-org when existing has %s rows', (_n, existing) => {
    const decision = evaluateSignIn(
      { provider: 'google', providerAccountId: 'sub-x' },
      existing,
    );
    expect(decision).toEqual({ kind: 'ambiguous-multi-org' });
  });

  // TC-U-07 — typecheck-only: empty array conforms to LoadedUser[].
  it('TC-U-07: LoadedUser[] empty array typechecks (compile-time assertion)', () => {
    const empty: LoadedUser[] = [];
    expect(empty).toEqual([]);
  });

  // TC-U-08 — typecheck-only: loadUserBySsoIdentity signature.
  it('TC-U-08: loadUserBySsoIdentity signature returns Promise<LoadedUser | null>', () => {
    const _typed: (provider: string, subject: string) => Promise<LoadedUser | null> =
      loadUserBySsoIdentity;
    expect(typeof _typed).toBe('function');
  });

  // TC-U-09 — typecheck-only: union extended with ambiguous-multi-org.
  it('TC-U-09: SignInDecision union includes "ambiguous-multi-org" kind', () => {
    const decision: SignInDecision = { kind: 'ambiguous-multi-org' };
    expect(decision.kind).toBe('ambiguous-multi-org');
  });
});

// ---------------------------------------------------------------------------
// Integration tests against real Postgres — gated on SKIP_PG_TESTS.
// Covers:
//   REQ-11: TC-I-33..35 (array shape + ORDER BY created_at ASC)
//   REQ-12: TC-I-36..37 (lookup happy paths) + TC-U-12 (defensive throw)
//
// All under one describe block so the shared pool lifecycle (one
// `closeDb()` in `afterAll`) is correct. Per-test isolation is handled by
// `afterEach` truncating the `users` table.
// ---------------------------------------------------------------------------

const SKIP_PG = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP_PG ? describe.skip : describe;

skipDescribe('load-user — Postgres integration (REQ-11, REQ-12)', () => {
  let orgAId = '';
  let orgBId = '';

  beforeAll(async () => {
    const db = getDb();
    // TASK-3 applies migration 0004 manually because the Drizzle journal
    // entry is generated post-batch by TASK-SNAPSHOT (per spec Decisão #13).
    // Without 0004, the legacy `users_email_key` global UNIQUE survives and
    // breaks TC-I-35 (same email across orgs). Idempotent via `IF NOT EXISTS`
    // + dynamic constraint-name resolution inside the migration.
    //
    // We bypass Drizzle's `db.execute()` here because it parses the SQL
    // template (rejecting bare backticks inside SQL comments). The raw `pg`
    // Pool runs the file verbatim, matching how setup-pg.ts handles
    // un-journaled .sql files.
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL unset — setup-pg did not initialize');
    const migration0004Path = path.resolve(
      __dirname,
      '../db/migrations/0004_sso_auto_provision_schema.sql',
    );
    const migration0004Raw = readFileSync(migration0004Path, 'utf8');
    // Migration uses psql variable substitution `:"app_role"` (REQ-6 +
    // Decisão #10 — production runner injects via `--variable=app_role=...`).
    // For test environments we substitute the testcontainers default role
    // (`test` — see setup-pg.ts) before executing through node-postgres,
    // which does NOT support psql client-side variables.
    const migration0004 = migration0004Raw.replace(/:"app_role"/g, '"test"');
    const pool = new Pool({ connectionString: dbUrl });
    try {
      // node-postgres' simple-query path handles multi-statement chunks but
      // chokes on some PL/pgSQL escape patterns; split on Drizzle's
      // breakpoint marker so each chunk is a single self-contained statement
      // (or `DO $$...$$` block). The marker is matched ONLY at the start of
      // a line so in-comment references to the literal string (line 11 of
      // 0004 mentions it inside a `--` comment) don't accidentally split.
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

    // Mirror the 12-table TRUNCATE list from sibling integration suites so
    // this file stays order-independent.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    const [a] = await db.insert(orgs).values({ name: 'OrgA-load-user' }).returning({ id: orgs.id });
    const [b] = await db.insert(orgs).values({ name: 'OrgB-load-user' }).returning({ id: orgs.id });
    orgAId = a.id;
    orgBId = b.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    // Keep orgs across tests (FK targets); wipe users only.
    await db.delete(users);
  });

  // TC-I-33
  it('TC-I-33: loadUserByEmail returns [] when no row matches the email', async () => {
    const rows = await loadUserByEmail('nobody@example.com');
    expect(rows).toEqual([]);
  });

  // TC-I-34
  it('TC-I-34: loadUserByEmail returns a single-element array when exactly 1 row matches', async () => {
    const db = getDb();
    const [inserted] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'solo@example.com',
        ssoProvider: 'google',
        ssoSubject: 'g-solo',
        role: 'member',
      })
      .returning({ id: users.id });

    const rows = await loadUserByEmail('solo@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      userId: inserted.id,
      role: 'member',
      orgId: orgAId,
      ssoProvider: 'google',
    });
  });

  // TC-I-35 — same email across two orgs; result ordered by created_at ASC.
  it('TC-I-35: loadUserByEmail returns 2-element array sorted by created_at ASC across orgs', async () => {
    const db = getDb();
    const [oldest] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'multi@example.com',
        ssoProvider: 'google',
        ssoSubject: 'g-multi-old',
        role: 'member',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      })
      .returning({ id: users.id });

    const [newest] = await db
      .insert(users)
      .values({
        orgId: orgBId,
        email: 'multi@example.com',
        ssoProvider: 'okta',
        ssoSubject: 'o-multi-new',
        role: 'manager',
        createdAt: new Date('2025-01-01T00:00:00Z'),
      })
      .returning({ id: users.id });

    const rows = await loadUserByEmail('multi@example.com');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.userId).toBe(oldest.id);
    expect(rows[0]?.orgId).toBe(orgAId);
    expect(rows[1]?.userId).toBe(newest.id);
    expect(rows[1]?.orgId).toBe(orgBId);
  });

  // TC-I-36
  it('TC-I-36: loadUserBySsoIdentity("google", "subX") returns the matching user', async () => {
    const db = getDb();
    const [inserted] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'sso-match@example.com',
        ssoProvider: 'google',
        ssoSubject: 'subX',
        role: 'admin',
      })
      .returning({ id: users.id });

    const loaded = await loadUserBySsoIdentity('google', 'subX');
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual({
      userId: inserted.id,
      role: 'admin',
      orgId: orgAId,
      ssoProvider: 'google',
    });
  });

  // TC-I-37
  it('TC-I-37: loadUserBySsoIdentity returns null when no row matches the SSO identity', async () => {
    const loaded = await loadUserBySsoIdentity('google', 'no-such-sub');
    expect(loaded).toBeNull();
  });

  // TC-U-12 — defensive invariant. The per-org unique constraint allows
  // the same (provider, subject) across orgs; this is the *only* way to
  // produce >1 row globally. The helper must refuse to silently pick one.
  it('TC-U-12: loadUserBySsoIdentity throws "invariant violation: multiple users" when >1 row matches across orgs', async () => {
    const db = getDb();
    await db.insert(users).values({
      orgId: orgAId,
      email: 'dup-a@example.com',
      ssoProvider: 'google',
      ssoSubject: 'shared-sub-12',
      role: 'member',
    });
    await db.insert(users).values({
      orgId: orgBId,
      email: 'dup-b@example.com',
      ssoProvider: 'google',
      ssoSubject: 'shared-sub-12',
      role: 'member',
    });

    await expect(
      loadUserBySsoIdentity('google', 'shared-sub-12'),
    ).rejects.toThrow(/invariant violation: multiple users/);
  });

  // TC-I-40 — REQ-14 transitional: jwt callback's "pick first" arm when
  // an email is shared across ≥2 orgs (post-REQ-1 relaxation). The
  // `ambiguous-multi-org` decision branch is exercised by TC-U-05/06; this
  // test locks the upstream invariant the jwt callback relies on:
  // `loadUserByEmail` returns rows in deterministic `created_at ASC` order
  // so the "pick first" pragma actually picks the oldest row.
  it('TC-I-40: with 2 orgs sharing an email, loadUserByEmail order is stable across calls (jwt callback pick-first determinism)', async () => {
    const db = getDb();
    const [older] = await db
      .insert(users)
      .values({
        orgId: orgAId,
        email: 'jwt-determinism@example.com',
        ssoProvider: 'google',
        ssoSubject: 'jwt-det-sub-a',
        role: 'member',
      })
      .returning({ id: users.id, createdAt: users.createdAt });
    // Force a measurable created_at delta so the ordering is unambiguous.
    await new Promise((r) => setTimeout(r, 50));
    const [newer] = await db
      .insert(users)
      .values({
        orgId: orgBId,
        email: 'jwt-determinism@example.com',
        ssoProvider: 'google',
        ssoSubject: 'jwt-det-sub-b',
        role: 'admin',
      })
      .returning({ id: users.id, createdAt: users.createdAt });
    expect(newer.createdAt.getTime()).toBeGreaterThan(older.createdAt.getTime());

    // Two independent calls must return the same first row (oldest).
    const first = await loadUserByEmail('jwt-determinism@example.com');
    const second = await loadUserByEmail('jwt-determinism@example.com');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]?.userId).toBe(older.id);
    expect(second[0]?.userId).toBe(older.id);
  });
});
