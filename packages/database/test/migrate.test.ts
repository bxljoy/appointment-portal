import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { migrate } from '../src/migrate.js';
import { withEmptyTestDb, withTestDb } from './harness.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));

test('returns no migrations when run after the schema is current', async () => {
  await withTestDb(async (pool) => {
    await expect(migrate(pool, migrationsDirectory)).resolves.toEqual([]);
  });
});

test('serializes concurrent migrators and applies each migration once', async () => {
  await withEmptyTestDb(async (pool) => {
    const results = await Promise.all([
      migrate(pool, migrationsDirectory),
      migrate(pool, migrationsDirectory),
    ]);

    expect(results.flat()).toEqual(['001_initial.sql', '002_default_patient_role.sql']);
    await expect(pool.query('SELECT name FROM schema_migrations')).resolves.toMatchObject({ rowCount: 2 });
  });
});

test('rejects an applied migration whose SQL file changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-migrations-'));
  try {
    const name = '001_initial.sql';
    const source = await readFile(join(migrationsDirectory, name), 'utf8');
    await writeFile(join(directory, name), source);

    await withEmptyTestDb(async (pool) => {
      await migrate(pool, directory);
      await writeFile(join(directory, name), `${source}\n-- changed`);

      await expect(migrate(pool, directory)).rejects.toThrow('Migration checksum mismatch for 001_initial.sql');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an applied migration whose SQL file is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-migrations-'));
  try {
    const name = '001_initial.sql';
    const source = await readFile(join(migrationsDirectory, name), 'utf8');
    await writeFile(join(directory, name), source);

    await withEmptyTestDb(async (pool) => {
      await migrate(pool, directory);
      await rm(join(directory, name));

      await expect(migrate(pool, directory)).rejects.toThrow(
        'Applied migration file missing: 001_initial.sql',
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checks all applied migration hashes before it runs any pending file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-migrations-'));
  try {
    const name = '001_initial.sql';
    const source = await readFile(join(migrationsDirectory, name), 'utf8');
    await writeFile(join(directory, name), source);

    await withEmptyTestDb(async (pool) => {
      await migrate(pool, directory);
      await writeFile(join(directory, '000_precheck.sql'), 'CREATE TABLE precheck_marker (id integer PRIMARY KEY);');
      await writeFile(join(directory, name), `${source}\n-- changed`);

      await expect(migrate(pool, directory)).rejects.toThrow('Migration checksum mismatch for 001_initial.sql');
      await expect(
        pool.query("SELECT to_regclass('public.precheck_marker') AS name"),
      ).resolves.toMatchObject({ rows: [{ name: null }] });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rolls back a failed afterMigrate callback together with the schema migration', async () => {
  await withEmptyTestDb(async (pool) => {
    await expect(
      migrate(pool, migrationsDirectory, async (client) => {
        await client.query('CREATE TABLE callback_setup (id integer PRIMARY KEY)');
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');

    await expect(
      pool.query("SELECT to_regclass('public.callback_setup') AS name"),
    ).resolves.toMatchObject({ rows: [{ name: null }] });
    await expect(pool.query("SELECT to_regclass('public.schema_migrations') AS ledger, to_regclass('public.users') AS users"))
      .resolves.toMatchObject({ rows: [{ ledger: null, users: null }] });
  });
});
