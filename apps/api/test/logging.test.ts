import { describe, expect, it, vi } from 'vitest';

import { handleProfiles } from '../src/modules/profiles/routes.js';
import { createLambdaHandler, respond } from '../src/shared/http.js';
import { writeCompletionLog } from '../src/shared/logging.js';
import type { ProfilesService } from '../src/shared/types.js';
import { lambdaEvent } from './events.js';

const me = {
  id: '40000000-0000-4000-8000-000000000004',
  displayName: 'Patient',
  role: 'patient' as const,
};

const service = (getMe: ProfilesService['getMe']): ProfilesService => ({
  getMe,
  listClinicians: async () => ({ items: [], nextCursor: null }),
  getClinician: async () => {
    throw new Error('not used');
  },
});

describe('structured request completion logging', () => {
  it('writes only the allowlisted completion fields', () => {
    const write = vi.fn();
    writeCompletionLog(
      {
        requestId: 'request-1',
        operation: 'GET /api/me',
        status: 200,
        durationMs: 12,
        errorCode: null,
        password: 'sentinel-password',
        authorization: 'Bearer sentinel-token',
        body: { patient: 'private' },
      },
      write,
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({
      requestId: 'request-1',
      operation: 'GET /api/me',
      status: 200,
      durationMs: 12,
      errorCode: null,
    });
    expect(write.mock.calls[0]![0]).not.toContain('sentinel-password');
    expect(write.mock.calls[0]![0]).not.toContain('sentinel-token');
    expect(write.mock.calls[0]![0]).not.toContain('private');
  });

  it('emits exactly one allowlisted success event per Lambda request', async () => {
    const lines: string[] = [];
    const handler = createLambdaHandler({
      loadService: async () => service(async () => me),
      route: handleProfiles,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112),
      writeLog: (line) => lines.push(line),
    });
    const event = lambdaEvent('GET /api/me', 'patient-sub');
    event.headers.authorization = 'Bearer sentinel-token';

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      requestId: 'request-1',
      operation: 'GET /api/me',
      status: 200,
      durationMs: 12,
      errorCode: null,
    });
    expect(lines[0]).not.toContain('sentinel-token');
  });

  it('emits one safe error event without serializing raw exceptions or request data', async () => {
    const lines: string[] = [];
    const handler = createLambdaHandler({
      loadService: async () => service(async () => {
        throw new Error('SQL password=sentinel-password token=sentinel-token');
      }),
      route: handleProfiles,
      now: vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(205),
      writeLog: (line) => lines.push(line),
    });
    const event = lambdaEvent('GET /api/me', 'patient-sub');
    event.headers.authorization = 'Bearer sentinel-token';
    event.headers['x-database-password'] = 'sentinel-password';

    const response = await handler(event);

    expect(response.statusCode).toBe(500);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      requestId: 'request-1',
      operation: 'GET /api/me',
      status: 500,
      durationMs: 5,
      errorCode: 'INTERNAL_ERROR',
    });
    expect(`${response.body}\n${lines[0]}`).not.toContain('sentinel-password');
    expect(`${response.body}\n${lines[0]}`).not.toContain('sentinel-token');
  });

  it('normalizes record identifiers out of the logged operation', async () => {
    const lines: string[] = [];
    const id = '10000000-0000-4000-8000-000000000001';
    const handler = createLambdaHandler({
      loadService: async () => ({}),
      route: async (request) => respond(200, { ok: true }, request.requestId),
      writeLog: (line) => lines.push(line),
    });

    await handler(lambdaEvent(`GET /api/clinicians/${id}`, 'patient-sub'));

    expect(JSON.parse(lines[0]!)).toMatchObject({ operation: 'GET /api/clinicians/{id}' });
    expect(lines[0]).not.toContain(id);
  });
});
