import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { Slot } from '@portal/contracts';
import { migrate } from '../src/migrate.js';
import { seedDemo } from '../src/seed.js';

const adminConnectionString =
  process.env.DATABASE_URL ?? 'postgres://portal:portal@127.0.0.1:54329/portal';

const withIsolatedDb = async (
  run: (pool: Pool) => Promise<void>,
  migrateDatabase: boolean,
): Promise<void> => {
  const database = `portal_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: adminConnectionString });
  const databaseUrl = new URL(adminConnectionString);
  databaseUrl.pathname = `/${database}`;

  try {
    await adminPool.query(`CREATE DATABASE ${database}`);
    const pool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      if (migrateDatabase) {
        await migrate(pool, fileURLToPath(new URL('../migrations', import.meta.url)));
      }
      await run(pool);
    } finally {
      await pool.end();
    }
  } finally {
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }
};

export const withTestDb = (run: (pool: Pool) => Promise<void>): Promise<void> =>
  withIsolatedDb(run, true);

export const withEmptyTestDb = (run: (pool: Pool) => Promise<void>): Promise<void> =>
  withIsolatedDb(run, false);

export const insertUser = async (
  pool: Pool,
  values: { id: string; sub: string; role: 'patient' | 'clinician' },
): Promise<void> => {
  await pool.query(
    'INSERT INTO users(id, cognito_sub, display_name, role) VALUES ($1, $2, $3, $4)',
    [values.id, values.sub, values.sub, values.role],
  );
};

export const insertClinician = async (pool: Pool, id: string): Promise<void> => {
  await pool.query(
    'INSERT INTO clinician_profiles(user_id, biography, specialty, timezone) VALUES ($1, $2, $3, $4)',
    [id, 'A clinician', 'General medicine', 'Europe/Stockholm'],
  );
};

export type ScenarioActor = { sub: string; id: string };

export const seedScenario = async (
  pool: Pool,
): Promise<{
  patient: ScenarioActor;
  secondPatient: ScenarioActor;
  clinician: ScenarioActor;
  otherClinician: ScenarioActor;
  slot: Slot;
}> => {
  const users = [
    { sub: 'patient', displayName: 'Patient', role: 'patient' as const },
    { sub: 'second-patient', displayName: 'Second Patient', role: 'patient' as const },
    { sub: 'clinician', displayName: 'Clinician', role: 'clinician' as const },
    { sub: 'other-clinician', displayName: 'Other Clinician', role: 'clinician' as const },
  ];
  await seedDemo(pool, users, new Date('2030-06-01T09:00:00.000Z'));
  const result = await pool.query<{ id: string; cognito_sub: string }>(
    'SELECT id, cognito_sub FROM users WHERE cognito_sub = ANY($1::text[])',
    [users.map((user) => user.sub)],
  );
  const bySub = new Map(result.rows.map((row) => [row.cognito_sub, { id: row.id, sub: row.cognito_sub }]));
  const slotResult = await pool.query<{
    id: string;
    clinician_id: string;
    start_at: Date;
    end_at: Date;
    status: 'open' | 'withdrawn';
  }>(
    `SELECT id, clinician_id, start_at, end_at, status
     FROM availability_slots
     WHERE clinician_id = $1
     ORDER BY start_at
     LIMIT 1`,
    [bySub.get('clinician')?.id],
  );
  const slot = slotResult.rows[0];
  const patient = bySub.get('patient');
  const secondPatient = bySub.get('second-patient');
  const clinician = bySub.get('clinician');
  const otherClinician = bySub.get('other-clinician');
  if (!slot || !patient || !secondPatient || !clinician || !otherClinician) {
    throw new Error('Seed scenario was incomplete');
  }

  return {
    patient,
    secondPatient,
    clinician,
    otherClinician,
    slot: {
      id: slot.id,
      clinicianId: slot.clinician_id,
      startAt: slot.start_at.toISOString(),
      endAt: slot.end_at.toISOString(),
      status: slot.status,
      isBooked: false,
    },
  };
};
