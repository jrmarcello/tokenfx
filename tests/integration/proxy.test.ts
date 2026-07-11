// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NextRequest } from 'next/server';
import { proxy } from '../../proxy';
import { openDatabase, resetDbSingleton } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

/**
 * Integration tests for the /sessions/[id] proxy — the layer that turns a
 * nonexistent session into a real HTTP 404 before the streaming shell
 * commits a 200 (REQ-6 of .specs/fix-pricing-unknown-model-family.md).
 *
 * Uses a real file-backed SQLite DB via DASHBOARD_DB_PATH (hand-built
 * request stub, no mocking framework).
 */

let dbPath = '';
let tmpDir = '';

const makeRequest = (pathname: string): NextRequest =>
  ({
    nextUrl: new URL(`http://localhost:3131${pathname}`),
  }) as unknown as NextRequest;

const seedSession = (id: string): void => {
  const db = openDatabase(dbPath);
  db.prepare(
    `INSERT INTO sessions (
       id, cwd, project, started_at, ended_at, source_file, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, '/tmp/cwd', 'proj', 1_700_000_000_000, 1_700_000_010_000, `/tmp/${id}.jsonl`, 1_700_000_020_000);
  db.close();
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
  dbPath = path.join(tmpDir, 'proxy.db');
  process.env.DASHBOARD_DB_PATH = dbPath;
  process.env.TOKENFX_DISABLE_AUTO_INGEST = '1';
  resetDbSingleton();
  const bootstrap = openDatabase(dbPath);
  migrate(bootstrap);
  bootstrap.close();
});

afterEach(() => {
  resetDbSingleton();
  delete process.env.DASHBOARD_DB_PATH;
  delete process.env.TOKENFX_DISABLE_AUTO_INGEST;
  delete process.env.CLAUDE_PROJECTS_ROOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sessions proxy', () => {
  it('lets requests for an existing session pass through', async () => {
    seedSession('sess-exists');
    const res = await proxy(makeRequest('/sessions/sess-exists'));
    // NextResponse.next() carries the x-middleware-next marker.
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.status).toBe(200);
  });

  it('rewrites nonexistent sessions to a real 404 status', async () => {
    const res = await proxy(makeRequest('/sessions/nope'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-middleware-rewrite')).toContain('/sessions/nope');
  });

  it('returns 404 (not 500) for malformed percent-encoded ids', async () => {
    const res = await proxy(makeRequest('/sessions/%ZZ'));
    expect(res.status).toBe(404);
  });

  it('does not false-404 a session whose JSONL exists on disk but was not yet ingested', async () => {
    // Point the ingest root at a tmp dir containing a real transcript
    // fixture, enable ingest, and ask for the fixture's session id —
    // the proxy must run the coalesced ingest and let the request pass.
    const projectsRoot = path.join(tmpDir, 'projects', 'proj-a');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'sample.jsonl'),
      path.join(projectsRoot, 'sess-fixture-001.jsonl'),
    );
    process.env.CLAUDE_PROJECTS_ROOT = path.join(tmpDir, 'projects');
    delete process.env.TOKENFX_DISABLE_AUTO_INGEST;

    const res = await proxy(makeRequest('/sessions/sess-fixture-001'));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.status).toBe(200);
  }, 30_000);
});
