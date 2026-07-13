/**
 * Tests for the HMR-safe SQLite singleton on globalThis.
 * Spec: .specs/arch-followups-lowsev.md (REQ-1..REQ-5).
 *
 * globalThis.__tokenfxDb persists across tests within a file, so we reset in
 * BOTH beforeEach and afterEach (the belt-and-suspenders pattern used by the 7
 * existing resetDbSingleton consumers). Vitest's default isolate:true keeps it
 * from leaking across files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, resetDbSingleton } from './client';

const scratch = (label: string): string =>
  path.join(os.tmpdir(), `tokenfx-client-${label}-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

const setPath = (p: string): void => {
  process.env.DASHBOARD_DB_PATH = p;
};

describe('getDb — HMR-safe globalThis singleton', () => {
  const created: string[] = [];
  const origPath = process.env.DASHBOARD_DB_PATH;

  beforeEach(() => {
    resetDbSingleton();
  });
  afterEach(() => {
    resetDbSingleton();
    if (origPath === undefined) delete process.env.DASHBOARD_DB_PATH;
    else process.env.DASHBOARD_DB_PATH = origPath;
    for (const p of created.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
      }
    }
  });

  it('returns the same instance on repeated calls with the same path (TC-U-01)', () => {
    expect(globalThis.__tokenfxDb).toBeUndefined(); // earned, not inherited
    const p = scratch('same'); created.push(p); setPath(p);
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
    // API-compat: the optional deps arg is idempotent with the no-arg call.
    expect(getDb({})).toBe(a);
  });

  it('stores the handle + key on globalThis (TC-U-02)', () => {
    const p = scratch('global'); created.push(p); setPath(p);
    const db = getDb();
    expect(globalThis.__tokenfxDb).toBeDefined();
    expect(globalThis.__tokenfxDb?.db).toBe(db);
    expect(globalThis.__tokenfxDb?.key).toBe(p);
  });

  it('reuses a handle already on globalThis (simulated HMR) without opening a new one (TC-U-03)', () => {
    const p = scratch('hmr'); created.push(p); setPath(p);
    const manualHandle = getDb(); // real handle
    // Simulate a module reload that left the handle on globalThis.
    globalThis.__tokenfxDb = { db: manualHandle, key: p };
    const returned = getDb();
    expect(returned).toBe(manualHandle); // reference equality → reused, no new open
  });

  it('re-key closes the old handle and opens+migrates a usable new one (TC-U-04)', () => {
    const pa = scratch('rekey-a'); created.push(pa); setPath(pa);
    const a = getDb();
    const pb = scratch('rekey-b'); created.push(pb); setPath(pb);
    const b = getDb();
    expect(b).not.toBe(a);
    expect(a.open).toBe(false); // old closed on re-key
    expect(b.open).toBe(true); // new usable
  });

  it('getDb after reset reopens a fresh instance, never the closed handle (TC-U-05)', () => {
    const p = scratch('reset'); created.push(p); setPath(p);
    const oldHandle = getDb();
    resetDbSingleton();
    const fresh = getDb();
    expect(fresh).not.toBe(oldHandle);
    expect(fresh.open).toBe(true);
  });

  it('resetDbSingleton closes the handle AND clears the global (TC-U-05b)', () => {
    const p = scratch('reset-mech'); created.push(p); setPath(p);
    const oldHandle = getDb();
    resetDbSingleton();
    expect(globalThis.__tokenfxDb).toBeUndefined();
    expect(oldHandle.open).toBe(false);
  });

  it('resetDbSingleton with no prior singleton is a no-op (TC-U-06)', () => {
    expect(globalThis.__tokenfxDb).toBeUndefined();
    expect(() => resetDbSingleton()).not.toThrow();
  });

  it('an A→B→A sequence closes exactly the replaced handle each time (TC-U-07)', () => {
    const pa = scratch('abab-a'); created.push(pa); setPath(pa);
    const firstA = getDb();
    const pb = scratch('abab-b'); created.push(pb); setPath(pb);
    const b = getDb();
    const pa2 = scratch('abab-a2'); created.push(pa2); setPath(pa2);
    const secondA = getDb();
    expect(firstA.open).toBe(false);
    expect(b.open).toBe(false);
    expect(secondA).not.toBe(firstA);
    expect(secondA.open).toBe(true);
  });

  it('a throwing migrate closes the new handle and clears the global (no orphan) (TC-U-08)', () => {
    const p = scratch('migfail'); created.push(p); setPath(p);
    let captured: import('./client').DB | undefined;
    expect(() =>
      getDb({ migrate: (db) => { captured = db; throw new Error('boom'); } }),
    ).toThrow(/boom/);
    // The just-opened handle was closed directly (not just inferred).
    expect(captured?.open).toBe(false);
    expect(globalThis.__tokenfxDb).toBeUndefined();
    // No orphan handle: a subsequent normal getDb() opens cleanly.
    const db = getDb();
    expect(db.open).toBe(true);
  });
});
