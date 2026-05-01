import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { runReporter } from './runner';
import { readConfig, type ReporterConfig } from './config';
import type { SignedEnvelope } from './client';
import { canonicalJSON } from './signer';
import { createHash } from 'node:crypto';

// ---------- Fixtures ----------

const SAMPLE_CONFIG: ReporterConfig = {
  key_id: 'key-test-1',
  secret: 'shhh-machine-secret',
  machine_id: '11111111-1111-4111-8111-111111111111',
  user_email: 'alice@example.com',
  central_url: 'https://central.test',
  project_secret: 'project-secret-abc',
};

const SCHEMA_PATH = path.resolve(__dirname, '../db/schema.sql');

const writeConfig = (dir: string, cfg: Partial<ReporterConfig> = {}): string => {
  const file = path.join(dir, 'reporter-config.json');
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE_CONFIG, ...cfg }, null, 2));
  fs.chmodSync(file, 0o600);
  return file;
};

const tmpDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-runner-'));

/**
 * Open an in-memory SQLite DB and run migrations against it. Returns a
 * function that seeds N sessions (each with 1 turn, 1 tool_call, 1 rating).
 */
const openSeededDb = (): {
  db: DatabaseType;
  seed: (count: number, baseTime?: number) => string[];
} => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  // Migrate via schema.sql replay (avoids the reconcile-all path which
  // doesn't matter for an empty DB).
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);

  const insertSession = db.prepare(
    `INSERT INTO sessions (
       id, slug, cwd, project, git_branch, cc_version,
       started_at, ended_at,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, total_cost_usd_otel,
       turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (
       id, session_id, parent_uuid, sequence, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json,
       subagent_type
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
     VALUES (?,?,?,?,?,?)`,
  );
  const insertRating = db.prepare(
    `INSERT INTO ratings (turn_id, rating, note, rated_at) VALUES (?,?,?,?)`,
  );

  const seed = (count: number, baseTime = 1_700_000_000_000): string[] => {
    const ids: string[] = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const id = `sess-${i}`;
        const turnId = `turn-${i}`;
        insertSession.run(
          id,
          null,
          '/Users/alice/work/tokenfx',
          '-Users-alice-work-tokenfx',
          'main',
          '1.2.3',
          baseTime + i * 1000,
          baseTime + i * 1000 + 500,
          1000,
          500,
          200,
          100,
          0.05,
          0.045,
          1,
          1,
          '/tmp/x.jsonl',
          baseTime + i * 1000 + 600,
        );
        insertTurn.run(
          turnId,
          id,
          null,
          1,
          baseTime + i * 1000 + 100,
          'claude-sonnet-4',
          800,
          400,
          100,
          50,
          0.04,
          'end_turn',
          null, // user_prompt — must NEVER appear in payload
          null, // assistant_text — must NEVER appear in payload
          '[]',
          null,
        );
        insertToolCall.run(`tc-${i}`, turnId, 'Edit', '{}', null, 0);
        insertRating.run(turnId, 1, 'looks fine', baseTime + i * 1000 + 700);
        ids.push(id);
      }
    });
    tx();
    return ids;
  };

  return { db, seed };
};

// ---------- Stub fetch ----------

type FetchCall = { url: string; init: RequestInit };

