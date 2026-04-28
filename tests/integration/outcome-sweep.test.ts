import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDbSingleton, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { ingestAll } from '@/lib/ingest/writer';
import { setupTestRepo, type TestRepo } from '@/lib/ingest/git/test-helpers';

/**
 * Integration tests for the outcome sweep wired into `ingestAll`
 * (TASK-5 in `outcome-integration-git.md`).
 *
 * - TC-I-05: candidate predicate — sessions with `ended_at >= now - 30d`
 *   AND (`last_evaluated_at IS NULL OR last_evaluated_at < ended_at`).
 *   Older or already-fresh sessions are skipped.
 * - TC-I-06: `forceOutcomes: true` re-evaluates ALL sessions, including
 *   sessions that ended > 30d ago.
 * - TC-I-07: a session with an unreachable cwd (e.g. `/etc`) does not
 *   abort the sweep — other sessions still evaluate; the failing session
 *   still gets a row (via the evaluator's `cwd-missing`/`cwd-out-of-bounds`
 *   degradation path) or is skipped without throwing.
 *
 * The sweep itself only inspects `sessions` rows, so we bypass the JSONL
 * pipeline entirely: empty `transcriptsRoot` + no OTEL URL means
 * `ingestAll` runs end-to-end (migrate → empty transcript loop →
 * recomputeCostCalibration → outcome sweep). Sessions are seeded directly
 * via SQL pointing at real ephemeral git repos created via
 * `setupTestRepo`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const seedSession = (
  db: DB,
  args: {
    id: string;
    cwd: string;
    started_at: number;
    ended_at: number;
  },
): void => {
  db.prepare(
    `INSERT INTO sessions (
       id, cwd, project, started_at, ended_at, source_file, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.cwd,
    'proj',
    args.started_at,
    args.ended_at,
    `/tmp/${args.id}.jsonl`,
    Date.now(),
  );
};

const seedOutcomeRow = (
  db: DB,
  args: {
    sessionId: string;
    lastEvaluatedAt: number;
    status?: string;
  },
): void => {
  db.prepare(
    `INSERT INTO session_outcomes (
       session_id, commit_count, loc_added, loc_removed, files_changed,
       reverts_within_7d, merged_pr_count, status, last_evaluated_at
     ) VALUES (?, 0, 0, 0, 0, 0, NULL, ?, ?)`,
  ).run(args.sessionId, args.status ?? 'evaluated', args.lastEvaluatedAt);
};

interface OutcomeRow {
  session_id: string;
  commit_count: number;
  loc_added: number;
  status: string;
  last_evaluated_at: number;
}

const readOutcome = (db: DB, sessionId: string): OutcomeRow | undefined =>
  db
    .prepare(
      `SELECT session_id, commit_count, loc_added, status, last_evaluated_at
       FROM session_outcomes WHERE session_id = ?`,
    )
    .get(sessionId) as OutcomeRow | undefined;

let dbPath = '';
let emptyTranscriptsRoot = '';
const repos: TestRepo[] = [];

const cleanupRepos = (): void => {
  while (repos.length > 0) {
    const r = repos.pop();
    r?.cleanup();
  }
};

describe('ingestAll — outcome sweep integration (TASK-5)', () => {
  beforeEach(() => {
    dbPath = `/tmp/outcome-sweep-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    process.env.DASHBOARD_DB_PATH = dbPath;
    process.env.TOKENFX_DISABLE_AUTO_INGEST = '1';
    resetDbSingleton();
    const bootstrap = openDatabase(dbPath);
    migrate(bootstrap);
    bootstrap.close();
    // An empty transcripts root keeps the JSONL loop a no-op; the sweep
    // still runs at the end of `ingestAll`.
    emptyTranscriptsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tokenfx-empty-transcripts-'),
    );
  });

  afterEach(() => {
    resetDbSingleton();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    if (emptyTranscriptsRoot && fs.existsSync(emptyTranscriptsRoot)) {
      fs.rmSync(emptyTranscriptsRoot, { recursive: true, force: true });
    }
    cleanupRepos();
    delete process.env.DASHBOARD_DB_PATH;
    delete process.env.TOKENFX_DISABLE_AUTO_INGEST;
  });

  it('TC-I-05: sweep evaluates only candidates within 30d AND stale-or-new', async () => {
    const repoFresh = setupTestRepo('sweep-fresh');
    repos.push(repoFresh);
    repoFresh.commit({ message: 'fresh-1', files: { 'a.txt': 'hi' } });

    const repoStale = setupTestRepo('sweep-stale');
    repos.push(repoStale);
    repoStale.commit({ message: 'stale-1', files: { 'b.txt': 'bye' } });

    const repoOld = setupTestRepo('sweep-old');
    repos.push(repoOld);
    repoOld.commit({ message: 'old-1', files: { 'c.txt': 'old' } });

    const now = Date.now();
    // Recent + never evaluated → IN sweep (NULL last_evaluated_at branch)
    const sFresh = 'sess-fresh';
    // Recent + already-fresh (last_evaluated_at >= ended_at) → SKIPPED
    const sStaleOk = 'sess-fresh-already-evaluated';
    // Recent + last_evaluated_at < ended_at → IN sweep (re-evaluate)
    const sStaleReeval = 'sess-stale-reeval';
    // Older than 30d → SKIPPED unless forceOutcomes
    const sOld = 'sess-old';

    const db = openDatabase(dbPath);
    seedSession(db, {
      id: sFresh,
      cwd: repoFresh.path,
      started_at: now - 10 * DAY_MS,
      ended_at: now - 9 * DAY_MS,
    });
    seedSession(db, {
      id: sStaleOk,
      cwd: repoStale.path,
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    // Mark this session's outcome row as fresh (>= ended_at) → must be skipped.
    seedOutcomeRow(db, {
      sessionId: sStaleOk,
      lastEvaluatedAt: now - 3 * DAY_MS,
    });
    seedSession(db, {
      id: sStaleReeval,
      cwd: repoStale.path,
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    // Mark stale-reeval as evaluated BEFORE ended_at → candidate.
    seedOutcomeRow(db, {
      sessionId: sStaleReeval,
      lastEvaluatedAt: now - 6 * DAY_MS,
    });
    seedSession(db, {
      id: sOld,
      cwd: repoOld.path,
      started_at: now - 60 * DAY_MS,
      ended_at: now - 59 * DAY_MS,
    });
    db.close();

    await ingestAll({
      db: openDatabase(dbPath),
      transcriptsRoot: emptyTranscriptsRoot,
    });

    const verify = openDatabase(dbPath);
    const fresh = readOutcome(verify, sFresh);
    const staleOk = readOutcome(verify, sStaleOk);
    const staleReeval = readOutcome(verify, sStaleReeval);
    const old = readOutcome(verify, sOld);
    verify.close();

    // Fresh — null branch → swept → row exists, status=evaluated
    expect(fresh).toBeDefined();
    expect(fresh?.status).toBe('evaluated');

    // Already-fresh — last_evaluated_at >= ended_at → NOT swept
    // (we seeded with last_evaluated_at = now - 3d, before sweep started)
    // Confirm the value didn't advance to >= sweep-start time.
    expect(staleOk).toBeDefined();
    expect(staleOk!.last_evaluated_at).toBeLessThan(now - 2 * DAY_MS);

    // Stale-reeval — was swept, last_evaluated_at advanced past initial seed
    expect(staleReeval).toBeDefined();
    expect(staleReeval!.last_evaluated_at).toBeGreaterThan(now - 6 * DAY_MS);

    // Old — outside 30d, no prior row → NOT swept (no row inserted)
    expect(old).toBeUndefined();
  });

  it('TC-I-06: forceOutcomes re-evaluates ALL sessions including older ones', async () => {
    const repoOld = setupTestRepo('force-old');
    repos.push(repoOld);
    repoOld.commit({ message: 'old-commit', files: { 'a.txt': 'x' } });

    const repoFresh = setupTestRepo('force-fresh');
    repos.push(repoFresh);
    repoFresh.commit({ message: 'fresh-commit', files: { 'b.txt': 'y' } });

    const now = Date.now();
    const sFresh = 'force-sess-fresh';
    const sOld = 'force-sess-old';

    const db = openDatabase(dbPath);
    seedSession(db, {
      id: sFresh,
      cwd: repoFresh.path,
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    seedSession(db, {
      id: sOld,
      cwd: repoOld.path,
      started_at: now - 60 * DAY_MS,
      ended_at: now - 59 * DAY_MS,
    });
    db.close();

    const beforeMs = Date.now();
    await ingestAll({
      db: openDatabase(dbPath),
      transcriptsRoot: emptyTranscriptsRoot,
      forceOutcomes: true,
    });

    const verify = openDatabase(dbPath);
    const fresh = readOutcome(verify, sFresh);
    const old = readOutcome(verify, sOld);
    verify.close();

    // Both must have been evaluated despite the >30d gap on `sOld`.
    expect(fresh).toBeDefined();
    expect(fresh?.status).toBe('evaluated');
    expect(fresh!.last_evaluated_at).toBeGreaterThanOrEqual(beforeMs);

    expect(old).toBeDefined();
    expect(old?.status).toBe('evaluated');
    expect(old!.last_evaluated_at).toBeGreaterThanOrEqual(beforeMs);
  });

  it('TC-I-07: a failing session does not abort the sweep — others still evaluate', async () => {
    const repoOk = setupTestRepo('sweep-ok');
    repos.push(repoOk);
    repoOk.commit({ message: 'ok-1', files: { 'a.txt': 'hi' } });

    const repoOk2 = setupTestRepo('sweep-ok-2');
    repos.push(repoOk2);
    repoOk2.commit({ message: 'ok-2', files: { 'b.txt': 'hey' } });

    const now = Date.now();
    const sOk = 'failing-test-ok';
    const sBad = 'failing-test-bad';
    const sOk2 = 'failing-test-ok-2';

    const db = openDatabase(dbPath);
    seedSession(db, {
      id: sOk,
      cwd: repoOk.path,
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    // cwd `/etc` is outside `os.homedir()` AND `os.tmpdir()` — `runGit`'s
    // sanity guard returns `cwd-out-of-bounds`, so the evaluator's
    // `isGitRepo` check fails → status='not-a-git-repo'. The sweep's
    // try/catch must keep going regardless.
    seedSession(db, {
      id: sBad,
      cwd: '/etc',
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    seedSession(db, {
      id: sOk2,
      cwd: repoOk2.path,
      started_at: now - 5 * DAY_MS,
      ended_at: now - 4 * DAY_MS,
    });
    db.close();

    await ingestAll({
      db: openDatabase(dbPath),
      transcriptsRoot: emptyTranscriptsRoot,
    });

    const verify = openDatabase(dbPath);
    const okRow = readOutcome(verify, sOk);
    const badRow = readOutcome(verify, sBad);
    const ok2Row = readOutcome(verify, sOk2);
    verify.close();

    // Both healthy sessions evaluated successfully.
    expect(okRow).toBeDefined();
    expect(okRow?.status).toBe('evaluated');
    expect(ok2Row).toBeDefined();
    expect(ok2Row?.status).toBe('evaluated');

    // The failing session either has no row OR has a row with a non-
    // 'evaluated' status (e.g. 'cwd-missing'/'not-a-git-repo'). What
    // matters: the sweep didn't crash and other sessions completed.
    if (badRow !== undefined) {
      expect(badRow.status).not.toBe('evaluated');
    }
  });
});
