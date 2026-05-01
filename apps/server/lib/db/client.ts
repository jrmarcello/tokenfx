import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let dbInstance: Db | null = null;

export const getDb = (): Db => {
  if (dbInstance) return dbInstance;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  dbInstance = drizzle(pool, { schema });
  return dbInstance;
};

export const closeDb = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
};
