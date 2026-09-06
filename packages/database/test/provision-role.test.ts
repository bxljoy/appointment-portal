import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import format from 'pg-format';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { makeProfilesService } from '../../../apps/api/src/modules/profiles/service.js';
import { makeAvailabilityService } from '../../../apps/api/src/modules/availability/service.js';
import { makeAppointmentsService } from '../../../apps/api/src/modules/appointments/service.js';
import { migrate } from '../src/migrate.js';
import { provisionAppRole } from '../src/provision-role.js';
import { seedScenario, withEmptyTestDb, withTestDb } from './harness.js';

const directory = fileURLToPath(new URL('../migrations', import.meta.url));
const connectionString = process.env.DATABASE_URL ?? 'postgres://portal:portal@127.0.0.1:54329/portal';
const roleAdmin = new Pool({ connectionString, max: 1 });
let createdRole = false;
beforeAll(async () => {
  await roleAdmin.query('SELECT pg_advisory_lock(71024014)');
  if ((await roleAdmin.query("SELECT 1 FROM pg_roles WHERE rolname='portal_app'")).rowCount === 0) {
    await roleAdmin.query("CREATE ROLE portal_app LOGIN PASSWORD 'test-only-bootstrap-password'");
    createdRole = true;
  }
});
afterAll(async () => {
  if (createdRole) await roleAdmin.query('DROP ROLE IF EXISTS portal_app');
  await roleAdmin.query('SELECT pg_advisory_unlock(71024014)');
  await roleAdmin.end();
});

const asApplication = async (admin: Pool, password: string, run: (pool: Pool) => Promise<void>) => {
  const url = new URL(connectionString);
  url.pathname = `/${(await admin.query('SELECT current_database() AS name')).rows[0].name}`;
  url.username = 'portal_app'; url.password = password;
  const app = new Pool({ connectionString: url.toString() });
  try { await run(app); } finally { await app.end(); }
};

test('repeated provisioning safely quotes a password and confines the fixed login role', async () => {
  await withTestDb(async (pool) => {
    const password = "quote'\\; ALTER ROLE portal_app SUPERUSER; -- test";
    await migrate(pool, directory, (client) => provisionAppRole(client, password));
    await migrate(pool, directory, (client) => provisionAppRole(client, password));
    await asApplication(pool, password, async (app) => {
      await expect(app.query('SELECT current_user AS name')).resolves.toMatchObject({ rows: [{ name: 'portal_app' }] });
    });
    await expect(pool.query("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='portal_app'"))
      .resolves.toMatchObject({ rows: [{ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] });
  });
});

test('fresh disposable databases contain only the known migration-owned tables and no sequence or custom defaults', async () => {
  await withTestDb(async (pool) => {
    await expect(pool.query(`SELECT c.relname AS name, c.relowner = current_user::regrole AS owned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') ORDER BY c.relname`))
      .resolves.toMatchObject({ rows: ['appointments', 'availability_slots', 'clinician_profiles', 'schema_migrations', 'users']
        .map((name) => ({ name, owned: true })) });
    await expect(pool.query(`SELECT count(*)::int AS count FROM pg_default_acl
      WHERE defaclrole = current_user::regrole AND defaclobjtype IN ('r', 'S')`))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});

test('real app credentials cannot create temporary tables or schemas through fresh PUBLIC or stale direct database grants', async () => {
  await withTestDb(async (pool) => {
    const password = 'test-only-database-privileges-password';
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    // PostgreSQL's fresh database ACL gives every login TEMPORARY through PUBLIC.
    await expect(pool.query("SELECT has_database_privilege('portal_app',current_database(),'TEMPORARY') AS allowed"))
      .resolves.toMatchObject({ rows: [{ allowed: true }] });
    for (const staleGrants of [false, true]) {
      if (staleGrants) await pool.query(format('GRANT CREATE, TEMPORARY ON DATABASE %I TO PUBLIC, portal_app', database));
      await migrate(pool, directory, (client) => provisionAppRole(client, password));
      await asApplication(pool, password, async (app) => {
        await expect(app.query('CREATE TEMP TABLE forbidden_temp(id int)')).rejects.toMatchObject({ code: '42501' });
        await expect(app.query('CREATE SCHEMA forbidden_schema')).rejects.toMatchObject({ code: '42501' });
        await expect(app.query(`SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
          has_database_privilege(current_user,current_database(),'CREATE') AS create,
          has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary`))
          .resolves.toMatchObject({ rows: [{ connect: true, create: false, temporary: false }] });
      });
    }
  });
});

test('real application credentials can perform the profile, directory, slot and booking workflow', async () => {
  await withTestDb(async (pool) => {
    const password = 'test-only-crud-password';
    const scenario = await seedScenario(pool);
    await migrate(pool, directory, (client) => provisionAppRole(client, password));
    await asApplication(pool, password, async (app) => {
      const deps = { pool: app, clock: () => new Date('2030-06-01T09:00:00Z') };
      const profiles = makeProfilesService(deps);
      const availability = makeAvailabilityService(deps);
      const appointments = makeAppointmentsService(deps);
      await expect(profiles.getMe({ sub: 'new-cognito-sub' })).resolves.toMatchObject({ role: 'patient' });
      await expect(profiles.listClinicians(scenario.patient, { limit: 20 })).resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: scenario.clinician.id })]) });
      const slot = await availability.create(scenario.clinician, { startAt: '2030-06-03T09:00:00Z' });
      const booking = await appointments.book(scenario.patient, { slotId: slot.id });
      await expect(appointments.list(scenario.patient, { limit: 20 })).resolves.toMatchObject({ items: [expect.objectContaining({ id: booking.id })] });
      await expect(appointments.cancel(scenario.clinician, booking.id, { withdrawSlot: true })).resolves.toMatchObject({ status: 'cancelled' });
      await expect(availability.withdraw(scenario.clinician, scenario.slot.id)).resolves.toMatchObject({ status: 'withdrawn' });
    });
  });
});

