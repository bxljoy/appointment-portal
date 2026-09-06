import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Appointment, Clinician, Me, Page, Slot } from '@portal/contracts';

import { handleAppointments } from '../src/modules/appointments/routes.js';
import { handleAvailability } from '../src/modules/availability/routes.js';
import { handleProfiles } from '../src/modules/profiles/routes.js';
import { createApplicationPoolProvider } from '../src/shared/database.js';
import { AppError } from '../src/shared/errors.js';
import {
  createLambdaHandler,
  respond,
  respondError,
  type HttpRequest,
} from '../src/shared/http.js';
import { readActor } from '../src/shared/identity.js';
import type { AppointmentsService, AvailabilityService, ProfilesService } from '../src/shared/types.js';
import { lambdaEvent } from './events.js';

const actor = { sub: 'cognito-sub' };
const requestId = 'request-1';
const clinicianId = '10000000-0000-4000-8000-000000000001';
const slotId = '20000000-0000-4000-8000-000000000002';
const appointmentId = '30000000-0000-4000-8000-000000000003';

const me: Me = {
  id: '40000000-0000-4000-8000-000000000004',
  displayName: 'Patient',
  role: 'patient',
};
const clinician: Clinician = {
  id: clinicianId,
  displayName: 'Clinician',
  biography: 'Biography',
  specialty: 'General medicine',
  timezone: 'Europe/Stockholm',
};
const slot: Slot = {
  id: slotId,
  clinicianId,
  startAt: '2030-06-02T09:00:00Z',
  endAt: '2030-06-02T09:30:00Z',
  status: 'open',
  isBooked: false,
};
const appointment: Appointment = {
  id: appointmentId,
  slotId,
  clinicianId,
  patientId: me.id,
  patientDisplayName: 'Patient',
  clinicianDisplayName: 'Clinician',
  startAt: '2030-06-02T09:00:00Z',
  endAt: '2030-06-02T09:30:00Z',
  status: 'booked',
  cancelledAt: null,
  cancelledBy: null,
};

const page = <T>(item: T): Page<T> => ({ items: [item], nextCursor: null });
const request = (method: string, path: string, options: Partial<HttpRequest> = {}): HttpRequest => ({
  method,
  path,
  query: {},
  body: undefined,
  actor,
  requestId,
  ...options,
});
const json = (response: { body: string }): unknown => JSON.parse(response.body);

const profilesService = (): ProfilesService => ({
  getMe: vi.fn(async () => me),
  listClinicians: vi.fn(async () => page(clinician)),
  getClinician: vi.fn(async () => clinician),
});

const availabilityService = (): AvailabilityService => ({
  listPublic: vi.fn(async () => page(slot)),
  listOwn: vi.fn(async () => page(slot)),
  create: vi.fn(async () => slot),
  withdraw: vi.fn(async () => ({ ...slot, status: 'withdrawn' })),
});

const appointmentsService = (): AppointmentsService => ({
  list: vi.fn(async () => page(appointment)),
  book: vi.fn(async () => appointment),
  cancel: vi.fn(async () => ({ ...appointment, status: 'cancelled' })),
});

