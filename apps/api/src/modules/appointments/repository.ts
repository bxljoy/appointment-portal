import type { Appointment } from '@portal/contracts';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

type AppointmentRow = {
  id: string;
  slot_id: string;
  clinician_id: string;
  patient_id: string;
  patient_display_name: string;
  clinician_display_name: string;
  start_at: Date;
  end_at: Date;
  status: 'booked' | 'cancelled';
  cancelled_at: Date | null;
  cancelled_by: string | null;
};

export type LockedAppointment = {
  id: string;
  slotId: string;
  patientId: string;
  status: 'booked' | 'cancelled';
};

const joinedColumns = `
  a.id,
  a.slot_id,
  s.clinician_id,
  a.patient_id,
  patient.display_name AS patient_display_name,
  clinician.display_name AS clinician_display_name,
  s.start_at,
  s.end_at,
  a.status,
  a.cancelled_at,
  a.cancelled_by`;

export const findAppointments = async (
  pool: Pool,
  user: { id: string; role: 'patient' | 'clinician' },
  cursor: { sortValue: string; id: string } | undefined,
  limit: number,
): Promise<Appointment[]> => {
  const result = await pool.query<AppointmentRow>(
    `SELECT ${joinedColumns}
     FROM appointments a
     JOIN availability_slots s ON s.id = a.slot_id
     JOIN users patient ON patient.id = a.patient_id
     JOIN users clinician ON clinician.id = s.clinician_id
     WHERE (($1 = 'patient' AND a.patient_id = $2)
         OR ($1 = 'clinician' AND s.clinician_id = $2))
       AND ($3::timestamptz IS NULL OR (s.start_at, a.id) < ($3::timestamptz, $4::uuid))
     ORDER BY s.start_at DESC, a.id DESC
     LIMIT $5`,
    [user.role, user.id, cursor?.sortValue ?? null, cursor?.id ?? null, limit],
  );
  return result.rows.map(toAppointment);
};

export const findAppointment = async (
  client: Queryable,
  appointmentId: string,
): Promise<Appointment | undefined> => {
  const result = await client.query<AppointmentRow>(
    `SELECT ${joinedColumns}
     FROM appointments a
     JOIN availability_slots s ON s.id = a.slot_id
     JOIN users patient ON patient.id = a.patient_id
     JOIN users clinician ON clinician.id = s.clinician_id
     WHERE a.id = $1`,
    [appointmentId],
  );
  const row = result.rows[0];
  return row ? toAppointment(row) : undefined;
};

export const findAppointmentSlotId = async (
  client: PoolClient,
  appointmentId: string,
): Promise<string | undefined> => {
  const result = await client.query<{ slot_id: string }>('SELECT slot_id FROM appointments WHERE id = $1', [
    appointmentId,
  ]);
  return result.rows[0]?.slot_id;
};

export const lockAppointment = async (
  client: PoolClient,
  appointmentId: string,
): Promise<LockedAppointment | undefined> => {
  const result = await client.query<{
    id: string;
    slot_id: string;
    patient_id: string;
    status: 'booked' | 'cancelled';
  }>(
    `SELECT id, slot_id, patient_id, status
     FROM appointments
     WHERE id = $1
     FOR UPDATE`,
    [appointmentId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, slotId: row.slot_id, patientId: row.patient_id, status: row.status }
    : undefined;
};

export const insertAppointment = async (
  client: PoolClient,
  slotId: string,
  patientId: string,
): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `INSERT INTO appointments(slot_id, patient_id, status)
     VALUES ($1, $2, 'booked')
     RETURNING id`,
    [slotId, patientId],
  );
  return result.rows[0]!.id;
};

export const cancelAppointment = async (
  client: PoolClient,
  appointmentId: string,
  cancelledAt: Date,
  cancelledBy: string,
): Promise<void> => {
  await client.query(
    `UPDATE appointments
     SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3
     WHERE id = $1`,
    [appointmentId, cancelledAt.toISOString(), cancelledBy],
  );
};

const toAppointment = (row: AppointmentRow): Appointment => ({
  id: row.id,
  slotId: row.slot_id,
  clinicianId: row.clinician_id,
  patientId: row.patient_id,
  patientDisplayName: row.patient_display_name,
  clinicianDisplayName: row.clinician_display_name,
  startAt: row.start_at.toISOString(),
  endAt: row.end_at.toISOString(),
  status: row.status,
  cancelledAt: row.cancelled_at?.toISOString() ?? null,
  cancelledBy: row.cancelled_by,
});
