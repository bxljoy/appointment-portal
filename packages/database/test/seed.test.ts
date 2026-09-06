import { expect, test } from 'vitest';
import { seedDemo } from '../src/seed.js';
import { seedScenario, withTestDb } from './harness.js';

test('upserts demo users and creates stable future slots from the supplied clock', async () => {
  await withTestDb(async (pool) => {
    const now = new Date('2030-06-01T09:00:00.000Z');
    const users = [
      { sub: 'seed-patient', displayName: 'Seed Patient', role: 'patient' as const },
      { sub: 'seed-clinician', displayName: 'Seed Clinician', role: 'clinician' as const },
    ];

    await seedDemo(pool, users, now);
    await seedDemo(pool, users, now);

    await expect(
      pool.query(
        `SELECT start_at
         FROM availability_slots
         JOIN users ON users.id = availability_slots.clinician_id
         WHERE users.cognito_sub = $1
         ORDER BY start_at`,
        ['seed-clinician'],
      ),
    ).resolves.toMatchObject({
      rows: [{ start_at: new Date('2030-06-02T09:00:00.000Z') }, { start_at: new Date('2030-06-02T09:30:00.000Z') }],
    });
  });
});

test('provides actors and a fixed slot for service integration tests', async () => {
  await withTestDb(async (pool) => {
    const scenario = await seedScenario(pool);

    expect(scenario.patient.sub).toBe('patient-a');
    expect(scenario.secondPatient.id).not.toBe(scenario.patient.id);
    expect(scenario.slot).toMatchObject({
      clinicianId: scenario.clinician.id,
      startAt: '2030-06-02T09:00:00.000Z',
      endAt: '2030-06-02T09:30:00.000Z',
      status: 'open',
      isBooked: false,
    });
  });
});
