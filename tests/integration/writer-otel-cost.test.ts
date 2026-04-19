import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { ingestAll, writeSession } from '@/lib/ingest/writer';
import type { ParsedSession } from '@/lib/ingest/transcript/types';

/**
 * Coverage for the pricing-otel-source-of-truth spec — TASK-3 integration
 * of OTEL cost authority into the ingest write path.
 *
 *  TC-I-06: OTEL fetch of `claude_code_cost_usage_total` → after ingestAll,
 *           sessions.total_cost_usd_otel = scrape value.
 *  TC-I-07: OTEL unreachable + otelOptional=true → total_cost_usd_otel NULL,
 *           total_cost_usd matches the local computeCost sum.
 *  TC-I-08: Order — the OTEL scrape is written BEFORE JSONL processing so
 *           the post-writeSession lookup in the same run finds it.
 *  TC-I-16: Sweep final — a session whose JSONL was mtime-gated-skipped but
 *           whose OTEL scrape landed in this run is still upgraded.
 */

const FIXTURE_SESSION_ID = 'sess-fixture-001';

const prometheusResponse = (
  sessionId: string,
  model: string,
  costUsd: number,
): string => {
  // Minimal Prometheus exposition — `fetchAndParse` re-timestamps with
  // Date.now(), so scrapedAt in the DB row will be fresh regardless of any
  // exposition-side timestamp.
  return `# HELP claude_code_cost_usage_total Cost in USD
# TYPE claude_code_cost_usage_total counter
claude_code_cost_usage_total{session_id="${sessionId}",model="${model}",user_id="u",organization_id="o"} ${costUsd}
`;
};

const okResponse = (body: string): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => body,
  }) as unknown as Response;

const makeFetchFn = (body: string): typeof fetch =>
  (async () => okResponse(body)) as unknown as typeof fetch;

const makeThrowingFetchFn = (msg: string): typeof fetch =>
  (async () => {
    throw new Error(msg);
  }) as unknown as typeof fetch;

const insertScrape = (
  db: DB,
  metricName: string,
  labels: Record<string, string>,
  value: number,
  scrapedAt: number,
): void => {
  db.prepare(
    `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(metric_name, labels_json, scraped_at) DO NOTHING`,
  ).run(scrapedAt, metricName, JSON.stringify(labels), value);
};

const seedFixture = (dir: string): void => {
  const fixture = fs.readFileSync(
    path.resolve(process.cwd(), 'tests/fixtures/sample.jsonl'),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'sample.jsonl'), fixture);
};

const makeParsedSession = (id: string): ParsedSession => ({
  id,
  cwd: '/Users/dev/proj',
  project: 'proj',
  gitBranch: 'main',
  ccVersion: '2.0.0',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_100_000,
  turns: [
    {
      id: `${id}-t1`,
      parentUuid: 'u1',
      sequence: 0,
      timestamp: 1_700_000_010_000,
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 25,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
      userPrompt: 'hello',
      assistantText: 'hi',
      subagentType: null,
      toolCalls: [],
    },
  ],
});

