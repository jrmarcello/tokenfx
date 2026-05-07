import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { evaluateSessionOutcome, type EvaluatorSession } from './evaluator';
import { log } from '@/lib/logger';
import { lookupMergedPrCount, type PrRunResult } from './pr-lookup';
import { runGit } from './run-git';

/** Per-commit runImpl fixture for v3 422-as-not-found integration TCs.
 * Either a static `PrRunResult` or a callback that interpolates the
 * commit SHA into the fixture (used to embed the canonical 422 stderr). */
type RunFixture = PrRunResult | ((sha: string) => PrRunResult);
import { setupTestRepo, type TestRepo, TEST_USER_EMAIL } from './test-helpers';
import type { OutcomeStatus } from './types';

/**
 * Hand-written test scaffolding (no mocking framework). Each test owns its
 * tmp DB + (when needed) tmp git repo and cleans up in afterEach. Real-repo
 * fixtures honor REQ-19 (no mocks of git output).
 */

type OutcomeRow = {
  session_id: string;
  commit_count: number;
  loc_added: number;
  loc_removed: number;
  files_changed: number;
  reverts_within_7d: number;
  merged_pr_count: number | null;
  status: OutcomeStatus;
  last_evaluated_at: number;
};

const setupDb = (): DB => {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
};

