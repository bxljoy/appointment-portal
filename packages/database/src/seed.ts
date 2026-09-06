import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { Role } from '@portal/contracts';
import { migrate } from './migrate.js';

export type SeedUser = {
  sub: string;
  displayName: string;
  role: Role;
  timezone?: string;
};

export const seedDemo = async (pool: Pool, users: SeedUser[], now: Date): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const user of users) {
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users(cognito_sub, display_name, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (cognito_sub) DO UPDATE
           SET display_name = EXCLUDED.display_name, role = EXCLUDED.role
         RETURNING id`,
        [user.sub, user.displayName, user.role],
      );

      if (user.role === 'clinician') {
        const clinicianId = userResult.rows[0]?.id;
        if (!clinicianId) throw new Error(`Could not seed clinician ${user.sub}`);
        await client.query(
          `INSERT INTO clinician_profiles(user_id, biography, specialty, timezone)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
          [clinicianId, 'Demo clinician', 'General medicine', user.timezone ?? 'Europe/Stockholm'],
        );
        await client.query(
          `INSERT INTO availability_slots(clinician_id, start_at, end_at)
           SELECT $1, $2::timestamptz + slot_offset, $2::timestamptz + slot_offset + interval '30 minutes'
           FROM unnest(ARRAY[interval '1 day', interval '1 day 30 minutes']) AS offsets(slot_offset)
           WHERE NOT EXISTS (
             SELECT 1 FROM availability_slots
             WHERE clinician_id = $1 AND start_at = $2::timestamptz + slot_offset
           )`,
          [clinicianId, now.toISOString()],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const runCli = async (): Promise<void> => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(pool, fileURLToPath(new URL('../migrations', import.meta.url)));
    await seedDemo(
      pool,
      [
        { sub: 'demo-patient', displayName: 'Demo Patient', role: 'patient' },
        { sub: 'demo-clinician', displayName: 'Demo Clinician', role: 'clinician' },
      ],
      new Date(),
    );
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
