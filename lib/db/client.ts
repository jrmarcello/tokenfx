import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from './migrate';

export type DB = DatabaseType;

export function openDatabase(dbPath?: string): DB {
  const resolved = dbPath ?? process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';

  if (resolved !== ':memory:') {
    const dir = path.dirname(resolved);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolved);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

let singleton: DB | null = null;
let singletonKey: string | null = null;

export function getDb(): DB {
  const key = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
  if (singleton && singletonKey === key) {
    return singleton;
  }
  if (singleton) {
    singleton.close();
  }
  singleton = openDatabase(key);
  migrate(singleton);
  singletonKey = key;
  return singleton;
}

export function resetDbSingleton(): void {
  if (singleton) {
    singleton.close();
  }
  singleton = null;
  singletonKey = null;
}
