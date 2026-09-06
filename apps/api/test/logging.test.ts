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
  it.each([200, 500])('keeps the %i completion record and gateway correlation at the top level under Lambda JSON logging', async (status) => {
    const cloudWatchLines: string[] = [];
    // Model the relevant Node 24 RIC behavior: a single console argument becomes
    // the JSON envelope's message value; an already serialized string stays a
    // string. Direct stdout lines bypass that console envelope.
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      cloudWatchLines.push(String(chunk));
      return true;
    });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      cloudWatchLines.push(`${JSON.stringify({ timestamp: '2030-01-01T00:00:00.000Z', level: 'INFO',
        requestId: 'lambda-invocation-id', message })}\n`);
    });
    const handler = createLambdaHandler({
      loadService: async () => service(async () => {
        if (status === 500) throw new Error('SQL sentinel-password Bearer sentinel-token');
        return me;
      }),
      route: handleProfiles,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(112),
    });
    const event = lambdaEvent('GET /api/me', 'patient-sub');
    event.headers.authorization = 'Bearer sentinel-token';
    let response;
    try {
      response = await handler(event);
    } finally {
      stdout.mockRestore();
      consoleLog.mockRestore();
    }
    expect(response.statusCode).toBe(status);
    expect(cloudWatchLines).toHaveLength(1);
    expect(cloudWatchLines[0]).toMatch(/\n$/);
    expect(cloudWatchLines[0]!.trim().split('\n')).toHaveLength(1);
    const record = JSON.parse(cloudWatchLines[0]!);
    expect(record).toEqual({ requestId: 'request-1', operation: 'GET /api/me', status,
      durationMs: 12, errorCode: status === 500 ? 'INTERNAL_ERROR' : null });
    expect(record.requestId).toBe(response.headers['X-Request-Id']);
    expect(cloudWatchLines[0]).not.toMatch(/sentinel-password|sentinel-token|patient-sub|lambda-invocation-id/);
  });

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