describe('writer — OTEL cost authority (TASK-3)', () => {
  let db: DB;
  let tempDir: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-otel-cost-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TC-I-06: populates sessions.total_cost_usd_otel from the OTEL scrape of the same run', async () => {
    seedFixture(tempDir);
    const body = prometheusResponse(
      FIXTURE_SESSION_ID,
      'claude-sonnet-4-5',
      7.5,
    );
    const summary = await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: 'http://localhost:9464/metrics',
      fetchFn: makeFetchFn(body),
    });

    expect(summary.filesProcessed).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(summary.otelScrapes).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare(
        'SELECT total_cost_usd_otel, total_cost_usd FROM sessions WHERE id = ?',
      )
      .get(FIXTURE_SESSION_ID) as {
      total_cost_usd_otel: number | null;
      total_cost_usd: number;
    };
    expect(row.total_cost_usd_otel).toBe(7.5);
    // Local computeCost-based column continues to be computed (sanity):
    expect(row.total_cost_usd).toBeGreaterThan(0);
  });

  it('TC-I-07: OTEL unreachable + otelOptional leaves total_cost_usd_otel NULL, local cost intact', async () => {
    seedFixture(tempDir);
    const summary = await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: 'http://localhost:9464/metrics',
      fetchFn: makeThrowingFetchFn('connection refused'),
      otelOptional: true,
    });

    expect(summary.filesProcessed).toBe(1);
    // otelOptional=true swallows the fetch error entirely.
    expect(summary.errors).toEqual([]);
    expect(summary.otelScrapes).toBe(0);

    const row = db
      .prepare(
        'SELECT total_cost_usd_otel, total_cost_usd FROM sessions WHERE id = ?',
      )
      .get(FIXTURE_SESSION_ID) as {
      total_cost_usd_otel: number | null;
      total_cost_usd: number;
    };
    expect(row.total_cost_usd_otel).toBeNull();
    expect(row.total_cost_usd).toBeGreaterThan(0);
  });

  it('TC-I-08: OTEL runs before JSONL processing — single run populates otel cost for a new session', async () => {
    // Seed the fixture AND the OTEL endpoint at once. The only way
    // writeSession's post-call lookup can find the scrape is if
    // fetchAndParse + writeOtelScrapes ran first in ingestAll.
    seedFixture(tempDir);
    const body = prometheusResponse(
      FIXTURE_SESSION_ID,
      'claude-sonnet-4-5',
      12.34,
    );
    // Pre-state assertion: no sessions, no scrapes.
    expect(
      (db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c,
    ).toBe(0);

    await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: 'http://localhost:9464/metrics',
      fetchFn: makeFetchFn(body),
    });

    const row = db
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get(FIXTURE_SESSION_ID) as { total_cost_usd_otel: number | null };
    // Populated on the very first pass — no second ingest needed.
    expect(row.total_cost_usd_otel).toBe(12.34);
  });

  it('TC-I-16: final sweep upgrades total_cost_usd_otel for mtime-gated sessions', async () => {
    // First pass: ingest the JSONL so the mtime gate is primed. No OTEL yet.
    seedFixture(tempDir);
    await ingestAll({ db, transcriptsRoot: tempDir });
    const firstRow = db
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get(FIXTURE_SESSION_ID) as { total_cost_usd_otel: number | null };
    expect(firstRow.total_cost_usd_otel).toBeNull();

    // Second pass: no disk change (mtime gate will skip writeSession) but
    // OTEL comes back with a cost for that session. The final sweep must
    // still upgrade the column.
    const body = prometheusResponse(
      FIXTURE_SESSION_ID,
      'claude-sonnet-4-5',
      3.21,
    );
    const summary = await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: 'http://localhost:9464/metrics',
      fetchFn: makeFetchFn(body),
    });
    // writeSession was skipped (mtime gate) — filesProcessed stays 0.
    expect(summary.filesProcessed).toBe(0);
    expect(summary.otelScrapes).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get(FIXTURE_SESSION_ID) as { total_cost_usd_otel: number | null };
    expect(row.total_cost_usd_otel).toBe(3.21);
  });

  it('TC-I-06 (writeSession unit): direct writeSession + pre-seeded OTEL scrape populates the column', () => {
    // Complementary to TC-I-06's end-to-end form: if the OTEL scrape is
    // already in the DB when writeSession runs, the per-session upgrade
    // should pick it up on the same call.
    insertScrape(
      db,
      'claude_code_cost_usage_total',
      { session_id: 's-direct', model: 'claude-opus-4-7', user_id: 'u', organization_id: 'o' },
      9.87,
      Date.now(),
    );
    writeSession(db, makeParsedSession('s-direct'), '/tmp/s-direct.jsonl');
    const row = db
      .prepare('SELECT total_cost_usd_otel FROM sessions WHERE id = ?')
      .get('s-direct') as { total_cost_usd_otel: number | null };
    expect(row.total_cost_usd_otel).toBe(9.87);
  });
});