describe('profiles HTTP routes', () => {
  it('dispatches every profiles route with validated parameters', async () => {
    const service = profilesService();

    expect(json(await handleProfiles(request('GET', '/api/me'), service))).toEqual(me);
    expect(
      json(
        await handleProfiles(
          request('GET', '/api/clinicians', { query: { limit: '5', cursor: 'cursor-value' } }),
          service,
        ),
      ),
    ).toEqual(page(clinician));
    expect(json(await handleProfiles(request('GET', `/api/clinicians/${clinicianId}`), service))).toEqual(clinician);
    expect(service.getMe).toHaveBeenCalledWith(actor);
    expect(service.listClinicians).toHaveBeenCalledWith(actor, { limit: 5, cursor: 'cursor-value' });
    expect(service.getClinician).toHaveBeenCalledWith(actor, clinicianId);
  });

  it('strictly validates profile query, path, and body input', async () => {
    const service = profilesService();
    const badQuery = await handleProfiles(
      request('GET', '/api/clinicians', { query: { limit: '20', role: 'clinician' } }),
      service,
    );
    const badPath = await handleProfiles(request('GET', '/api/clinicians/not-a-uuid'), service);
    const badBody = await handleProfiles(request('GET', '/api/me', { body: { role: 'clinician' } }), service);

    expect(badQuery.statusCode).toBe(400);
    expect(json(badQuery)).toMatchObject({ error: { code: 'VALIDATION_ERROR', fieldErrors: { role: expect.any(Array) } } });
    expect(badPath.statusCode).toBe(400);
    expect(json(badPath)).toMatchObject({ error: { fieldErrors: { id: expect.any(Array) } } });
    expect(badBody.statusCode).toBe(400);
  });

  it('distinguishes unknown paths from methods unsupported on a known path', async () => {
    const service = profilesService();

    expect((await handleProfiles(request('GET', '/api/not-a-route'), service)).statusCode).toBe(404);
    expect((await handleProfiles(request('POST', '/api/me'), service)).statusCode).toBe(405);
    expect((await handleProfiles(request('DELETE', `/api/clinicians/${clinicianId}`), service)).statusCode).toBe(405);
  });
});

describe('availability HTTP routes', () => {
  it('dispatches every availability route with validated parameters', async () => {
    const service = availabilityService();
    const query = { from: '2030-06-01T00:00:00Z', to: '2030-06-08T00:00:00Z', limit: '10' };

    expect(json(await handleAvailability(request('GET', `/api/clinicians/${clinicianId}/slots`, { query }), service))).toEqual(page(slot));
    expect(json(await handleAvailability(request('GET', '/api/availability', { query }), service))).toEqual(page(slot));
    expect(
      (await handleAvailability(
        request('POST', '/api/availability', { body: { startAt: '2030-06-02T09:00:00Z' } }),
        service,
      )).statusCode,
    ).toBe(201);
    expect(
      json(await handleAvailability(request('POST', `/api/availability/${slotId}/withdraw`), service)),
    ).toMatchObject({ id: slotId, status: 'withdrawn' });
    expect(service.listPublic).toHaveBeenCalledWith(actor, clinicianId, {
      from: query.from,
      to: query.to,
      limit: 10,
    });
    expect(service.listOwn).toHaveBeenCalledWith(actor, { from: query.from, to: query.to, limit: 10 });
    expect(service.create).toHaveBeenCalledWith(actor, { startAt: '2030-06-02T09:00:00Z' });
    expect(service.withdraw).toHaveBeenCalledWith(actor, slotId);
  });

  it('rejects invalid windows, IDs, bodies, query keys, and role injection', async () => {
    const service = availabilityService();
    const badWindow = await handleAvailability(
      request('GET', '/api/availability', {
        query: { from: '2030-06-08T00:00:00Z', to: '2030-06-01T00:00:00Z', limit: '20' },
      }),
      service,
    );
    const badId = await handleAvailability(request('POST', '/api/availability/nope/withdraw'), service);
    const roleInjection = await handleAvailability(
      request('POST', '/api/availability', {
        body: { startAt: '2030-06-02T09:00:00Z', role: 'clinician' },
      }),
      service,
    );
    const unexpectedQuery = await handleAvailability(
      request('POST', '/api/availability', {
        query: { patientId: me.id },
        body: { startAt: '2030-06-02T09:00:00Z' },
      }),
      service,
    );

    expect(badWindow.statusCode).toBe(400);
    expect(json(badWindow)).toMatchObject({ error: { fieldErrors: { to: expect.any(Array) } } });
    expect(badId.statusCode).toBe(400);
    expect(roleInjection.statusCode).toBe(400);
    expect(json(roleInjection)).toMatchObject({ error: { fieldErrors: { role: expect.any(Array) } } });
    expect(unexpectedQuery.statusCode).toBe(400);
  });

  it('distinguishes unknown paths from methods unsupported on a known path', async () => {
    const service = availabilityService();

    expect((await handleAvailability(request('GET', '/api/availability/nope'), service)).statusCode).toBe(404);
    expect((await handleAvailability(request('DELETE', '/api/availability'), service)).statusCode).toBe(405);
    expect(
      (await handleAvailability(request('GET', `/api/availability/${slotId}/withdraw`), service)).statusCode,
    ).toBe(405);
  });
});

