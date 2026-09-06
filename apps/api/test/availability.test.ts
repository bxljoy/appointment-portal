import { expect, test } from 'vitest';

import { seedScenario, withTestDb } from '../../../packages/database/test/harness.js';
import { makeAvailabilityService } from '../src/modules/availability/service.js';

const clock = () => new Date('2030-06-01T09:00:00.000Z');
const window = { from: '2030-06-01T00:00:00Z', to: '2030-06-05T00:00:00Z', limit: 20 };

test('rejects a patient publishing availability and validates future minute-bound slots', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician } = await seedScenario(pool);
    const service = makeAvailabilityService({ pool, clock });

    await expect(service.create(patient, { startAt: '2030-06-03T09:00:00Z' })).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expect(service.listOwn(patient, window)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(service.create(clinician, { startAt: '2030-06-01T09:00:00Z' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.create(clinician, { startAt: '2030-06-03T09:00:01Z' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.create(clinician, { startAt: '2030-06-03T09:00:00.001Z' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.create(clinician, { startAt: '2030-06-03T09:00:00Z' })).resolves.toMatchObject({
      clinicianId: clinician.id,
      startAt: '2030-06-03T09:00:00.000Z',
      endAt: '2030-06-03T09:30:00.000Z',
      status: 'open',
      isBooked: false,
    });
  });
});

test('maps overlapping clinician slots to a stable conflict', async () => {
  await withTestDb(async (pool) => {
    const { clinician } = await seedScenario(pool);
    const service = makeAvailabilityService({ pool, clock });

    await service.create(clinician, { startAt: '2030-06-03T09:00:00Z' });
    await expect(service.create(clinician, { startAt: '2030-06-03T09:15:00Z' })).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_OVERLAP',
    });
  });
});

test('lists only a clinician’s own slots with booking state and a time cursor', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, slot } = await seedScenario(pool);
    await pool.query(
      'INSERT INTO appointments(slot_id, patient_id, status) VALUES ($1, $2, $3)',
      [slot.id, patient.id, 'booked'],
    );
    const service = makeAvailabilityService({ pool, clock });

    const firstPage = await service.listOwn(clinician, { ...window, limit: 1 });
    expect(firstPage.items).toEqual([expect.objectContaining({ id: slot.id, isBooked: true })]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await service.listOwn(clinician, { ...window, limit: 20, cursor: firstPage.nextCursor ?? undefined });
    expect(secondPage.items).toEqual([expect.objectContaining({ isBooked: false })]);
  });
});

test('does not reveal withdrawn or booked slots in public availability', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, slot } = await seedScenario(pool);
    await pool.query(
      'INSERT INTO appointments(slot_id, patient_id, status) VALUES ($1, $2, $3)',
      [slot.id, patient.id, 'booked'],
    );
    const service = makeAvailabilityService({ pool, clock });
    const withdrawn = await service.create(clinician, { startAt: '2030-06-03T09:00:00Z' });
    await service.withdraw(clinician, withdrawn.id);

    const publicSlots = await service.listPublic(patient, clinician.id, window);
    expect(publicSlots.items.map((item) => item.id)).not.toContain(slot.id);
    expect(publicSlots.items.map((item) => item.id)).not.toContain(withdrawn.id);
    expect(publicSlots.items).toEqual([expect.objectContaining({ startAt: '2030-06-02T09:30:00.000Z' })]);
  });
});

test('hides other clinicians’ slots on withdrawal and safely rejects booked slots', async () => {
  await withTestDb(async (pool) => {
    const { patient, clinician, otherClinician, slot } = await seedScenario(pool);
    const service = makeAvailabilityService({ pool, clock });

    await expect(service.withdraw(otherClinician, slot.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await pool.query(
      'INSERT INTO appointments(slot_id, patient_id, status) VALUES ($1, $2, $3)',
      [slot.id, patient.id, 'booked'],
    );
    await expect(service.withdraw(clinician, slot.id)).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });

    const own = await service.create(clinician, { startAt: '2030-06-03T09:00:00Z' });
    await expect(service.withdraw(clinician, own.id)).resolves.toMatchObject({ id: own.id, status: 'withdrawn' });
    await expect(service.withdraw(clinician, own.id)).resolves.toMatchObject({ id: own.id, status: 'withdrawn' });
    await expect(service.withdraw(otherClinician, own.id)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

test('does not withdraw a slot once its start time has passed', async () => {
  await withTestDb(async (pool) => {
    const { clinician, slot } = await seedScenario(pool);
    const service = makeAvailabilityService({ pool, clock: () => new Date('2030-06-02T09:00:00.000Z') });

    await expect(service.withdraw(clinician, slot.id)).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });
  });
});