const insertSession = (db: DB, s: EvaluatorSession): void => {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, 'proj', NULL, NULL,
      ?, ?,
      0, 0, 0, 0, 0, 0, 0,
      ?, ?
    )`,
  ).run(s.id, s.cwd, s.started_at, s.ended_at, `/tmp/${s.id}.jsonl`, Date.now());
};

const readOutcome = (db: DB, sessionId: string): OutcomeRow | undefined =>
  db
    .prepare(
      `SELECT session_id, commit_count, loc_added, loc_removed, files_changed,
              reverts_within_7d, merged_pr_count, status, last_evaluated_at
       FROM session_outcomes WHERE session_id = ?`,
    )
    .get(sessionId) as OutcomeRow | undefined;

/**
 * Stamp a commit at a precise epoch-ms boundary. The helper accepts seconds,
 * so divide by 1000 (rounded toward zero — git rounds the same way).
 */
const commitAtMs = (
  repo: TestRepo,
  ms: number,
  files: Record<string, string>,
  message: string,
  authorEmail?: string,
): string => {
  return repo.commit({
    message,
    files,
    date: Math.floor(ms / 1000),
    authorEmail,
  });
};

/**
 * Make a "seed" commit far outside any reasonable test window. We pin it
 * at year 2000 (epoch 946684800) so the session windows centered on
 * `Date.now()` never include it, while still being a real commit so subsequent
 * commits have a parent (avoiding the empty-tree fallback path that's tested
 * separately in TC-U-19). Authored by `seed@example.com` to keep it out of
 * the user.email match too.
 */
const SEED_DATE_SEC = 946_684_800; // 2000-01-01T00:00:00Z
const seedCommit = (repo: TestRepo): string =>
  repo.commit({
    message: 'seed (year 2000, foreign author)',
    files: { '.seed': 'seed\n' },
    date: SEED_DATE_SEC,
    authorEmail: 'seed@example.com',
  });

describe('evaluateSessionOutcome', () => {
  let db: DB;
  let repo: TestRepo | null = null;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    if (repo) {
      repo.cleanup();
      repo = null;
    }
    db.close();
  });

  // ──────────────────────────────────────────────────────────
  // REQ-2: cwd-missing / not-a-git-repo
  // ──────────────────────────────────────────────────────────

  it('TC-U-14: session.cwd does not exist on disk → status: cwd-missing, all metrics 0', () => {
    const fakeCwd = path.join(
      os.homedir(),
      `tokenfx-evaluator-missing-${Date.now()}`,
    );
    expect(fs.existsSync(fakeCwd)).toBe(false);

    const session: EvaluatorSession = {
      id: 'sess-cwd-missing',
      cwd: fakeCwd,
      started_at: 1_000_000,
      ended_at: 2_000_000,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe('cwd-missing');
    expect(row?.commit_count).toBe(0);
    expect(row?.loc_added).toBe(0);
    expect(row?.loc_removed).toBe(0);
    expect(row?.files_changed).toBe(0);
    expect(row?.reverts_within_7d).toBe(0);
    expect(row?.merged_pr_count).toBeNull();
    expect(row?.last_evaluated_at).toBeGreaterThan(0);
  });

  it('TC-U-15: cwd exists but has no .git → status: not-a-git-repo, metrics 0', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tokenfx-evaluator-not-git-'),
    );
    try {
      const session: EvaluatorSession = {
        id: 'sess-not-git',
        cwd: dir,
        started_at: 1_000_000,
        ended_at: 2_000_000,
      };
      insertSession(db, session);

      evaluateSessionOutcome(db, session);

      const row = readOutcome(db, session.id);
      expect(row?.status).toBe('not-a-git-repo');
      expect(row?.commit_count).toBe(0);
      expect(row?.loc_added).toBe(0);
      expect(row?.loc_removed).toBe(0);
      expect(row?.files_changed).toBe(0);
      expect(row?.reverts_within_7d).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────
  // REQ-4: no user.email → status: no-user-email
  // ──────────────────────────────────────────────────────────

  it('TC-U-16: repo with no user.email locally and no fallback global → status: no-user-email', () => {
    // Create a real repo, then unset local user.email AND override the global
    // env so `git config user.email` finds nothing.
    repo = setupTestRepo('no-user-email');
    repo.commit({ message: 'initial', files: { 'a.txt': 'x' } });

    // Wipe local user.email — leave a placeholder name so commits made earlier
    // still resolve. The evaluator only reads user.email so this is enough.
    spawnSync('git', ['config', '--local', '--unset', 'user.email'], {
      cwd: repo.path,
      shell: false,
    });

    const session: EvaluatorSession = {
      id: 'sess-no-email',
      cwd: repo.path,
      started_at: 1_000_000,
      ended_at: Date.now(),
    };
    insertSession(db, session);

    // Override HOME and XDG_CONFIG_HOME so global git config can't supply email.
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
    const fakeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'tokenfx-evaluator-fakehome-'),
    );
    process.env.HOME = fakeHome;
    process.env.XDG_CONFIG_HOME = fakeHome;
    // Per `man git-config`, GIT_CONFIG_GLOBAL=/dev/null disables the global
    // config file lookup entirely — the most reliable way to suppress the
    // ambient `~/.gitconfig` user.email during this test.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';

    try {
      evaluateSessionOutcome(db, session);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
      if (prevGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prevGitConfigSystem;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('no-user-email');
    expect(row?.commit_count).toBe(0);
    expect(row?.loc_added).toBe(0);
    expect(row?.loc_removed).toBe(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-3: window has commits but none authored by user.email
  // ──────────────────────────────────────────────────────────

  it('TC-U-17: 2 commits in-window by other@example.com, session user me@example.com → commit_count=0, status=evaluated', () => {
    repo = setupTestRepo('foreign-author');
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0 - 30_000,
      { 'a.txt': 'a' },
      'commit by other 1',
      'other@example.com',
    );
    commitAtMs(
      repo,
      t0,
      { 'b.txt': 'b' },
      'commit by other 2',
      'other@example.com',
    );

    const session: EvaluatorSession = {
      id: 'sess-foreign',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(0);
    expect(row?.loc_added).toBe(0);
    expect(row?.loc_removed).toBe(0);
    expect(row?.last_evaluated_at).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-1: happy path
  // ──────────────────────────────────────────────────────────

  it('TC-U-18: 2 commits in-window by me — totals across files', () => {
    repo = setupTestRepo('happy-totals');
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;

    // Initial empty commit so both target commits have parents (and we get
    // proper added/removed numbers — initial-commit fallback is covered
    // separately in TC-U-19).
    seedCommit(repo);

    // Commit 1: 60 added, 10 removed across 3 files (file 'x.txt' gets +60,
    // 'y.txt' gets +0/-10 by being removed). Easier to just produce 5 files
    // total summing to 100/20 across 2 commits.
    commitAtMs(
      repo,
      t0 - 30_000,
      {
        'a.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n31\n32\n33\n34\n35\n36\n37\n38\n39\n40\n41\n42\n43\n44\n45\n46\n47\n48\n49\n50\n51\n52\n53\n54\n55\n56\n57\n58\n59\n60\n',
        'b.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n',
        'c.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n',
      },
      'commit 1: +90 across 3 files',
    );

    // Commit 2: shrink b.txt to 0 lines (-20), grow d.txt by 10 lines (+10),
    // add e.txt with 0 lines... we need final tally = added 100 / removed 20.
    // Numbers from commit 1: +60 + +20 + +10 = +90 added, removed=0, files=3.
    // Needed additional: +10 added, +20 removed, +2 files.
    commitAtMs(
      repo,
      t0,
      {
        'b.txt': '', // wipe (-20 lines)
        'd.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', // +10 lines
        'e.txt': '', // 0/0 but counts as +1 file
      },
      'commit 2: -20 / +10 across 3 files (b counts again)',
    );

    // Session 1 commit:  files = {a, b, c} = 3
    // Session 2 commit:  files = {b, d, e} = 3
    // Union: {a, b, c, d, e} = 5
    const session: EvaluatorSession = {
      id: 'sess-happy',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(2);
    expect(row?.loc_added).toBe(100);
    expect(row?.loc_removed).toBe(20);
    expect(row?.files_changed).toBe(5);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-6: empty-tree fallback for initial commit
  // ──────────────────────────────────────────────────────────

  it('TC-U-19: session whose only commit is the initial commit (no parent) → uses empty-tree fallback', () => {
    repo = setupTestRepo('initial-commit');
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0,
      { 'a.txt': 'one\ntwo\nthree\n' },
      'initial commit (will be parentless)',
    );

    const session: EvaluatorSession = {
      id: 'sess-initial',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(1);
    // 3 lines added in the only commit; empty-tree fallback should produce
    // nonzero loc_added (NOT 0).
    expect(row?.loc_added).toBeGreaterThan(0);
    expect(row?.files_changed).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-1: ms-precision boundaries
  // ──────────────────────────────────────────────────────────

  it('TC-U-20: commit at exactly session.started_at is included (boundary inclusive)', () => {
    repo = setupTestRepo('boundary-start');
    seedCommit(repo);
    const startedAt = Math.floor(Date.now() / 1000) * 1000; // align to second
    const endedAt = startedAt + 60_000;
    commitAtMs(
      repo,
      startedAt,
      { 'a.txt': 'a' },
      'commit at startedAt boundary',
    );

    const session: EvaluatorSession = {
      id: 'sess-boundary-start',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(1);
  });

  it('TC-U-21: commit at exactly session.ended_at is included (boundary inclusive)', () => {
    repo = setupTestRepo('boundary-end');
    seedCommit(repo);
    const endedAt = Math.floor(Date.now() / 1000) * 1000; // align to second
    const startedAt = endedAt - 60_000;
    commitAtMs(
      repo,
      endedAt,
      { 'a.txt': 'a' },
      'commit at endedAt boundary',
    );

    const session: EvaluatorSession = {
      id: 'sess-boundary-end',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.commit_count).toBe(1);
  });

  it('TC-U-22: commit at session.ended_at + 1ms excluded', () => {
    repo = setupTestRepo('boundary-after');
    seedCommit(repo);
    // Both started_at and ended_at end in 0; the commit timestamp is 1ms past
    // ended_at. Since git only honors second-precision, we use a commit
    // committed 1 second past ended_at and a session window where ended_at
    // is exactly mid-second so the JS filter rejects ct*1000 > ended_at.
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const startedAt = t0 - 60_000;
    // ended_at is *just under* the next second so a commit AT that next
    // second (ct = t0/1000 + 1) is t0+1000ms which is > ended_at.
    const endedAt = t0 + 999; // milliseconds: ends at ...999ms
    commitAtMs(
      repo,
      t0 + 1000,
      { 'a.txt': 'a' },
      'commit 1s after window',
    );

    const session: EvaluatorSession = {
      id: 'sess-boundary-after',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.commit_count).toBe(0);
  });

  it('TC-U-23: commit at session.started_at - 1ms excluded', () => {
    repo = setupTestRepo('boundary-before');
    seedCommit(repo);
    // Commit timestamp ct = t0/1000 - 1 (one second before window).
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const startedAt = t0 + 1; // 1ms past second boundary
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0 - 1000,
      { 'a.txt': 'a' },
      'commit 1s before window',
    );

    const session: EvaluatorSession = {
      id: 'sess-boundary-before',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.commit_count).toBe(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-7: reverts within 7d
  // ──────────────────────────────────────────────────────────

  it('TC-U-24: 1 session-commit and 1 follow-up Revert <short-sha> within 7d → reverts_within_7d=1', () => {
    repo = setupTestRepo('reverts-within-7d');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    const sessionSha = commitAtMs(
      repo,
      t0,
      { 'a.txt': 'a' },
      'session commit',
    );
    const shortSha = sessionSha.slice(0, 7);

    // Revert at t0 + 3 days. Use a totally separate file modification so the
    // commit itself contains a diff (avoids --allow-empty pathway).
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    commitAtMs(
      repo,
      t0 + threeDaysMs,
      { 'a.txt': '' },
      `Revert ${shortSha} manually`,
    );

    const session: EvaluatorSession = {
      id: 'sess-reverts-1',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.commit_count).toBe(1);
    expect(row?.reverts_within_7d).toBe(1);
  });

  it('TC-U-25: revert-commit at commit_at + 8d (outside 7d window) → reverts_within_7d=0', () => {
    repo = setupTestRepo('reverts-outside-7d');
    seedCommit(repo);
    const t0 = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d ago for room
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    const sessionSha = commitAtMs(
      repo,
      t0,
      { 'a.txt': 'a' },
      'session commit',
    );
    const shortSha = sessionSha.slice(0, 7);
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    commitAtMs(
      repo,
      t0 + eightDaysMs,
      { 'a.txt': '' },
      `Revert ${shortSha} manually`,
    );

    const session: EvaluatorSession = {
      id: 'sess-reverts-0',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.commit_count).toBe(1);
    expect(row?.reverts_within_7d).toBe(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-18: malformed numstat → non-fatal, commit_count preserved
  // ──────────────────────────────────────────────────────────

  it('TC-U-26: malformed numstat → loc_added=0, loc_removed=0, but commit_count preserved', () => {
    // We can't easily make real git emit malformed numstat. The cleanest path
    // is a unit-style injection: stub `runGit` with a fixture that returns
    // garbage when the command starts with `['diff', '--numstat', ...]`.
    repo = setupTestRepo('numstat-parse-fail');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0,
      { 'a.txt': 'a\nb\n' },
      'good commit',
    );

    const session: EvaluatorSession = {
      id: 'sess-parse-fail',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    // Use the optional `runGitImpl` injection to override only the diff calls.
    // Forward to the real runGit for non-diff commands; emit malformed
    // numstat for diff commands.
    const stubbedRunGit: typeof runGit = (args, opts) => {
      const isNumstatDiff =
        args[0] === 'diff' && args.includes('--numstat');
      if (isNumstatDiff) {
        return { ok: true, value: 'garbage line\n' };
      }
      return runGit(args, opts);
    };

    evaluateSessionOutcome(db, session, { runGitImpl: stubbedRunGit });

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(1); // preserved
    expect(row?.loc_added).toBe(0); // parse failure → 0
    expect(row?.loc_removed).toBe(0);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-5: per-commit-summed (regression test for range-diff bug)
  // ──────────────────────────────────────────────────────────

  it('TC-U-27: per-commit-sum NOT range-diff — 3 commits A(+10), B(+50 by other), C(+5) → me only = 15', () => {
    repo = setupTestRepo('per-commit-sum');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;

    // Commit A: by me, +10 lines via 'a.txt'
    commitAtMs(
      repo,
      t0 - 30_000,
      { 'a.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n' },
      'A: +10 by me',
    );

    // Commit B: by other, +50 lines via 'b.txt'
    commitAtMs(
      repo,
      t0 - 15_000,
      {
        'b.txt': Array.from({ length: 50 }, (_v, i) => `${i + 1}`).join('\n') + '\n',
      },
      'B: +50 by other',
      'other@example.com',
    );

    // Commit C: by me, +5 lines via 'c.txt'
    commitAtMs(
      repo,
      t0,
      { 'c.txt': '1\n2\n3\n4\n5\n' },
      'C: +5 by me',
    );

    const session: EvaluatorSession = {
      id: 'sess-per-commit-sum',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(2);
    // Critical regression assertion: 15, NOT 65 (which would mean range-diffed).
    expect(row?.loc_added).toBe(15);
  });

  // ──────────────────────────────────────────────────────────
  // REQ-1: plus-addressing exact match (NOT regex)
  // ──────────────────────────────────────────────────────────

  it('TC-U-28: plus-tagged user.email — commit by me@gmail.com NOT attributed; commit by me+tag@gmail.com IS', () => {
    repo = setupTestRepo('plus-addressing');
    // Set local user.email to the plus-tagged address (this becomes the
    // "session user" identity from the evaluator's perspective).
    spawnSync(
      'git',
      ['config', '--local', 'user.email', 'me+tag@gmail.com'],
      { cwd: repo.path, shell: false },
    );

    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;

    // Commit by 'me@gmail.com' — should NOT match (regex would; exact-match doesn't)
    commitAtMs(
      repo,
      t0 - 30_000,
      { 'untagged.txt': '1\n2\n' },
      'untagged author',
      'me@gmail.com',
    );
    // Commit by exact 'me+tag@gmail.com' — SHOULD match
    commitAtMs(
      repo,
      t0,
      { 'tagged.txt': '1\n2\n3\n' },
      'tagged author',
      'me+tag@gmail.com',
    );

    const session: EvaluatorSession = {
      id: 'sess-plus-tag',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(1);
    expect(row?.loc_added).toBe(3);
  });

  // ──────────────────────────────────────────────────────────
  // TC-I-01: idempotent UPSERT
  // ──────────────────────────────────────────────────────────

  it('TC-I-01: run twice — first inserts, second UPSERTs and only last_evaluated_at changes', () => {
    repo = setupTestRepo('idempotent-1');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0,
      { 'a.txt': '1\n2\n3\n' },
      'session commit',
    );

    const session: EvaluatorSession = {
      id: 'sess-idem-1',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);
    const first = readOutcome(db, session.id);
    expect(first).toBeDefined();
    expect(first?.commit_count).toBe(1);

    // Force last_evaluated_at to bump on the next run.
    const sleepUntilNextMs = (): void => {
      const start = Date.now();
      while (Date.now() === start) {
        /* spin */
      }
    };
    sleepUntilNextMs();

    evaluateSessionOutcome(db, session);
    const second = readOutcome(db, session.id);
    expect(second?.commit_count).toBe(first?.commit_count);
    expect(second?.loc_added).toBe(first?.loc_added);
    expect(second?.loc_removed).toBe(first?.loc_removed);
    expect(second?.files_changed).toBe(first?.files_changed);
    expect(second?.reverts_within_7d).toBe(first?.reverts_within_7d);
    expect(second?.status).toBe(first?.status);
    expect(second?.last_evaluated_at).toBeGreaterThan(first?.last_evaluated_at ?? 0);
  });

  // ──────────────────────────────────────────────────────────
  // TC-I-02: re-run after new commit reflects change
  // ──────────────────────────────────────────────────────────

  it('TC-I-02: re-run after new commit reflects change; last_evaluated_at advanced', () => {
    repo = setupTestRepo('idempotent-2');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 90_000;
    commitAtMs(
      repo,
      t0,
      { 'a.txt': '1\n' },
      'first session commit',
    );

    const session: EvaluatorSession = {
      id: 'sess-idem-2',
      cwd: repo.path,
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);
    const first = readOutcome(db, session.id);
    expect(first?.commit_count).toBe(1);

    const sleepUntilNextMs = (): void => {
      const start = Date.now();
      while (Date.now() === start) {
        /* spin */
      }
    };
    sleepUntilNextMs();

    // Add another commit in the same window
    commitAtMs(
      repo,
      t0 + 30_000,
      { 'b.txt': '1\n2\n' },
      'second session commit',
    );

    evaluateSessionOutcome(db, session);
    const second = readOutcome(db, session.id);
    expect(second?.commit_count).toBe(2);
    expect((second?.loc_added ?? 0)).toBeGreaterThan(first?.loc_added ?? 0);
    expect(second?.last_evaluated_at).toBeGreaterThan(first?.last_evaluated_at ?? 0);
  });

  // ──────────────────────────────────────────────────────────
  // TC-I-15: cwd-missing persists status='cwd-missing' on the row
  // ──────────────────────────────────────────────────────────

  it('TC-I-15: cwd-missing session → DB row has status="cwd-missing"', () => {
    const fakeCwd = path.join(
      os.homedir(),
      `tokenfx-cwd-missing-i15-${Date.now()}`,
    );
    const session: EvaluatorSession = {
      id: 'sess-i15',
      cwd: fakeCwd,
      started_at: 1_000_000,
      ended_at: 2_000_000,
    };
    insertSession(db, session);

    evaluateSessionOutcome(db, session);

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('cwd-missing');
  });

  // ──────────────────────────────────────────────────────────
  // TC-I-16: symlink cwd resolves via fs.realpath; evaluation proceeds
  // ──────────────────────────────────────────────────────────

  it('TC-I-16: cwd is a symlink to a valid git repo → treated as valid; evaluation proceeds', () => {
    repo = setupTestRepo('symlink-cwd');
    seedCommit(repo);
    const t0 = Date.now();
    const startedAt = t0 - 60_000;
    const endedAt = t0 + 60_000;
    commitAtMs(
      repo,
      t0,
      { 'a.txt': '1\n' },
      'commit via symlink path',
    );

    // Create a sibling symlink to the repo.
    const linkPath = path.join(
      os.tmpdir(),
      `tokenfx-evaluator-symlink-${Date.now()}`,
    );
    fs.symlinkSync(repo.path, linkPath);

    const session: EvaluatorSession = {
      id: 'sess-symlink',
      cwd: linkPath, // pass the symlink, not the realpath
      started_at: startedAt,
      ended_at: endedAt,
    };
    insertSession(db, session);

    try {
      evaluateSessionOutcome(db, session);
    } finally {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // ignore
      }
    }

    const row = readOutcome(db, session.id);
    expect(row?.status).toBe('evaluated');
    expect(row?.commit_count).toBe(1);
  });

  // Sanity: TEST_USER_EMAIL is what the helper writes locally — referenced
  // here so unused-import lint doesn't bark on the export.
  it('uses TEST_USER_EMAIL helper export', () => {
    expect(TEST_USER_EMAIL).toContain('@');
  });

  // ──────────────────────────────────────────────────────────
  // v2-pr-lookup TCs (TC-I-11..26 from
  // `.specs/outcome-integration-git-v2-pr-lookup.md`).
  // ──────────────────────────────────────────────────────────

  /**
   * Configure a GitHub remote in a test repo so `resolveGitHubRepo` finds
   * something. We use `git remote add origin <url>` via spawnSync. Without
   * this, TC-I-13 (no GitHub remote) is the path that fires by default.
   */
  const addGithubRemote = (cwd: string): void => {
    const result = spawnSync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:foo/bar.git'],
      { cwd, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `git remote add failed in ${cwd}: ${result.stderr ?? ''}`,
      );
    }
  };

  /**
   * Build a `lookupPrCountImpl` stub whose answer is keyed by SHA. Tests
   * pass a SHA → status+prNumbers map; if a SHA isn't in the map the stub
   * throws (test bug — every commit must have a planned answer).
   */
  type StubResponse = {
    status: 'ok' | 'rate-limited' | 'unauthorized' | 'not-found' | 'error';
    prNumbers: readonly number[];
  };
  const makeLookupStub = (
    plan: ReadonlyArray<StubResponse>,
  ): {
    impl: NonNullable<Parameters<typeof evaluateSessionOutcome>[2]>['lookupPrCountImpl'];
    callCount: () => number;
    seenShas: () => readonly string[];
  } => {
    let idx = 0;
    const seen: string[] = [];
    const impl: NonNullable<
      Parameters<typeof evaluateSessionOutcome>[2]
    >['lookupPrCountImpl'] = (input) => {
      seen.push(input.sha);
      if (idx >= plan.length) {
        throw new Error(
          `lookup stub exhausted: got ${seen.length} calls, plan has ${plan.length}`,
        );
      }
      const next = plan[idx];
      idx += 1;
      return { ok: true, value: next };
    };
    return {
      impl,
      callCount: () => seen.length,
      seenShas: () => seen,
    };
  };

  const setupSessionWithCommits = (
    n: number,
  ): { session: EvaluatorSession; r: TestRepo } => {
    const r = setupTestRepo('pr-lookup');
    repo = r;
    const t0 = Date.now() - 3_600_000;
    seedCommit(r);
    for (let i = 0; i < n; i += 1) {
      r.commit({
        message: `commit-${i}`,
        files: { [`file-${i}.txt`]: `content-${i}\n` },
        date: Math.floor((t0 + i * 60_000) / 1000),
        authorEmail: TEST_USER_EMAIL,
      });
    }
    const session: EvaluatorSession = {
      id: `pr-session-${Date.now()}`,
      cwd: r.path,
      started_at: t0 - 30_000,
      ended_at: t0 + n * 60_000 + 30_000,
    };
    insertSession(db, session);
    return { session, r };
  };

  // TC-I-11: anti-regression — flag UNSET → mergedPrCount stays NULL,
  // lookup never invoked.
  it('TC-I-11: TOKENFX_GH_PR_LOOKUP unset → merged_pr_count = NULL, lookup not called', () => {
    delete process.env.TOKENFX_GH_PR_LOOKUP;
    const { session } = setupSessionWithCommits(2);
    const stub = makeLookupStub([]);
    evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
    expect(stub.callCount()).toBe(0);
    expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
  });

  // TC-I-12: env value is `'0'` (literal string, NOT '1') → flag OFF.
  it('TC-I-12: TOKENFX_GH_PR_LOOKUP=0 → flag OFF, lookup not called', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '0';
    try {
      const { session } = setupSessionWithCommits(2);
      const stub = makeLookupStub([]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(0);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-13: flag on but no GitHub remote → mergedPrCount = NULL,
  // lookup not called (resolveGitHubRepo short-circuits) AND a single
  // info log with reason='no-github-remote' is emitted (REQ-13).
  it('flag on + no GitHub remote → merged_pr_count = NULL, lookup not called, logs no-github-remote', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    const logSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      const { session, r } = setupSessionWithCommits(2);
      // No remote configured — the helper repo from setupTestRepo() has no
      // origin remote.
      void r;
      const stub = makeLookupStub([]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(0);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();

      const noRemoteCalls = logSpy.mock.calls.filter((call) => {
        const ctx = call[1];
        return (
          typeof ctx === 'object' &&
          ctx !== null &&
          (ctx as Record<string, unknown>).reason === 'no-github-remote'
        );
      });
      expect(noRemoteCalls.length).toBe(1);
    } finally {
      logSpy.mockRestore();
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-14: flag on, GitHub remote, 5 commits with 2 unique PRs across
  // them — dedup via Set yields merged_pr_count = 2.
  it('TC-I-14: dedup PR numbers across commits', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(5);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'ok', prNumbers: [] },
        { status: 'not-found', prNumbers: [] },
        { status: 'ok', prNumbers: [42, 99] },
        { status: 'ok', prNumbers: [99] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(5);
      // Lock the iteration order: every commit was visited exactly once.
      // Set comparison guards against a future change in commit ordering
      // that would shift plan-to-SHA attribution while still deduping to 2.
      expect(new Set(stub.seenShas()).size).toBe(5);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(2);
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-15: any rate-limited → discard partial → NULL.
  // callCount=3 pins the full-iteration contract: anyFailure must NOT
  // short-circuit the loop (otherwise a future early-break optimization
  // silently passes).
  it('rate-limited mid-session → merged_pr_count = NULL (full iteration)', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'rate-limited', prNumbers: [] },
        { status: 'ok', prNumbers: [99] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-16: any unauthorized → NULL.
  it('unauthorized mid-session → merged_pr_count = NULL (full iteration)', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'unauthorized', prNumbers: [] },
        { status: 'ok', prNumbers: [99] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-17: any error → NULL.
  it('error mid-session → merged_pr_count = NULL (full iteration)', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'error', prNumbers: [] },
        { status: 'ok', prNumbers: [99] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-18: ok + not-found mix (no failures) → success contributes;
  // not-found contributes empty. Set is { 42 } → merged_pr_count = 1.
  it('ok + not-found mix → not-found is success', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'not-found', prNumbers: [] },
        { status: 'not-found', prNumbers: [] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(3);
      expect(new Set(stub.seenShas()).size).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(1);
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-19: zero session-commits + flag on → no lookups, NULL.
  it('TC-I-19: zero commits + flag on → merged_pr_count = NULL, lookup not called', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const r = setupTestRepo('pr-lookup');
      repo = r;
      addGithubRemote(r.path);
      seedCommit(r);
      const session: EvaluatorSession = {
        id: `empty-session-${Date.now()}`,
        cwd: r.path,
        // Window outside any commits — enumerate yields []
        started_at: 0,
        ended_at: 1000,
      };
      insertSession(db, session);
      const stub = makeLookupStub([]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(stub.callCount()).toBe(0);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-20: UPSERT idempotency — re-runs flip merged_pr_count
  // (NULL → 2 → 3) without duplicating rows. Confirms the ON CONFLICT
  // SET clause was extended to include the new column (REQ-16).
  it('TC-I-20: UPSERT round-trips merged_pr_count NULL → 2 → 3', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(2);
      addGithubRemote(r.path);

      // First run: flag OFF (override) → NULL.
      delete process.env.TOKENFX_GH_PR_LOOKUP;
      evaluateSessionOutcome(db, session, {
        lookupPrCountImpl: makeLookupStub([]).impl,
      });
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();

      // Second run: flag ON, 2 PRs.
      process.env.TOKENFX_GH_PR_LOOKUP = '1';
      evaluateSessionOutcome(db, session, {
        lookupPrCountImpl: makeLookupStub([
          { status: 'ok', prNumbers: [10] },
          { status: 'ok', prNumbers: [20] },
        ]).impl,
      });
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(2);

      // Third run: flag ON, 3 PRs.
      evaluateSessionOutcome(db, session, {
        lookupPrCountImpl: makeLookupStub([
          { status: 'ok', prNumbers: [10, 20] },
          { status: 'ok', prNumbers: [30] },
        ]).impl,
      });
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(3);

      // Row count must remain 1 (UPSERT, not INSERT).
      const rows = db
        .prepare('SELECT COUNT(*) AS n FROM session_outcomes WHERE session_id = ?')
        .get(session.id) as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-24: TWO different failure statuses + 1 ok → NULL.
  it('TC-I-24: rate-limited + unauthorized + ok → merged_pr_count = NULL', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'ok', prNumbers: [42] },
        { status: 'rate-limited', prNumbers: [] },
        { status: 'unauthorized', prNumbers: [] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-25: ALL not-found → success path, set is {} → 0.
  it('TC-I-25: all not-found → merged_pr_count = 0', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(2);
      addGithubRemote(r.path);
      const stub = makeLookupStub([
        { status: 'not-found', prNumbers: [] },
        { status: 'not-found', prNumbers: [] },
      ]);
      evaluateSessionOutcome(db, session, { lookupPrCountImpl: stub.impl });
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(0);
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-26: flag toggle re-evaluation — flag-OFF run AFTER a flag-ON
  // run that wrote 2 must overwrite to NULL (do-not-evaluate semantics).
  it('TC-I-26: flag toggle off → merged_pr_count overwrites to NULL', () => {
    const { session, r } = setupSessionWithCommits(2);
    addGithubRemote(r.path);

    // First run: flag ON, 2 PRs.
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      evaluateSessionOutcome(db, session, {
        lookupPrCountImpl: makeLookupStub([
          { status: 'ok', prNumbers: [10] },
          { status: 'ok', prNumbers: [20] },
        ]).impl,
      });
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
    expect(readOutcome(db, session.id)?.merged_pr_count).toBe(2);

    // Second run: flag UNSET → overwrites to NULL.
    evaluateSessionOutcome(db, session, {
      lookupPrCountImpl: makeLookupStub([]).impl,
    });
    expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
  });

  // TC-U-21..25 (v2 spec): strict env-flag boundary check — only the
  // literal string '1' enables the lookup. Common false-positives must
  // be rejected to avoid silently turning the feature on.
  // (Different namespace from the parent spec's TC-U-21..25 commit-time
  // boundaries; spec test names are natural English so the IDs only
  // appear in this comment.)
  it.each([
    ['true'],
    ['1 '],
    [' 1'],
    ['yes'],
    ['TRUE'],
  ])(
    'TOKENFX_GH_PR_LOOKUP=%j → flag OFF (only literal "1" enables lookup)',
    (flagValue) => {
      process.env.TOKENFX_GH_PR_LOOKUP = flagValue;
      try {
        const { session, r } = setupSessionWithCommits(2);
        addGithubRemote(r.path);
        const stub = makeLookupStub([]);
        evaluateSessionOutcome(db, session, {
          lookupPrCountImpl: stub.impl,
        });
        expect(stub.callCount()).toBe(0);
        expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
      } finally {
        delete process.env.TOKENFX_GH_PR_LOOKUP;
      }
    },
  );

  // ---- v3 422-as-not-found integration TCs ------------------------------
  // These TCs wire stubs at the `runImpl` level (NOT at lookupPrCountImpl)
  // so the classifier's new arm actually fires from real-shape gh stderr.
  // We compose lookupMergedPrCount with a fake runImpl that emits the
  // canonical 422 stderr; downstream feeds into evaluator's anyFailure
  // accumulator just like real gh would.
  // See .specs/outcome-integration-git-v3-422-as-not-found.md.

  /**
   * Build a `lookupPrCountImpl` that wraps the production
   * `lookupMergedPrCount` with a fake `runImpl`. The runImpl emits the
   * supplied `PrRunResult` fixtures in iteration-call order (one per
   * commit visited by computeMergedPrCount). Tests asserting the v3
   * classifier path use this so the stderr/exit-code shape actually
   * flows through `classifyGhResult` end-to-end.
   *
   * Returned object exposes a `callCount()` for tests to assert exact
   * fixture consumption (guards against silent under-consumption if
   * computeMergedPrCount enumerates fewer commits than expected).
   */
  const makeRunImplLookup = (
    fixtures: ReadonlyArray<RunFixture>,
  ): {
    impl: NonNullable<
      Parameters<typeof evaluateSessionOutcome>[2]
    >['lookupPrCountImpl'];
    callCount: () => number;
  } => {
    let idx = 0;
    const impl: NonNullable<
      Parameters<typeof evaluateSessionOutcome>[2]
    >['lookupPrCountImpl'] = (input) => {
      const next = fixtures[idx];
      if (next === undefined) {
        throw new Error(
          `runImpl fixture exhausted: got ${idx + 1} calls, plan has ${fixtures.length}`,
        );
      }
      idx += 1;
      const fixture = typeof next === 'function' ? next(input.sha) : next;
      // Fresh per-call options so cache/rate-limit state doesn't leak —
      // each commit must independently flow through classifyGhResult.
      return lookupMergedPrCount(input, {
        runImpl: () => fixture,
        shaCache: new Map(),
        rateLimitRef: { limitedUntil: null },
        nowMs: () => 1_700_000_000_000,
        loggedReasons: new Set(),
      });
    };
    return { impl, callCount: () => idx };
  };

  // TC-I-01 (v3): mix of real-422 stderr + ok JSON via runImpl. The
  // 422-bearing commit (which previously produced 'error' → NULL collapse)
  // must now classify as 'not-found' and contribute empty prNumbers; the
  // session's merged_pr_count reflects ONLY the ok-result PR numbers.
  it('runImpl-level: mixed real-422-stderr + ok JSON → merged_pr_count from ok results only', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);

      const lookup = makeRunImplLookup([
        // First commit: real gh 422 stderr (local-only commit not pushed)
        (sha): PrRunResult => ({
          stdout: '',
          stderr: `gh: No commit found for SHA: ${sha} (HTTP 422)\n`,
          status: 1,
          signal: null,
        }),
        // Second commit: ok JSON with PR 42
        {
          stdout: '[42]',
          stderr: '',
          status: 0,
          signal: null,
        },
        // Third commit: ok JSON with PR 99
        {
          stdout: '[99]',
          stderr: '',
          status: 0,
          signal: null,
        },
      ]);

      evaluateSessionOutcome(db, session, { lookupPrCountImpl: lookup.impl });
      // Pre-fix this would be NULL (anyFailure due to 'error' classification).
      // Post-fix: 422 → 'not-found' → empty contribution; Set is {42, 99} → 2.
      expect(lookup.callCount()).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBe(2);
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // TC-I-02 (v3): rate-limited still dominates failure mode at integration
  // level after the new classifier arm is in place. Confirms anyFailure
  // accumulator propagates correctly.
  it('runImpl-level: rate-limited + 422-not-found + ok mix → merged_pr_count = NULL (rate-limit dominates)', () => {
    process.env.TOKENFX_GH_PR_LOOKUP = '1';
    try {
      const { session, r } = setupSessionWithCommits(3);
      addGithubRemote(r.path);

      const lookup = makeRunImplLookup([
        (sha): PrRunResult => ({
          stdout: '',
          stderr: `gh: No commit found for SHA: ${sha} (HTTP 422)\n`,
          status: 1,
          signal: null,
        }),
        {
          stdout: '',
          stderr: 'API rate limit exceeded.\n',
          status: 1,
          signal: null,
        },
        {
          stdout: '[7]',
          stderr: '',
          status: 0,
          signal: null,
        },
      ]);

      evaluateSessionOutcome(db, session, { lookupPrCountImpl: lookup.impl });
      // rate-limited → anyFailure → NULL collapse (REQ-2 + REQ-15 from v2).
      expect(lookup.callCount()).toBe(3);
      expect(readOutcome(db, session.id)?.merged_pr_count).toBeNull();
    } finally {
      delete process.env.TOKENFX_GH_PR_LOOKUP;
    }
  });

  // ---- WeakMap UPSERT cache TCs (refactor-prepared-statements-evaluator) ----
  // Hand-written counting wrapper (no vi.spyOn / no mocking framework per
  // project rule). Wrapper installed AFTER setupTestRepo + migrate + any
  // session insert, so migration-time prepare calls aren't counted; filter
  // narrows to /INSERT INTO session_outcomes/i so only the UPSERT prepare
  // contributes. See .specs/refactor-prepared-statements-evaluator.md.

  /** Patch `db.prepare` to count UPSERT prepares only. Returns a getter for the count. */
  const installPrepareCounter = (target: DB): { count: () => number } => {
    let upsertPrepareCount = 0;
    const originalPrepare = target.prepare.bind(target);
    // Cast to `typeof target.prepare`: better-sqlite3's prepare is a generic
    // overload (`<T>(sql) => Statement<T>`) which can't be expressed by a
    // single non-generic wrapper lambda. The wrapper delegates unchanged to
    // originalPrepare, so the runtime contract is preserved.
    target.prepare = ((sql: string) => {
      if (/INSERT INTO session_outcomes/i.test(sql)) {
        upsertPrepareCount += 1;
      }
      return originalPrepare(sql);
    }) as typeof target.prepare;
    return { count: () => upsertPrepareCount };
  };

  // TC-U-01: 50 calls on the same DB → exactly 1 UPSERT prepare (cache-miss
  // on first call; cache-hit on calls 2-50). Both branches of the
  // `if (stmt === undefined)` guard exercised in a single TC.
  it('upsert prepare cached: 50 evaluateSessionOutcome calls → 1 db.prepare(INSERT INTO session_outcomes)', () => {
    const r = setupTestRepo('upsert-prepare-cache');
    repo = r;
    seedCommit(r);
    // Single seeded session reused across 50 invocations — keeps the test
    // self-contained (no need to grow the repo or fixtures per call).
    const now = Date.now();
    const session: EvaluatorSession = {
      id: 'sess-upsert-cache-01',
      cwd: r.path,
      started_at: now - 60_000,
      ended_at: now,
    };
    insertSession(db, session);

    const counter = installPrepareCounter(db);
    for (let i = 0; i < 50; i += 1) {
      evaluateSessionOutcome(db, session);
    }
    expect(counter.count()).toBe(1);
  });

  // TC-U-02: 2 distinct DBs, 1 call each → 2 prepares total (one per DB).
  // Confirms each DB instance is keyed independently in the WeakMap.
  it('upsert prepare cached per-DB: two DBs → two distinct cache entries', () => {
    const dbA = openDatabase(':memory:');
    const dbB = openDatabase(':memory:');
    // Local repo (not the outer `repo`) so afterEach's repo.cleanup() still
    // targets only what TC-U-01 created; this TC owns its lifecycle.
    const localRepo = setupTestRepo('upsert-prepare-2db');
    try {
      migrate(dbA);
      migrate(dbB);
      seedCommit(localRepo);

      const now = Date.now();
      const sessionA: EvaluatorSession = {
        id: 'sess-2db-A',
        cwd: localRepo.path,
        started_at: now - 60_000,
        ended_at: now,
      };
      const sessionB: EvaluatorSession = {
        id: 'sess-2db-B',
        cwd: localRepo.path,
        started_at: now - 60_000,
        ended_at: now,
      };
      insertSession(dbA, sessionA);
      insertSession(dbB, sessionB);

      const counterA = installPrepareCounter(dbA);
      const counterB = installPrepareCounter(dbB);
      evaluateSessionOutcome(dbA, sessionA);
      evaluateSessionOutcome(dbB, sessionB);

      expect(counterA.count()).toBe(1);
      expect(counterB.count()).toBe(1);
      expect(counterA.count() + counterB.count()).toBe(2);
    } finally {
      dbA.close();
      dbB.close();
      localRepo.cleanup();
    }
  });

  // TC-U-03: REQ-3 + REQ-4 — module-export shape assertion. The cache and
  // helper are module-private. WeakMap-vs-Map is enforced by the source
  // file's type annotation (compile-time check via pnpm typecheck).
  it('module export shape: cache helper and WeakMap are private to evaluator.ts', async () => {
    const evaluatorMod = await import('./evaluator');
    const exportedKeys = Object.keys(evaluatorMod);
    expect(exportedKeys).not.toContain('getUpsertOutcomeStmt');
    expect(exportedKeys).not.toContain('upsertOutcomeStmtCache');
    // Public surface from existing v2 + v3 specs is unchanged.
    expect(exportedKeys).toContain('evaluateSessionOutcome');
  });
});
