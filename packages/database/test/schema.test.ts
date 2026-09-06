import { expect, test } from 'vitest';
import { insertClinician, insertUser, withTestDb } from './harness.js';

const clinicianId = '10000000-0000-4000-8000-000000000001';
const otherClinicianId = '10000000-0000-4000-8000-000000000002';
const patientId = '10000000-0000-4000-8000-000000000003';

const seedUsers = async (pool: Parameters<typeof insertUser>[0]) => {
  await insertUser(pool, { id: clinicianId, sub: 'clinician-sub', role: 'clinician' });
  await insertUser(pool, { id: otherClinicianId, sub: 'other-clinician-sub', role: 'clinician' });
  await insertUser(pool, { id: patientId, sub: 'patient-sub', role: 'patient' });
  await insertClinician(pool, clinicianId);
  await insertClinician(pool, otherClinicianId);
};

test('rejects a slot whose duration is not thirty minutes', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);

    await expect(
      pool.query(
        `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
         VALUES ('20000000-0000-4000-8000-000000000001', $1, '2030-06-02T09:00Z', '2030-06-02T09:45Z')`,
        [clinicianId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

test('enforces slot foreign keys', async () => {
  await withTestDb(async (pool) => {
    await expect(
      pool.query(
        `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
         VALUES ('20000000-0000-4000-8000-000000000002', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
        ['10000000-0000-4000-8000-000000000099'],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

test('rejects overlapping open slots for one clinician', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000003', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );

    await expect(
      pool.query(
        `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
         VALUES ('20000000-0000-4000-8000-000000000004', $1, '2030-06-02T09:15Z', '2030-06-02T09:45Z')`,
        [clinicianId],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});

test('allows overlapping open slots for different clinicians', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000005', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );

    await expect(
      pool.query(
        `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
         VALUES ('20000000-0000-4000-8000-000000000006', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
        [otherClinicianId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

test('allows adjacent open slots for one clinician', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000007', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );

    await expect(
      pool.query(
        `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
         VALUES ('20000000-0000-4000-8000-000000000008', $1, '2030-06-02T09:30Z', '2030-06-02T10:00Z')`,
        [clinicianId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

test('allows only one booked appointment per slot', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000009', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );
    await pool.query(
      `INSERT INTO appointments(id, slot_id, patient_id, status)
       VALUES ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000009', $1, 'booked')`,
      [patientId],
    );

    await expect(
      pool.query(
        `INSERT INTO appointments(id, slot_id, patient_id, status)
         VALUES ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000009', $1, 'booked')`,
        [patientId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

test('requires cancellation metadata only for cancelled appointments', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000010', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );

    await expect(
      pool.query(
        `INSERT INTO appointments(id, slot_id, patient_id, status)
         VALUES ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000010', $1, 'cancelled')`,
        [patientId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

test('rejects cancellation metadata on a booked appointment', async () => {
  await withTestDb(async (pool) => {
    await seedUsers(pool);
    await pool.query(
      `INSERT INTO availability_slots(id, clinician_id, start_at, end_at)
       VALUES ('20000000-0000-4000-8000-000000000011', $1, '2030-06-02T09:00Z', '2030-06-02T09:30Z')`,
      [clinicianId],
    );

    await expect(
      pool.query(
        `INSERT INTO appointments(id, slot_id, patient_id, status, cancelled_at, cancelled_by)
         VALUES ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000011', $1, 'booked', '2030-06-02T08:00Z', $1)`,
        [patientId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
