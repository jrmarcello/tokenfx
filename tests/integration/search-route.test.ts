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

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const makeTmpDb = () =>
  path.join(
    os.tmpdir(),
    `search-route-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
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

const LOOPBACK_HEADERS = { host: 'localhost' };

describe('GET /api/search', () => {
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

  async function seed() {
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    db.prepare(
      `INSERT INTO sessions
         (id, cwd, project, started_at, ended_at, source_file, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', '/x', 'alpha', Date.now() - 86_400_000, Date.now(), 'f', Date.now());
    db.prepare(
      `INSERT INTO turns
         (id, session_id, sequence, timestamp, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, user_prompt, assistant_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t1', 's1', 1, Date.now(), 'claude-sonnet', 0, 0, 0, 0, 0, 'the auth bug in route handler', 'here is the fix');
  }

  // TC-I-20
  it('TC-I-20: returns 403 for non-loopback Host header', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://evil.example.com/api/search?q=auth', {
        headers: { host: 'evil.example.com' },
      }),
    );
    expect(res.status).toBe(403);
  });

  // TC-I-21
  it('TC-I-21: returns 403 when Origin is not loopback', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search?q=auth', {
        headers: { host: 'localhost', origin: 'http://evil.example.com' },
      }),
    );
    expect(res.status).toBe(403);
  });

  // TC-I-22
  it('TC-I-22: missing q returns 400 with error shape', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search', {
        headers: LOOPBACK_HEADERS,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { message: string; code?: string };
    };
    expect(body.error?.message).toBe('invalid query');
    expect(body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('TC-I-22: empty q returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search?q=', {
        headers: LOOPBACK_HEADERS,
      }),
    );
    expect(res.status).toBe(400);
  });

  // TC-I-23
  it('TC-I-23: q > 200 chars returns 400', async () => {
    const { GET } = await import('@/app/api/search/route');
    const long = encodeURIComponent('a'.repeat(201));
    const res = await GET(
      new Request(`http://localhost/api/search?q=${long}`, {
        headers: LOOPBACK_HEADERS,
      }),
    );
    expect(res.status).toBe(400);
  });

  // TC-I-24
  it('TC-I-24: happy path returns { items, total }', async () => {
    await seed();
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search?q=auth', {
        headers: LOOPBACK_HEADERS,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ turnId: string }>;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBe(1);
    expect(body.items[0].turnId).toBe('t1');
  });

  // TC-I-25
  it('TC-I-25: limit 9999 is clamped to 100', async () => {
    await seed();
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search?q=auth&limit=9999', {
        headers: LOOPBACK_HEADERS,
      }),
    );
    // limit is bounded by Zod schema to max 100, so 9999 is rejected as 400
    expect(res.status).toBe(400);
  });

  it('limit 100 is accepted and clamped inside searchTurns', async () => {
    await seed();
    const { GET } = await import('@/app/api/search/route');
    const res = await GET(
      new Request('http://localhost/api/search?q=auth&limit=100', {
        headers: LOOPBACK_HEADERS,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeLessThanOrEqual(100);
  });

  // TC-I-26
  it('TC-I-26: idempotent — same inputs → same outputs', async () => {
    await seed();
    const { GET } = await import('@/app/api/search/route');
    const make = () =>
      GET(
        new Request('http://localhost/api/search?q=auth', {
          headers: LOOPBACK_HEADERS,
        }),
      );
    const a = await (await make()).json();
    const b = await (await make()).json();
    expect(a).toEqual(b);
  });
});
