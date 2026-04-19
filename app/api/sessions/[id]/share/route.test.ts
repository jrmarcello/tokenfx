import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getDb, resetDbSingleton } from '@/lib/db/client';
import { writeSession } from '@/lib/ingest/writer';
import type { ParsedSession } from '@/lib/ingest/transcript/types';
import { GET } from './route';

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 'share-test-001',
    cwd: '/Users/dev/share-test',
    project: 'share-test',
    gitBranch: 'main',
    ccVersion: '2.0.0',
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_100_000,
    turns: [
      {
        id: 't1',
        parentUuid: 'u1',
        sequence: 0,
        timestamp: 1_800_000_010_000,
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        serviceTier: 'standard',
        stopReason: 'end_turn',
        userPrompt: 'super secret question',
        assistantText: 'here is the reply',
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'Bash',
            inputJson: JSON.stringify({ command: 'ls' }),
            resultJson: JSON.stringify({ text: 'file.txt' }),
            resultIsError: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeRequest(
  url: string,
  init: { headers?: Record<string, string> } = {},
): NextRequest {
  const fullUrl = url.startsWith('http') ? url : `http://localhost:3000${url}`;
  const headers = new Headers({ host: 'localhost:3000', ...init.headers });
  return new NextRequest(fullUrl, { headers });
}

describe('GET /api/sessions/[id]/share', () => {
  let tempDbFile: string;

  beforeEach(() => {
    tempDbFile = path.join(
      os.tmpdir(),
      `share-route-test-${Date.now()}-${Math.random()}.db`,
    );
    process.env.DASHBOARD_DB_PATH = tempDbFile;
    resetDbSingleton();
    const db = getDb();
    writeSession(db, makeSession(), '/tmp/source.jsonl');
  });

  afterEach(() => {
    resetDbSingleton();
    delete process.env.DASHBOARD_DB_PATH;
    if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile);
    if (fs.existsSync(`${tempDbFile}-wal`)) fs.unlinkSync(`${tempDbFile}-wal`);
    if (fs.existsSync(`${tempDbFile}-shm`)) fs.unlinkSync(`${tempDbFile}-shm`);
  });

  it('TC-I-01: GET with valid id returns 200 text/markdown with H1 prefix', async () => {
    const req = makeRequest('/api/sessions/share-test-001/share');
    const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown; charset=utf-8$/);
    const body = await res.text();
    expect(body.startsWith('# Sessão: share-test')).toBe(true);
  });

  it('TC-I-02: ?download=1 sets Content-Disposition attachment with filename', async () => {
    const req = makeRequest('/api/sessions/share-test-001/share?download=1');
    const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition');
    expect(cd).toMatch(/^attachment; filename="tokenfx-session-share-test-001-\d{8}\.md"$/);
  });

  it('TC-I-03: without ?download=1, Content-Disposition header is absent', async () => {
    const req = makeRequest('/api/sessions/share-test-001/share');
    const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('TC-I-04: ?redact=1 replaces prompts with [REDIGIDO] and removes original text', async () => {
    const req = makeRequest('/api/sessions/share-test-001/share?redact=1');
    const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
    const body = await res.text();
    expect(body).toContain('[REDIGIDO]');
    expect(body).not.toContain('super secret question');
    expect(body).not.toContain('here is the reply');
  });

  it('TC-I-05: ?redact=1 preserves toolName and model', async () => {
    const req = makeRequest('/api/sessions/share-test-001/share?redact=1');
    const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
    const body = await res.text();
    expect(body).toContain('Bash');
    expect(body).toContain('claude-opus-4-7');
  });

  it('TC-I-06: unknown session id returns 404 JSON with error shape', async () => {
    const req = makeRequest('/api/sessions/does-not-exist/share');
    const res = await GET(req, { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const json = (await res.json()) as {
      error: { message: string; code: string };
    };
    expect(json.error.message).toBe('Session not found');
    expect(json.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('TC-I-07: malformed id (path-traversal-looking) returns 404, not 500', async () => {
    const req = makeRequest('/api/sessions/%2E%2E%2Fetc%2Fpasswd/share');
    const res = await GET(req, {
      params: Promise.resolve({ id: '../etc/passwd' }),
    });
    expect(res.status).toBe(404);
  });

  it('TC-I-08: ?download=1 filename includes YYYYMMDD of current local date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 19, 10, 0, 0));
    try {
      const req = makeRequest('/api/sessions/share-test-001/share?download=1');
      const res = await GET(req, { params: Promise.resolve({ id: 'share-test-001' }) });
      const cd = res.headers.get('content-disposition') ?? '';
      expect(cd).toContain('20260419');
    } finally {
      vi.useRealTimers();
    }
  });

  it('TC-I-09: two GETs to same id return identical bodies (idempotent)', async () => {
    const req1 = makeRequest('/api/sessions/share-test-001/share');
    const req2 = makeRequest('/api/sessions/share-test-001/share');
    const res1 = await GET(req1, { params: Promise.resolve({ id: 'share-test-001' }) });
    const res2 = await GET(req2, { params: Promise.resolve({ id: 'share-test-001' }) });
    expect(await res1.text()).toBe(await res2.text());
  });

  it('TC-I-10: session with 0 turns returns body with _Sem turnos nesta sessão._', async () => {
    const db = getDb();
    writeSession(
      db,
      makeSession({ id: 'empty-turns-001', turns: [] }),
      '/tmp/source2.jsonl',
    );
    const req = makeRequest('/api/sessions/empty-turns-001/share');
    const res = await GET(req, { params: Promise.resolve({ id: 'empty-turns-001' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('_Sem turnos nesta sessão._');
  });

  it('TC-I-11: legacy non-UUID id is accepted; filename includes encoded id', async () => {
    const db = getDb();
    writeSession(
      db,
      makeSession({ id: 'legacy-2024-001' }),
      '/tmp/source3.jsonl',
    );
    const req = makeRequest('/api/sessions/legacy-2024-001/share?download=1');
    const res = await GET(req, { params: Promise.resolve({ id: 'legacy-2024-001' }) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith('# Sessão:')).toBe(true);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('legacy-2024-001');
  });
});
