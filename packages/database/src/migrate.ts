import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type MigrationFile = { name: string; sql: string; checksum: string };

const advisoryLockId = 71_024_001;

const readMigrations = async (directory: string): Promise<MigrationFile[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
};

const ensureLedger = (client: PoolClient) =>
  client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

export const migrate = async (
  pool: Pool,
  directory: string,
  afterMigrate?: (client: PoolClient) => Promise<void>,
): Promise<string[]> => {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);
    locked = true;
    await ensureLedger(client);

    const recorded = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const checksums = new Map(recorded.rows.map((row) => [row.name, row.checksum]));
    const applied: string[] = [];

    for (const migration of migrations) {
      const existingChecksum = checksums.get(migration.name);
      if (existingChecksum !== undefined && existingChecksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.name}`);
      }
    }

    for (const migration of migrations) {
      const existingChecksum = checksums.get(migration.name);
      if (existingChecksum !== undefined) {
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    if (afterMigrate) {
      try {
        await client.query('BEGIN');
        await afterMigrate(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return applied;
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
    }
    client.release();
  }
};

const runCli = async (): Promise<void> => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const directory = fileURLToPath(new URL('../migrations', import.meta.url));
    const applied = await migrate(pool, directory);
    console.log(applied.length === 0 ? 'No migrations applied.' : `Applied: ${applied.join(', ')}`);
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
