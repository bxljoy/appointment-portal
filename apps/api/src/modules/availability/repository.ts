import type { Slot } from '@portal/contracts';
import type { Pool, PoolClient } from 'pg';

type SlotRow = {
  id: string;
  clinician_id: string;
  start_at: Date;
  end_at: Date;
  status: 'open' | 'withdrawn';
  is_booked: boolean;
};

const slotColumns = `
  s.id,
  s.clinician_id,
  s.start_at,
  s.end_at,
  s.status,
  EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.slot_id = s.id AND a.status = 'booked'
  ) AS is_booked`;

export const insertSlot = async (pool: Pool, clinicianId: string, startAt: Date): Promise<Slot> => {
  const endAt = new Date(startAt.getTime() + 30 * 60 * 1_000);
  const result = await pool.query<SlotRow>(
    `INSERT INTO availability_slots(clinician_id, start_at, end_at)
     VALUES ($1, $2, $3)
     RETURNING id, clinician_id, start_at, end_at, status, false AS is_booked`,
    [clinicianId, startAt.toISOString(), endAt.toISOString()],
  );
  return toSlot(result.rows[0]!);
};

export const findPublicSlots = async (
  pool: Pool,
  clinicianId: string,
  now: Date,
  window: { from: string; to: string },
  cursor: { sortValue: string; id: string } | undefined,
  limit: number,
): Promise<Slot[]> => {
  const result = await pool.query<SlotRow>(
    `SELECT ${slotColumns}
     FROM availability_slots s
     WHERE s.clinician_id = $1
       AND s.status = 'open'
       AND s.start_at > $2::timestamptz
       AND s.start_at >= $3::timestamptz
       AND s.start_at < $4::timestamptz
       AND ($5::timestamptz IS NULL OR (s.start_at, s.id) > ($5::timestamptz, $6::uuid))
       AND NOT EXISTS (
         SELECT 1
         FROM appointments a
         WHERE a.slot_id = s.id AND a.status = 'booked'
       )
     ORDER BY s.start_at ASC, s.id ASC
     LIMIT $7`,
    [
      clinicianId,
      now.toISOString(),
      window.from,
      window.to,
      cursor?.sortValue ?? null,
      cursor?.id ?? null,
      limit,
    ],
  );
  return result.rows.map(toSlot);
};

export const findOwnSlots = async (
  pool: Pool,
  clinicianId: string,
  window: { from: string; to: string },
  cursor: { sortValue: string; id: string } | undefined,
  limit: number,
): Promise<Slot[]> => {
  const result = await pool.query<SlotRow>(
    `SELECT ${slotColumns}
     FROM availability_slots s
     WHERE s.clinician_id = $1
       AND s.start_at >= $2::timestamptz
       AND s.start_at < $3::timestamptz
       AND ($4::timestamptz IS NULL OR (s.start_at, s.id) > ($4::timestamptz, $5::uuid))
     ORDER BY s.start_at ASC, s.id ASC
     LIMIT $6`,
    [clinicianId, window.from, window.to, cursor?.sortValue ?? null, cursor?.id ?? null, limit],
  );
  return result.rows.map(toSlot);
};

export const lockSlot = async (client: PoolClient, slotId: string): Promise<Slot | undefined> => {
  const result = await client.query<SlotRow>(
    `SELECT ${slotColumns}
     FROM availability_slots s
     WHERE s.id = $1
     FOR UPDATE OF s`,
    [slotId],
  );
  const row = result.rows[0];
  return row ? toSlot(row) : undefined;
};

export const withdrawSlot = async (client: PoolClient, slotId: string): Promise<Slot> => {
  const result = await client.query<SlotRow>(
    `UPDATE availability_slots s
     SET status = 'withdrawn'
     WHERE s.id = $1
     RETURNING s.id, s.clinician_id, s.start_at, s.end_at, s.status, false AS is_booked`,
    [slotId],
  );
  return toSlot(result.rows[0]!);
};

const toSlot = (row: SlotRow): Slot => ({
  id: row.id,
  clinicianId: row.clinician_id,
  startAt: row.start_at.toISOString(),
  endAt: row.end_at.toISOString(),
  status: row.status,
  isBooked: row.is_booked,
});
