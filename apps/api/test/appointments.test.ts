import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';

import { seedScenario, withTestDb } from '../../../packages/database/test/harness.js';
import { makeAppointmentsService } from '../src/modules/appointments/service.js';
import { inTransaction } from '../src/shared/database.js';

const clock = () => new Date('2030-06-01T09:00:00.000Z');

test('books a future open slot for a patient and returns its joined representation', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });

    await expect(service.book(patient, { slotId: slot.id })).resolves.toMatchObject({
      slotId: slot.id,
      clinicianId: clinician.id,
      patientId: patient.id,
      patientDisplayName: 'Patient',
      clinicianDisplayName: 'Clinician',
      startAt: '2030-06-02T09:00:00.000Z',
      endAt: '2030-06-02T09:30:00.000Z',
      status: 'booked',
      cancelledAt: null,
      cancelledBy: null,
    });
  });
});

test('rejects clinician booking and missing, withdrawn, past, or occupied slots safely', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, clinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });

    await expect(service.book(clinician, { slotId: slot.id })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expect(service.book(patient, { slotId: randomUUID() })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });

    await pool.query("UPDATE availability_slots SET status='withdrawn' WHERE id=$1", [slot.id]);
    await expect(service.book(patient, { slotId: slot.id })).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });

    await pool.query(
      "UPDATE availability_slots SET status='open', start_at=$2, end_at=$2::timestamptz + interval '30 minutes' WHERE id=$1",
      [slot.id, '2030-06-01T09:00:00Z'],
    );
    await expect(service.book(patient, { slotId: slot.id })).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });

    await pool.query(
      "UPDATE availability_slots SET start_at=$2, end_at=$2::timestamptz + interval '30 minutes' WHERE id=$1",
      [slot.id, '2030-06-04T09:00:00Z'],
    );
    await service.book(patient, { slotId: slot.id });
    await expect(service.book(secondPatient, { slotId: slot.id })).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });
  });
});

test('lists only patient-owned or clinician-assigned appointments with descending pagination', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, clinician, otherClinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });
    const first = await service.book(patient, { slotId: slot.id });
    const secondSlot = await pool.query<{ id: string }>(
      `SELECT id FROM availability_slots
       WHERE clinician_id=$1 AND id<>$2
       ORDER BY start_at DESC LIMIT 1`,
      [clinician.id, slot.id],
    );
    const second = await service.book(secondPatient, { slotId: secondSlot.rows[0]!.id });

    const patientPage = await service.list(patient, { limit: 1 });
    expect(patientPage).toEqual({ items: [expect.objectContaining({ id: first.id })], nextCursor: null });
    expect((await service.list(secondPatient, { limit: 1 })).items).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
    expect((await service.list(otherClinician, { limit: 20 })).items).toEqual([]);

    const clinicianPage = await service.list(clinician, { limit: 1 });
    expect(clinicianPage.items).toEqual([expect.objectContaining({ id: second.id })]);
    expect(clinicianPage.nextCursor).toEqual(expect.any(String));
    expect(
      (await service.list(clinician, { limit: 1, cursor: clinicianPage.nextCursor ?? undefined })).items,
    ).toEqual([expect.objectContaining({ id: first.id })]);
    await expect(service.list(clinician, { limit: 0 })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.list(clinician, { limit: 20, cursor: 'invalid' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });
});

test('allows only the owner or assigned clinician to cancel before start', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, clinician, otherClinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });
    const appointment = await service.book(patient, { slotId: slot.id });

    await expect(service.cancel(secondPatient, appointment.id, { withdrawSlot: false })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    await expect(service.cancel(otherClinician, appointment.id, { withdrawSlot: false })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    await expect(service.cancel(clinician, appointment.id, { withdrawSlot: false })).resolves.toMatchObject({
      id: appointment.id,
      status: 'cancelled',
      cancelledAt: '2030-06-01T09:00:00.000Z',
      cancelledBy: clinician.id,
    });
  });
});

