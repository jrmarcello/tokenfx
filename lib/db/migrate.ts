import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './client';

function resolveSchemaPath(): string {
  // Support both CJS (__dirname) and ESM (import.meta.url) environments.
  // Vitest runs TS via ESM by default.
  try {
    const metaUrl: string | undefined = (import.meta as unknown as { url?: string }).url;
    if (metaUrl) {
      const here = path.dirname(fileURLToPath(metaUrl));
      return path.resolve(here, 'schema.sql');
    }
  } catch {
    // fall through
  }
  // Fallback: relative to cwd/lib/db
  return path.resolve(process.cwd(), 'lib/db/schema.sql');
}

export function migrate(db: DB): void {
  const schemaPath = resolveSchemaPath();
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

export function ensureMigrated(db: DB): void {
  migrate(db);
}
