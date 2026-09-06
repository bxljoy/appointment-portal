import { expect, test } from 'vitest';

import { seedScenario, withTestDb } from '../../../packages/database/test/harness.js';
import { AppError } from '../src/shared/errors.js';
import { makeProfilesService } from '../src/modules/profiles/service.js';

const clock = () => new Date('2030-06-01T09:00:00.000Z');

test('creates a new identity once as a patient', async () => {
  await withTestDb(async (pool) => {
    const service = makeProfilesService({ pool, clock });
    const actor = { sub: 'new-cognito-sub' };
    const [a, b] = await Promise.all([service.getMe(actor), service.getMe(actor)]);

    expect(a).toEqual(b);
    expect(a).toMatchObject({ displayName: 'Patient', role: 'patient' });
    await expect(pool.query('SELECT cognito_sub FROM users WHERE cognito_sub = $1', [actor.sub])).resolves.toMatchObject({
      rowCount: 1,
    });
  });
});

test('preserves a provisioned clinician role', async () => {
  await withTestDb(async (pool) => {
    const scenario = await seedScenario(pool);
    const service = makeProfilesService({ pool, clock });

    await expect(service.getMe(scenario.clinician)).resolves.toMatchObject({
      id: scenario.clinician.id,
      role: 'clinician',
    });
  });
});

test('paginates the clinician directory and returns a safe 404 for absent clinicians', async () => {
  await withTestDb(async (pool) => {
    const scenario = await seedScenario(pool);
    const service = makeProfilesService({ pool, clock });

    const firstPage = await service.listClinicians(scenario.patient, { limit: 1 });
    expect(firstPage.items).toEqual([
      {
        id: scenario.clinician.id,
        displayName: 'Clinician',
        biography: 'Demo clinician',
        specialty: 'General medicine',
        timezone: 'Europe/Stockholm',
      },
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await service.listClinicians(scenario.patient, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items).toEqual([
      {
        id: scenario.otherClinician.id,
        displayName: 'Other Clinician',
        biography: 'Demo clinician',
        specialty: 'General medicine',
        timezone: 'Europe/Stockholm',
      },
    ]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(service.listClinicians(scenario.patient, { limit: 1, cursor: 'invalid' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.getClinician(scenario.patient, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Clinician not found.',
    });
  });
});

test('carries stable backend error codes and statuses', () => {
  const codes = [
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'SLOT_UNAVAILABLE',
    'SLOT_OVERLAP',
    'APPOINTMENT_STARTED',
    'INTERNAL_ERROR',
  ] as const;

  for (const code of codes) {
    const error = new AppError(400, code, 'Safe message', { field: ['Invalid'] });
    expect(error).toMatchObject({ status: 400, code, message: 'Safe message', fieldErrors: { field: ['Invalid'] } });
  }
});