test('revokes direct and PUBLIC table, column and sequence grants to deny escalation and protected writes', async () => {
  await withTestDb(async (pool) => {
    const password = 'test-only-privileges-password';
    const { patient, clinician, slot } = await seedScenario(pool);
    await pool.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    // Both direct and inherited grants must be tightened by every provision run.
    await pool.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO portal_app, PUBLIC');
    await pool.query('GRANT UPDATE(role), INSERT(role) ON users TO portal_app, PUBLIC');
    await pool.query('GRANT SELECT(name) ON schema_migrations TO portal_app, PUBLIC');
    await pool.query('CREATE SEQUENCE privilege_probe');
    await pool.query('GRANT ALL ON SEQUENCE privilege_probe TO portal_app, PUBLIC');
    await migrate(pool, directory, (client) => provisionAppRole(client, password));
    await asApplication(pool, password, async (app) => {
      for (const [sql, values] of [
        ['CREATE TABLE forbidden_table(id int)', []],
        ["UPDATE users SET role='clinician' WHERE id=$1", [patient.id]],
        ["INSERT INTO users(cognito_sub,display_name,role) VALUES ('forged','Forged','clinician')", []],
        ["INSERT INTO clinician_profiles(user_id,biography,specialty,timezone) VALUES ($1,'x','x','UTC')", [patient.id]],
        ["UPDATE clinician_profiles SET biography='forged' WHERE user_id=$1", [clinician.id]],
        ['DELETE FROM users WHERE id=$1', [patient.id]],
        ['UPDATE availability_slots SET clinician_id=$1 WHERE id=$2', [clinician.id, slot.id]],
        ['SELECT * FROM schema_migrations', []],
        ['SELECT name FROM schema_migrations', []],
        ["SELECT nextval('privilege_probe')", []],
      ] as [string, string[]][]) await expect(app.query(sql, values)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query("SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS connect, has_schema_privilege(current_user,'public','USAGE') AS usage"))
        .resolves.toMatchObject({ rows: [{ connect: true, usage: true }] });
    });
  });
});

test('future migration-owned objects receive no PUBLIC privileges from global or schema defaults and no automatic app grants', async () => {
  await withTestDb(async (pool) => {
    const password = 'test-only-default-privileges-password';
    // Schema revocations alone cannot negate PostgreSQL's additive global defaults.
    await pool.query(`
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC;
    `);
    await migrate(pool, directory, (client) => provisionAppRole(client, password));
    await pool.query('CREATE TABLE future_table(id int); CREATE SEQUENCE future_sequence');
    await asApplication(pool, password, async (app) => {
      await expect(app.query('SELECT * FROM future_table')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query('INSERT INTO future_table(id) VALUES (1)')).rejects.toMatchObject({ code: '42501' });
      await expect(app.query("SELECT nextval('future_sequence')")).rejects.toMatchObject({ code: '42501' });
    });
  });
});