test('rejects started cancellation and patient withdrawal without changing the booking', async () => {
  await withTestDb(async (pool) => {
    const { patient, slot } = await seedScenario(pool);
    const bookingService = makeAppointmentsService({ pool, clock });
    const appointment = await bookingService.book(patient, { slotId: slot.id });

    await expect(bookingService.cancel(patient, appointment.id, { withdrawSlot: true })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expect(pool.query('SELECT status FROM appointments WHERE id=$1', [appointment.id])).resolves.toMatchObject({
      rows: [{ status: 'booked' }],
    });

    const startedService = makeAppointmentsService({
      pool,
      clock: () => new Date('2030-06-02T09:00:00.000Z'),
    });
    await expect(startedService.cancel(patient, appointment.id, { withdrawSlot: false })).rejects.toMatchObject({
      status: 409,
      code: 'APPOINTMENT_STARTED',
    });
  });
});

test('keeps cancelled history immutable across rebooking and repeated cancellation', async () => {
  await withTestDb(async (pool) => {
    const { patient, secondPatient, clinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });
    const original = await service.book(patient, { slotId: slot.id });
    const firstCancellation = await service.cancel(patient, original.id, { withdrawSlot: false });
    const replacement = await service.book(secondPatient, { slotId: slot.id });

    await expect(service.cancel(patient, original.id, { withdrawSlot: false })).resolves.toEqual(firstCancellation);
    await expect(service.cancel(clinician, original.id, { withdrawSlot: true })).resolves.toEqual(firstCancellation);
    await expect(pool.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).resolves.toMatchObject({
      rows: [{ status: 'open' }],
    });
    await expect(pool.query('SELECT status FROM appointments WHERE id=$1', [replacement.id])).resolves.toMatchObject({
      rows: [{ status: 'booked' }],
    });

    const patientHistory = await service.list(patient, { limit: 20 });
    expect(patientHistory.items).toEqual([firstCancellation]);
    const replacementOwner = await service.list(secondPatient, { limit: 20 });
    expect(replacementOwner.items).toEqual([replacement]);
  });
});

test('cancels and withdraws atomically for the assigned clinician', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, slot } = await seedScenario(pool);
    const service = makeAppointmentsService({ pool, clock });
    const appointment = await service.book(patient, { slotId: slot.id });

    await expect(service.cancel(clinician, appointment.id, { withdrawSlot: true })).resolves.toMatchObject({
      id: appointment.id,
      status: 'cancelled',
      cancelledBy: clinician.id,
    });
    await expect(pool.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).resolves.toMatchObject({
      rows: [{ status: 'withdrawn' }],
    });
  });
});

test('does not disguise an unrelated appointment unique violation as slot unavailability', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, slot } = await seedScenario(pool);
    const otherSlot = await pool.query<{ id: string }>(
      'SELECT id FROM availability_slots WHERE clinician_id=$1 AND id<>$2 LIMIT 1',
      [clinician.id, slot.id],
    );
    await pool.query(
      "INSERT INTO appointments(slot_id, patient_id, status, cancelled_at, cancelled_by) VALUES ($1,$2,'cancelled',$3,$2)",
      [otherSlot.rows[0]!.id, patient.id, clock().toISOString()],
    );
    await pool.query('CREATE UNIQUE INDEX unrelated_patient_booking_test ON appointments(patient_id)');
    const service = makeAppointmentsService({ pool, clock });

    await expect(service.book(patient, { slotId: slot.id })).rejects.toMatchObject({
      code: '23505',
      constraint: 'unrelated_patient_booking_test',
    });
  });
});

test('rolls back and releases a transaction client on callback failure', async () => {
  await withTestDb(async (pool) => {
    const userId = randomUUID();
    await expect(
      inTransaction(pool, async (client) => {
        await client.query(
          "INSERT INTO users(id,cognito_sub,display_name,role) VALUES ($1,'rolled-back','Rolled Back','patient')",
          [userId],
        );
        throw new Error('expected callback failure');
      }),
    ).rejects.toThrow('expected callback failure');
    await expect(pool.query('SELECT id FROM users WHERE id=$1', [userId])).resolves.toMatchObject({ rowCount: 0 });
    expect(pool.idleCount).toBe(pool.totalCount);
  });
});
