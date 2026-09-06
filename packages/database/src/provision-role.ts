import type { PoolClient } from 'pg';
import format from 'pg-format';

export const provisionAppRole = async (client: PoolClient, password: string): Promise<void> => {
  if (!password || password.includes('\0')) throw new Error('Invalid application password.');
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal_app') THEN
      CREATE ROLE portal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal_app' AND (rolsuper OR rolreplication OR rolbypassrls))
       OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'portal_app'::regrole) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Unsafe existing application role.';
    END IF;
  END $$`);
  // RDS admins are not true SUPERUSERs. Even ALTER ... NOSUPERUSER is forbidden;
  // assert those immutable safe flags above, then change only permitted attributes.
  await client.query(format('ALTER ROLE portal_app LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', password));
  // The database identifier comes from this connection, never a caller-supplied name.
  const database = await client.query<{ name: string }>('SELECT current_database() AS name');
  await client.query(format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, portal_app', database.rows[0]!.name));
  await client.query(format('GRANT CONNECT ON DATABASE %I TO portal_app', database.rows[0]!.name));
  await client.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON SCHEMA public FROM portal_app;
    GRANT USAGE ON SCHEMA public TO portal_app;
    -- This disposable database's public schema belongs exclusively to migrations.
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM portal_app, PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM portal_app, PUBLIC;
    -- Reset the named application columns explicitly before restoring the allowlist.
    REVOKE ALL (id, cognito_sub, display_name, role, created_at) ON users FROM portal_app, PUBLIC;
    REVOKE ALL (user_id, biography, specialty, timezone, created_at) ON clinician_profiles FROM portal_app, PUBLIC;
    REVOKE ALL (id, clinician_id, start_at, end_at, status, created_at) ON availability_slots FROM portal_app, PUBLIC;
    REVOKE ALL (id, slot_id, patient_id, status, cancelled_at, cancelled_by, created_at) ON appointments FROM portal_app, PUBLIC;
    -- Only the migration owner's defaults in this database; schema-only REVOKE
    -- cannot remove an additive global default grant.
    ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
    GRANT SELECT ON users, clinician_profiles, availability_slots, appointments TO portal_app;
    GRANT INSERT (cognito_sub, display_name) ON users TO portal_app;
    GRANT INSERT (clinician_id, start_at, end_at), UPDATE (status) ON availability_slots TO portal_app;
    GRANT INSERT (slot_id, patient_id, status), UPDATE (status, cancelled_at, cancelled_by) ON appointments TO portal_app;
  `);
  // UUID defaults use no sequence. Future tables/sequences receive no automatic grants.
};