describe('appointments HTTP routes', () => {
  it('dispatches every appointments route with validated parameters', async () => {
    const service = appointmentsService();

    expect(json(await handleAppointments(request('GET', '/api/appointments', { query: { limit: '25' } }), service))).toEqual(page(appointment));
    expect(
      (await handleAppointments(request('POST', '/api/appointments', { body: { slotId } }), service)).statusCode,
    ).toBe(201);
    expect(
      json(
        await handleAppointments(
          request('POST', `/api/appointments/${appointmentId}/cancel`, { body: { withdrawSlot: true } }),
          service,
        ),
      ),
    ).toMatchObject({ id: appointmentId, status: 'cancelled' });
    expect(service.list).toHaveBeenCalledWith(actor, { limit: 25 });
    expect(service.book).toHaveBeenCalledWith(actor, { slotId });
    expect(service.cancel).toHaveBeenCalledWith(actor, appointmentId, { withdrawSlot: true });
  });

  it('rejects invalid path, query, body, and identity or role injection', async () => {
    const service = appointmentsService();
    const badQuery = await handleAppointments(
      request('GET', '/api/appointments', { query: { limit: '0' } }),
      service,
    );
    const badPath = await handleAppointments(request('POST', '/api/appointments/not-an-id/cancel', { body: {} }), service);
    const badBody = await handleAppointments(
      request('POST', '/api/appointments', { body: { slotId, patientId: me.id, role: 'patient' } }),
      service,
    );
    const badCancel = await handleAppointments(
      request('POST', `/api/appointments/${appointmentId}/cancel`, { body: { withdrawSlot: 'yes' } }),
      service,
    );

    expect(badQuery.statusCode).toBe(400);
    expect(badPath.statusCode).toBe(400);
    expect(badBody.statusCode).toBe(400);
    expect(json(badBody)).toMatchObject({ error: { fieldErrors: { patientId: expect.any(Array), role: expect.any(Array) } } });
    expect(badCancel.statusCode).toBe(400);
  });

  it('distinguishes unknown paths from methods unsupported on a known path', async () => {
    const service = appointmentsService();

    expect((await handleAppointments(request('GET', '/api/appointments/nope'), service)).statusCode).toBe(404);
    expect((await handleAppointments(request('DELETE', '/api/appointments'), service)).statusCode).toBe(405);
    expect(
      (await handleAppointments(request('GET', `/api/appointments/${appointmentId}/cancel`), service)).statusCode,
    ).toBe(405);
  });
});

