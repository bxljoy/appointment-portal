import type { Clinician, Me } from '@portal/contracts';
import type { Pool } from 'pg';

import type { Actor } from '../../shared/types.js';

type UserRow = {
  id: string;
  display_name: string;
  role: 'patient' | 'clinician';
};

type ClinicianRow = {
  id: string;
  display_name: string;
  biography: string;
  specialty: string;
  timezone: string;
};

export const ensureUser = async (pool: Pool, actor: Actor): Promise<Me> => {
  await pool.query(
    `INSERT INTO users(cognito_sub, display_name)
     VALUES ($1, $2)
     ON CONFLICT (cognito_sub) DO NOTHING`,
    [actor.sub, 'Patient'],
  );

  const result = await pool.query<UserRow>(
    `SELECT id, display_name, role
     FROM users
     WHERE cognito_sub = $1`,
    [actor.sub],
  );
  const user = result.rows[0];
  if (!user) {
    throw new Error('Identity mapping was not created');
  }

  return toMe(user);
};

export const findClinicians = async (
  pool: Pool,
  cursor: { sortValue: string; id: string } | undefined,
  limit: number,
): Promise<Clinician[]> => {
  const result = await pool.query<ClinicianRow>(
    `SELECT users.id, users.display_name, clinician_profiles.biography,
            clinician_profiles.specialty, clinician_profiles.timezone
     FROM clinician_profiles
     JOIN users ON users.id = clinician_profiles.user_id
     WHERE ($1::text IS NULL OR (users.display_name, users.id) > ($1::text, $2::uuid))
     ORDER BY users.display_name ASC, users.id ASC
     LIMIT $3`,
    [cursor?.sortValue ?? null, cursor?.id ?? null, limit],
  );

  return result.rows.map(toClinician);
};

export const findClinicianById = async (pool: Pool, id: string): Promise<Clinician | undefined> => {
  const result = await pool.query<ClinicianRow>(
    `SELECT users.id, users.display_name, clinician_profiles.biography,
            clinician_profiles.specialty, clinician_profiles.timezone
     FROM clinician_profiles
     JOIN users ON users.id = clinician_profiles.user_id
     WHERE users.id = $1`,
    [id],
  );

  const clinician = result.rows[0];
  return clinician ? toClinician(clinician) : undefined;
};

const toMe = (row: UserRow): Me => ({
  id: row.id,
  displayName: row.display_name,
  role: row.role,
});

const toClinician = (row: ClinicianRow): Clinician => ({
  id: row.id,
  displayName: row.display_name,
  biography: row.biography,
  specialty: row.specialty,
  timezone: row.timezone,
});
