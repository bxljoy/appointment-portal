import { expect, test } from 'vitest';

import { seedScenario, withTestDb } from '../../../packages/database/test/harness.js';
import { makeAppointmentsService } from '../src/modules/appointments/service.js';

const waitForLock = async (pool: Parameters<typeof seedScenario>[0], queryFragment: string) => {
  await expect.poll(
    async () => {
      const result = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE datname=current_database()
           AND wait_event_type='Lock'
           AND query LIKE $1`,
        [`%${queryFragment}%`],
      );
      return result.rows[0]?.count ?? 0;
    },
    { timeout: 2_000, interval: 20 },
  ).toBeGreaterThan(0);
};

test('persists exactly one active booking for competing patients', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock: () => new Date('2030-06-01T09:00Z') });
    const result = await Promise.allSettled([
      service.book(patient, { slotId: slot.id }),
      service.book(secondPatient, { slotId: slot.id }),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(result.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { status: 409, code: 'SLOT_UNAVAILABLE' },
    });
    const count = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM appointments WHERE slot_id=$1 AND status='booked'",
      [slot.id],
    );
    expect(count.rows[0]!.n).toBe(1);
  });
});

test('checks trusted time only after a contended booking acquires the slot lock', async () => {
  await withTestDb(async (pool) => {
    const { patient, slot } = await seedScenario(pool);
    const blocker = await pool.connect();
    let rolledBack = false;
    let now = new Date('2030-06-01T09:00:00.000Z');

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM availability_slots WHERE id=$1 FOR UPDATE', [slot.id]);
      const service = makeAppointmentsService({ pool, clock: () => now });
      const booking = service.book(patient, { slotId: slot.id });
      await waitForLock(pool, 'availability_slots');

      now = new Date(slot.startAt);
      await blocker.query('ROLLBACK');
      rolledBack = true;
      await expect(booking).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
      await expect(pool.query('SELECT id FROM appointments WHERE slot_id=$1', [slot.id])).resolves.toMatchObject({
        rowCount: 0,
      });
    } finally {
      if (!rolledBack) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

test('serializes clinician cancellation with withdrawal ahead of a competing rebooking', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, clinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock: () => new Date('2030-06-01T09:00Z') });
    const appointment = await service.book(patient, { slotId: slot.id });
    const blocker = await pool.connect();
    let committed = false;

    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE', [appointment.id]);
      const cancellation = service.cancel(clinician, appointment.id, { withdrawSlot: true });
      await waitForLock(pool, 'appointments');

      const booking = service.book(secondPatient, { slotId: slot.id });
      await waitForLock(pool, 'availability_slots');
      await blocker.query('COMMIT');
      committed = true;

      await expect(cancellation).resolves.toMatchObject({ id: appointment.id, status: 'cancelled' });
      await expect(booking).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
      await expect(pool.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).resolves.toMatchObject({
        rows: [{ status: 'withdrawn' }],
      });
      await expect(
        pool.query("SELECT count(*)::int AS n FROM appointments WHERE slot_id=$1 AND status='booked'", [slot.id]),
      ).resolves.toMatchObject({ rows: [{ n: 0 }] });
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});