describe('shared HTTP response and Lambda event adapter', () => {
  it('sets required no-store JSON correlation headers on success and errors', () => {
    for (const response of [respond(200, { ok: true }, requestId), respondError(new AppError(404, 'NOT_FOUND', 'Missing.'), requestId)]) {
      expect(response.headers).toEqual({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
      });
    }
  });

  it('does not expose database failures', () => {
    const response = respondError(new Error('SQL password=private'), requestId);
    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId },
    });
    expect(response.body).not.toContain('private');
  });

  it('reads identity only from validated JWT sub claims', () => {
    expect(readActor(lambdaEvent('GET /api/me', actor.sub))).toEqual(actor);
    const event = lambdaEvent('GET /api/me');
    Object.assign(event.requestContext.authorizer ?? {}, { principalId: actor.sub, role: 'clinician' });
    Object.assign(event, { sub: actor.sub, role: 'clinician' });

    expect(() => readActor(event)).toThrow(expect.objectContaining({ status: 401, code: 'UNAUTHENTICATED' }));
  });

  it('rejects malformed and non-JSON bodies before service loading', async () => {
    const loadService = vi.fn(async () => profilesService());
    const handler = createLambdaHandler({ loadService, route: handleProfiles, writeLog: () => undefined });
    const malformed = lambdaEvent('POST /api/me', actor.sub);
    malformed.headers = { 'content-type': 'application/json' };
    malformed.body = '{';
    const textBody = lambdaEvent('POST /api/me', actor.sub, { ok: true });
    textBody.headers = { 'content-type': 'text/plain' };

    expect((await handler(malformed)).statusCode).toBe(400);
    expect((await handler(textBody)).statusCode).toBe(400);
    expect(loadService).not.toHaveBeenCalled();
  });

  it('rejects oversized UTF-8 and base64 bodies before parsing or service loading', async () => {
    const loadService = vi.fn(async () => profilesService());
    const handler = createLambdaHandler({ loadService, route: handleProfiles, writeLog: () => undefined });
    const utf8 = lambdaEvent('POST /api/me', actor.sub);
    utf8.headers = { 'content-type': 'application/json' };
    utf8.body = `{"value":"${'å'.repeat(8_193)}"}`;
    const base64 = lambdaEvent('POST /api/me', actor.sub);
    base64.headers = { 'content-type': 'application/json' };
    base64.body = Buffer.from('{not-json'.padEnd(16_385, 'x')).toString('base64');
    base64.isBase64Encoded = true;

    for (const event of [utf8, base64]) {
      const response = await handler(event);
      expect(response.statusCode).toBe(413);
      expect(json(response)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    }
    expect(loadService).not.toHaveBeenCalled();
  });

  it('returns a safe 401 when the JWT sub is missing without loading the service', async () => {
    const loadService = vi.fn(async () => profilesService());
    const handler = createLambdaHandler({ loadService, route: handleProfiles, writeLog: () => undefined });

    const response = await handler(lambdaEvent('GET /api/me'));

    expect(response.statusCode).toBe(401);
    expect(json(response)).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', requestId },
    });
    expect(loadService).not.toHaveBeenCalled();
  });

  it('passes a parsed request to a route and returns its response', async () => {
    const service = appointmentsService();
    const handler = createLambdaHandler({
      loadService: async () => service,
      route: handleAppointments,
      writeLog: () => undefined,
    });

    const response = await handler(lambdaEvent(`POST /api/appointments`, actor.sub, { slotId }));

    expect(response.statusCode).toBe(201);
    expect(service.book).toHaveBeenCalledWith(actor, { slotId });
  });

  it('rejects repeated query keys before service initialization', async () => {
    const loadService = vi.fn(async () => profilesService());
    const handler = createLambdaHandler({ loadService, route: handleProfiles, writeLog: () => undefined });
    const event = lambdaEvent('GET /api/clinicians?limit=10&limit=20', actor.sub);

    const response = await handler(event);

    expect(response.statusCode).toBe(400);
    expect(json(response)).toMatchObject({ error: { fieldErrors: { limit: expect.any(Array) } } });
    expect(loadService).not.toHaveBeenCalled();
  });
});

