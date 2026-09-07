import { expect, it, vi } from 'vitest';
import { correlateRequestLogs } from '../cloudwatch-correlation.js';

it('paginates allowlisted request logs and returns only bounded warm/cold metric aggregates', async () => {
  const page = vi.fn(async (requestId: string, cursor?: string) => cursor === undefined
    ? { events: [{ message: JSON.stringify({ requestId, operation: 'GET /api/me', status: 200, durationMs: 18,
      errorCode: null, coldStart: requestId.endsWith('A=') , unsafe: 'Bearer private-value' }) }], nextToken: 'next' }
    : { events: [{ message: 'unrelated private log body' }] });
  const result = await correlateRequestLogs(['Mc7UVioPPHcEKPA=', 'request_B-12345678'], { page });
  expect(page).toHaveBeenCalledTimes(4);
  expect(result).toEqual({ requestCount: 2, coldCount: 1, warmCount: 1, maxDurationMs: 18 });
  expect(JSON.stringify(result)).not.toMatch(/Bearer|private-value|operation/);
});

it('fails for missing, duplicate, malformed, or looping request evidence', async () => {
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [] }) })).rejects.toThrow(/missing/i);
  const message = JSON.stringify({ requestId: 'request_A-12345678', operation: 'GET /api/me', status: 200,
    durationMs: 1, errorCode: null, coldStart: false });
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [{ message }, { message }] }) })).rejects.toThrow(/exactly one/i);
  await expect(correlateRequestLogs(['bad\nrequest'], { page: async () => ({ events: [] }) })).rejects.toThrow(/request ID/i);
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [], nextToken: 'same' }) })).rejects.toThrow(/pagination/i);
});
