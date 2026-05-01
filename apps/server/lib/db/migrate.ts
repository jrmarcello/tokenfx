import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export const runMigrations = async (databaseUrl?: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl ?? process.env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './lib/db/migrations' });
  await pool.end();
};

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('migrations complete');
      process.exit(0);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