describe('application database pool initialization', () => {
  it('loads only the named application secret and creates a bounded verified TLS pool once', async () => {
    const release = vi.fn();
    const connect = vi.fn(async () => ({ release }));
    const pool = { connect, end: vi.fn(async () => undefined), on: vi.fn() };
    const createPool = vi.fn(() => pool);
    const readSecret = vi.fn(async () => JSON.stringify({
      host: 'direct.cluster.example',
      port: 5432,
      dbname: 'portal',
      username: 'portal_app',
      password: 'sentinel-password',
    }));
    const readCaBundle = vi.fn(() => 'unused-direct-rds-ca');
    const getPool = createApplicationPoolProvider({
      env: {
        APPLICATION_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:eu-north-1:111111111111:secret:portal-app',
        DATABASE_HOST: 'proxy.proxy-example.eu-north-1.rds.amazonaws.com',
        DATABASE_CA_BUNDLE_PATH: '/var/task/certs/global-bundle.pem',
      },
      readSecret,
      readCaBundle,
      createPool,
    });

    const [first, second] = await Promise.all([getPool(), getPool()]);

    expect(first).toBe(pool);
    expect(second).toBe(pool);
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(readSecret).toHaveBeenCalledWith('arn:aws:secretsmanager:eu-north-1:111111111111:secret:portal-app');
    expect(createPool).toHaveBeenCalledWith({
      host: 'proxy.proxy-example.eu-north-1.rds.amazonaws.com',
      port: 5432,
      database: 'portal',
      user: 'portal_app',
      password: 'sentinel-password',
      max: 2,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      idle_in_transaction_session_timeout: 5_000,
      ssl: { rejectUnauthorized: true },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(readCaBundle).not.toHaveBeenCalled();
  });

  it('uses an explicit CA bundle when connecting directly to RDS', async () => {
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ release })), end: vi.fn(async () => undefined), on: vi.fn() };
    const readCaBundle = vi.fn(() => 'rds-global-ca');
    const createPool = vi.fn(() => pool);
    const getPool = createApplicationPoolProvider({
      env: {
        APPLICATION_DATABASE_SECRET_ARN: 'application-secret',
        DATABASE_CA_BUNDLE_PATH: '/var/task/certs/global-bundle.pem',
      },
      readSecret: async () => JSON.stringify({
        host: 'direct.cluster.example', port: 5432, dbname: 'portal', username: 'portal_app', password: randomUUID(),
      }),
      readCaBundle,
      createPool,
    });

    await getPool();

    expect(readCaBundle).toHaveBeenCalledWith('/var/task/certs/global-bundle.pem');
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'direct.cluster.example',
      ssl: { ca: 'rds-global-ca', rejectUnauthorized: true },
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('accepts a credentials-only application secret for an explicitly configured proxy', async () => {
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ release })), end: vi.fn(async () => undefined), on: vi.fn() };
    const createPool = vi.fn(() => pool);
    const getPool = createApplicationPoolProvider({
      env: {
        APPLICATION_DATABASE_SECRET_ARN: 'application-secret',
        DATABASE_HOST: 'proxy.example',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'portal',
      },
      readSecret: async () => JSON.stringify({ username: 'portal_app', password: randomUUID() }),
      readCaBundle: () => 'unused',
      createPool,
    });

    await getPool();

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      host: 'proxy.example',
      port: 5432,
      database: 'portal',
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resets a failed cached initialization so a later invocation can recover', async () => {
    const failedPool = { connect: vi.fn(async () => { throw new Error('proxy unavailable'); }), end: vi.fn(async () => undefined), on: vi.fn() };
    const release = vi.fn();
    const recoveredPool = { connect: vi.fn(async () => ({ release })), end: vi.fn(async () => undefined), on: vi.fn() };
    const createPool = vi.fn()
      .mockReturnValueOnce(failedPool)
      .mockReturnValueOnce(recoveredPool);
    const getPool = createApplicationPoolProvider({
      env: {
        APPLICATION_DATABASE_SECRET_ARN: 'application-secret',
        DATABASE_CA_BUNDLE_PATH: '/ca.pem',
      },
      readSecret: async () => JSON.stringify({
        host: 'direct.cluster.example', port: 5432, dbname: 'portal', username: 'portal_app', password: randomUUID(),
      }),
      readCaBundle: () => 'trusted-ca',
      createPool,
    });

    await expect(getPool()).rejects.toThrow('proxy unavailable');
    await expect(getPool()).resolves.toBe(recoveredPool);
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(failedPool.end).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects credentials for any database user other than the application role', async () => {
    const createPool = vi.fn();
    const getPool = createApplicationPoolProvider({
      env: {
        APPLICATION_DATABASE_SECRET_ARN: 'application-secret',
        DATABASE_HOST: 'proxy.example',
      },
      readSecret: async () => JSON.stringify({
        host: 'direct.cluster.example', port: 5432, dbname: 'portal', username: 'admin', password: 'sentinel-password',
      }),
      readCaBundle: () => 'unused',
      createPool,
    });

    await expect(getPool()).rejects.toThrow('application database secret is invalid');
    expect(createPool).not.toHaveBeenCalled();
  });
});