const makeFetchStub = (
  responder: (call: FetchCall) => Response,
): { fn: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fn = (async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const okResponse = (
  body: { accepted: number; skipped: number; rejected: number; errors: ReadonlyArray<{ session_id: string; reason: string }> },
): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// ---------- Tests ----------

describe('reporter runner', () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    workDir = tmpDir();
    originalCwd = process.cwd();
    process.chdir(workDir);
    fs.mkdirSync(path.join(workDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('REQ-11 config gate', () => {
    it('returns zero stats and does NOT call fetch when config absent', async () => {
      const { fn: fetchFn, calls } = makeFetchStub(() =>
        okResponse({ accepted: 0, skipped: 0, rejected: 0, errors: [] }),
      );
      const result = await runReporter({
        dbPath: ':memory:',
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: path.join(workDir, 'data/reporter-queue.db'),
        fetchFn,
      });
      expect(calls).toHaveLength(0);
      expect(result).toEqual({ pushed: 0, skipped: 0, failed: 0, queued: 0 });
    });
  });

  describe('TC-I-08 (REQ-10, happy): 30 sessions → 1 batch', () => {
    it('sanitizes 30 sessions, pushes ceil(30/50) = 1 batch, marks pushed', async () => {
      writeConfig(path.join(workDir, 'data'));
      const { db, seed } = openSeededDb();
      const sessionIds = seed(30);

      const { fn: fetchFn, calls } = makeFetchStub(() =>
        okResponse({ accepted: 30, skipped: 0, rejected: 0, errors: [] }),
      );

      const result = await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });

      expect(calls).toHaveLength(1);
      const envelope = JSON.parse((calls[0].init.body as string)) as SignedEnvelope;
      expect(envelope.payload).toHaveLength(30);
      expect(envelope.key_id).toBe(SAMPLE_CONFIG.key_id);
      expect(envelope.machine_id).toBe(SAMPLE_CONFIG.machine_id);
      expect(envelope.signature).toMatch(/^[0-9a-f]{64}$/);
      // Each payload is sanitized — no user_prompt etc.
      expect(JSON.stringify(envelope.payload)).not.toContain('user_prompt');

      expect(result.pushed).toBe(30);
      expect(result.failed).toBe(0);

      // reporter_pushed_sessions populated for all
      const rows = db
        .prepare('SELECT session_id, payload_hash FROM reporter_pushed_sessions')
        .all() as Array<{ session_id: string; payload_hash: string }>;
      expect(rows).toHaveLength(30);
      expect(new Set(rows.map((r) => r.session_id))).toEqual(new Set(sessionIds));
      // Each payload_hash is a sha256 hex string
      for (const r of rows) {
        expect(r.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      }
      db.close();
    });
  });

  describe('TC-I-09 (REQ-10, idempotency): re-run pushes 0 unchanged', () => {
    it('second run with no changes pushes nothing', async () => {
      writeConfig(path.join(workDir, 'data'));
      const { db, seed } = openSeededDb();
      seed(5);

      const { fn: fetchFn, calls } = makeFetchStub(() =>
        okResponse({ accepted: 5, skipped: 0, rejected: 0, errors: [] }),
      );

      const first = await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });
      expect(first.pushed).toBe(5);
      expect(calls).toHaveLength(1);

      const second = await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });
      // REQ-10 idempotency: nothing to push. Either the candidate query
      // returns 0 rows (sessions are out of the recent window and not
      // updated), or it returns rows whose `payload_hash` matches and the
      // runner classifies them as `skipped`. Both outcomes satisfy the
      // contract — the only thing that MUST hold is `pushed === 0` and
      // no extra network call.
      expect(second.pushed).toBe(0);
      expect(calls).toHaveLength(1);
      db.close();
    });
  });

  describe('TC-I-10 (REQ-10, business): rating change re-pushes', () => {
    it('updates payload_hash when rating added', async () => {
      writeConfig(path.join(workDir, 'data'));
      const { db, seed } = openSeededDb();
      seed(1);

      const { fn: fetchFn } = makeFetchStub(() =>
        okResponse({ accepted: 1, skipped: 0, rejected: 0, errors: [] }),
      );

      const first = await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });
      expect(first.pushed).toBe(1);
      const firstHash = (
        db
          .prepare('SELECT payload_hash FROM reporter_pushed_sessions WHERE session_id = ?')
          .get('sess-0') as { payload_hash: string }
      ).payload_hash;

      // Mutate: change the rating from 1 → -1 with a fresh rated_at.
      // The runner detects rating updates via `ratings.rated_at > pushed_at`.
      db.prepare('UPDATE ratings SET rating = -1, rated_at = ? WHERE turn_id = ?').run(
        Date.now() + 60_000,
        'turn-0',
      );

      const second = await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });
      expect(second.pushed).toBe(1);
      const secondHash = (
        db
          .prepare('SELECT payload_hash FROM reporter_pushed_sessions WHERE session_id = ?')
          .get('sess-0') as { payload_hash: string }
      ).payload_hash;
      expect(secondHash).not.toBe(firstHash);
      db.close();
    });
  });

  describe('dry-run mode', () => {
    it('prints canonical JSON and does no network or DB write', async () => {
      writeConfig(path.join(workDir, 'data'));
      const { db, seed } = openSeededDb();
      seed(2);

      const { fn: fetchFn, calls } = makeFetchStub(() =>
        okResponse({ accepted: 2, skipped: 0, rejected: 0, errors: [] }),
      );

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const result = await runReporter({
          db,
          configPath: path.join(workDir, 'data/reporter-config.json'),
          queuePath: ':memory:',
          fetchFn,
          dryRun: true,
        });
        expect(result.pushed).toBe(0);
        expect(calls).toHaveLength(0);
        const pushed = db
          .prepare('SELECT COUNT(*) AS c FROM reporter_pushed_sessions')
          .get() as { c: number };
        expect(pushed.c).toBe(0);
        expect(stdoutSpy).toHaveBeenCalled();
        // Reconstruct what was printed; must be parseable JSON arrays.
        const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        // The runner emits canonical JSON of the sanitized batch — expect a
        // top-level array with 2 items.
        const parsed = JSON.parse(printed.trim().split('\n').filter(Boolean).pop() ?? '[]');
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(2);
      } finally {
        stdoutSpy.mockRestore();
      }
      db.close();
    });
  });

  describe('payload_hash is sha256 of canonical JSON', () => {
    it('computes hash matching sha256(canonicalJSON(payload))', async () => {
      writeConfig(path.join(workDir, 'data'));
      const { db, seed } = openSeededDb();
      seed(1);

      let capturedEnvelope: SignedEnvelope | null = null;
      const { fn: fetchFn } = makeFetchStub((call) => {
        capturedEnvelope = JSON.parse(call.init.body as string) as SignedEnvelope;
        return okResponse({ accepted: 1, skipped: 0, rejected: 0, errors: [] });
      });

      await runReporter({
        db,
        configPath: path.join(workDir, 'data/reporter-config.json'),
        queuePath: ':memory:',
        fetchFn,
      });

      expect(capturedEnvelope).not.toBeNull();
      const payload = capturedEnvelope!.payload[0];
      const expectedHash = createHash('sha256').update(canonicalJSON(payload)).digest('hex');
      const stored = db
        .prepare('SELECT payload_hash FROM reporter_pushed_sessions WHERE session_id = ?')
        .get('sess-0') as { payload_hash: string };
      expect(stored.payload_hash).toBe(expectedHash);
      db.close();
    });
  });
});

describe('readConfig', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('returns null when file missing', () => {
    expect(readConfig(path.join(workDir, 'nope.json'))).toBeNull();
  });

  it('parses a valid config file', () => {
    const file = path.join(workDir, 'cfg.json');
    fs.writeFileSync(file, JSON.stringify(SAMPLE_CONFIG));
    expect(readConfig(file)).toEqual(SAMPLE_CONFIG);
  });

  it('throws on missing required field', () => {
    const file = path.join(workDir, 'cfg.json');
    const rest: Partial<ReporterConfig> = { ...SAMPLE_CONFIG };
    delete rest.key_id;
    fs.writeFileSync(file, JSON.stringify(rest));
    expect(() => readConfig(file)).toThrow(/key_id/);
  });
});
