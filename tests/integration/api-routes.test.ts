import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock Next's cache functions — they require the full runtime, which vitest
// doesn't provide. The route handlers just call them for revalidation.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// Each test file gets its own DB file + module cache, so the getDb()
// singleton picks up the right DASHBOARD_DB_PATH.
const makeTmpDb = () =>
  path.join(
    os.tmpdir(),
    `api-routes-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );

const cleanupDb = (dbPath: string) => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix);
    } catch {
      // ignore missing
    }
  }
};

const LOOPBACK_HEADERS = { 'content-type': 'application/json', host: 'localhost' };

describe('POST /api/ratings', () => {
  let tmpDb: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDb = makeTmpDb();
    prevEnv = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = tmpDb;
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDbSingleton } = await import('@/lib/db/client');
    resetDbSingleton();
    if (prevEnv === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevEnv;
    cleanupDb(tmpDb);
  });

  it('returns 400 for missing rating field', async () => {
    const { POST } = await import('@/app/api/ratings/route');
    const res = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: JSON.stringify({ turnId: 'x' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string; code?: string } };
    expect(body.error?.message).toBe('invalid body');
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-JSON body', async () => {
    const { POST } = await import('@/app/api/ratings/route');
    const res = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for out-of-range rating', async () => {
    const { POST } = await import('@/app/api/ratings/route');
    const res = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: JSON.stringify({ turnId: 'x', rating: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for note exceeding 4096 chars', async () => {
    const { POST } = await import('@/app/api/ratings/route');
    const res = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: JSON.stringify({
          turnId: 'x',
          rating: 1,
          note: 'a'.repeat(4097),
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it.each(['evil.example.com', '192.168.1.100', ''])(
    'returns 403 for non-loopback Host "%s"',
    async (host) => {
      const { POST } = await import('@/app/api/ratings/route');
      const res = await POST(
        new Request('http://example.com/api/ratings', {
          method: 'POST',
          headers: host
            ? { 'content-type': 'application/json', host }
            : { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId: 'x', rating: 1 }),
        }),
      );
      expect(res.status).toBe(403);
    },
  );

  it('returns 403 when Origin is not a loopback origin', async () => {
    const { POST } = await import('@/app/api/ratings/route');
    const res = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://evil.example.com',
        },
        body: JSON.stringify({ turnId: 'x', rating: 1 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('persists a valid rating and is idempotent', async () => {
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    // Seed a session + turn the rating can reference.
    db.prepare(
      `INSERT INTO sessions
         (id, cwd, project, started_at, ended_at, source_file, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('s-1', '/x', 'x', 0, 0, 'f', 0);
    db.prepare(
      `INSERT INTO turns
         (id, session_id, sequence, timestamp, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t-1', 's-1', 0, 0, 'm', 0, 0, 0, 0, 0);

    const { POST } = await import('@/app/api/ratings/route');
    const res1 = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: JSON.stringify({ turnId: 't-1', rating: 1 }),
      }),
    );
    expect(res1.status).toBe(200);

    const res2 = await POST(
      new Request('http://localhost/api/ratings', {
        method: 'POST',
        headers: LOOPBACK_HEADERS,
        body: JSON.stringify({ turnId: 't-1', rating: -1 }),
      }),
    );
    expect(res2.status).toBe(200);

    const row = db
      .prepare('SELECT rating FROM ratings WHERE turn_id = ?')
      .get('t-1') as { rating: number } | undefined;
    expect(row?.rating).toBe(-1); // upsert replaced
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM ratings')
      .get() as { n: number };
    expect(count.n).toBe(1); // no duplicate
  });
});

describe('POST /api/ingest', () => {
  let tmpDb: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDb = makeTmpDb();
    prevEnv = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = tmpDb;
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDbSingleton } = await import('@/lib/db/client');
    resetDbSingleton();
    if (prevEnv === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = prevEnv;
    cleanupDb(tmpDb);
  });

  it.each([
    'evil.example.com',
    'attacker.internal',
    '192.168.1.100',
    '10.0.0.5:3000',
    '',
  ])('returns 403 for non-loopback Host header "%s"', async (host) => {
    const { POST } = await import('@/app/api/ingest/route');
    const res = await POST(
      new Request('http://example.com/api/ingest', {
        method: 'POST',
        headers: host ? { host } : {},
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when Origin is not a loopback origin', async () => {
    const { POST } = await import('@/app/api/ingest/route');
    const res = await POST(
      new Request('http://localhost/api/ingest', {
        method: 'POST',
        headers: { host: 'localhost', origin: 'http://evil.example.com' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it.each([
    'localhost',
    'localhost:3000',
    '127.0.0.1',
    '127.0.0.1:3123',
    '[::1]:3000',
  ])('accepts loopback Host header "%s"', async (host) => {
    // Mock ingestAll so the test doesn't touch ~/.claude/projects
    vi.doMock('@/lib/ingest/writer', () => ({
      ingestAll: vi.fn(async () => ({
        filesProcessed: 0,
        filesSkipped: 0,
        sessionsUpserted: 0,
        turnsUpserted: 0,
        toolCallsUpserted: 0,
        otelScrapes: 0,
        errors: [],
      })),
    }));

    const { POST } = await import('@/app/api/ingest/route');
    const res = await POST(
      new Request('http://localhost/api/ingest', {
        method: 'POST',
        headers: { host },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