test('a failure after grants rolls back migrations, role password, database privileges and owner defaults together', async () => {
  await withEmptyTestDb(async (pool) => {
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    await pool.query(format('GRANT CREATE, TEMPORARY ON DATABASE %I TO PUBLIC, portal_app', database));
    await pool.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await pool.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO PUBLIC');
    const priorDatabaseAcl = (await pool.query('SELECT datacl::text AS acl FROM pg_database WHERE datname=current_database()')).rows[0].acl;
    const priorDefaults = (await pool.query('SELECT defaclnamespace, defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY defaclnamespace, defaclobjtype')).rows;
    await pool.query(format('ALTER ROLE portal_app PASSWORD %L', 'test-only-before-rollback'));
    const prior = (await pool.query("SELECT rolpassword FROM pg_authid WHERE rolname='portal_app'")).rows[0].rolpassword;
    await expect(migrate(pool, directory, async (client) => {
      // The callback owns the very connection that holds the migration lock.
      await expect(client.query('SELECT count(*)::int AS count FROM pg_locks WHERE pid=pg_backend_pid() AND locktype=\'advisory\' AND granted'))
        .resolves.toMatchObject({ rows: [{ count: 1 }] });
      await provisionAppRole(client, 'test-only-after-rollback');
      await expect(client.query("SELECT has_database_privilege('portal_app',current_database(),'TEMPORARY') AS allowed"))
        .resolves.toMatchObject({ rows: [{ allowed: false }] });
      throw new Error('injected grant failure');
    })).rejects.toThrow('injected grant failure');
    await expect(pool.query("SELECT to_regclass('public.users') AS users, to_regclass('public.schema_migrations') AS ledger"))
      .resolves.toMatchObject({ rows: [{ users: null, ledger: null }] });
    expect((await pool.query("SELECT rolpassword FROM pg_authid WHERE rolname='portal_app'")).rows[0].rolpassword).toBe(prior);
    await expect(pool.query("SELECT has_schema_privilege('portal_app','public','CREATE') AS allowed"))
      .resolves.toMatchObject({ rows: [{ allowed: true }] });
    expect((await pool.query('SELECT datacl::text AS acl FROM pg_database WHERE datname=current_database()')).rows[0].acl).toBe(priorDatabaseAcl);
    expect((await pool.query('SELECT defaclnamespace, defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY defaclnamespace, defaclobjtype')).rows).toEqual(priorDefaults);
    await expect(migrate(pool, directory, (client) => provisionAppRole(client, 'test-only-retry')))
      .resolves.toEqual(['001_initial.sql', '002_default_patient_role.sql']);
  });
});

test('can provision with a nonsuperuser database and schema owner like the RDS administrator', async () => {
  const owner = `portal_setup_test_${randomUUID().replaceAll('-', '')}`;
  await roleAdmin.query(format('CREATE ROLE %I NOLOGIN NOSUPERUSER CREATEDB CREATEROLE', owner));
  try {
    if (createdRole) await roleAdmin.query('DROP ROLE portal_app');
    await withEmptyTestDb(async (pool) => {
      const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
      await pool.query(format('ALTER DATABASE %I OWNER TO %I', database, owner));
      await pool.query(format('ALTER SCHEMA public OWNER TO %I', owner));
      if (!createdRole) await pool.query(format('GRANT portal_app TO %I WITH ADMIN OPTION', owner));
      const url = new URL(connectionString); url.pathname = `/${database}`;
      const ownerPool = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        await ownerPool.query(format('SET ROLE %I', owner));
        await expect(migrate(ownerPool, directory, (client) => provisionAppRole(client, 'Rds-like-test-password!234')))
          .resolves.toEqual(['001_initial.sql', '002_default_patient_role.sql']);
        await expect(migrate(ownerPool, directory, (client) => provisionAppRole(client, 'Rds-like-test-password!234'))).resolves.toEqual([]);
        await asApplication(pool, 'Rds-like-test-password!234', async (app) => {
          await expect(app.query('CREATE TEMP TABLE forbidden_temp(id int)')).rejects.toMatchObject({ code: '42501' });
          await expect(app.query("INSERT INTO users(cognito_sub,display_name) VALUES ('rds-patient','Patient') RETURNING role"))
            .resolves.toMatchObject({ rows: [{ role: 'patient' }] });
        });
      } finally { await ownerPool.end(); }
    });
  } finally { await roleAdmin.query(format('DROP ROLE %I', owner)); }
});
