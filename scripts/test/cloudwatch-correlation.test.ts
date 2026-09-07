import { expect, it, vi } from 'vitest';
import { cloudWatchCorrelationAdapter, correlateRequestLogs } from '../cloudwatch-correlation.js';

const window = { startTime: Date.parse('2026-09-07T10:00:00Z'), endTime: Date.parse('2026-09-07T10:10:00Z') };
const at = window.startTime + 1_000;
const message = (requestId: string) => JSON.stringify({ requestId, operation: 'GET /api/me', status: 200,
  durationMs: 18, errorCode: null, coldStart: requestId.endsWith('A=') });

it('paginates bounded in-window request logs and returns sanitized aggregates', async () => {
  const page = vi.fn(async (requestId: string, cursor?: string) => cursor === undefined
    ? { events: [{ message: message(requestId), timestamp: at }], nextToken: 'next' }
    : { events: [{ message: 'Bearer private-value', timestamp: at }] });
  const result = await correlateRequestLogs(['Mc7UVioPPHcEKPA=', 'request_B-12345678'], { page }, window);
  expect(page).toHaveBeenCalledTimes(4);
  expect(result).toEqual({ requestCount: 2, coldCount: 1, warmCount: 1, maxDurationMs: 18 });
  expect(JSON.stringify(result)).not.toMatch(/Bearer|private-value|operation/);
});

it('fails on missing, duplicate, repeated, endless, or out-of-window evidence', async () => {
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [] }) }, window)).rejects.toThrow(/missing/i);
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [
    { message: message('request_A-12345678'), timestamp: at }, { message: message('request_A-12345678'), timestamp: at }] }) }, window)).rejects.toThrow(/exactly one/i);
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [], nextToken: 'same' }) }, window)).rejects.toThrow(/pagination/i);
  let pageNo = 0;
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [], nextToken: `token-${pageNo++}` }) }, window,
    { maxPagesPerRequest: 3 })).rejects.toThrow(/limit/i);
  await expect(correlateRequestLogs(['request_A-12345678'], { page: async () => ({ events: [
    { message: message('request_A-12345678'), timestamp: window.startTime - 1 }] }) }, window)).rejects.toThrow(/missing/i);
});

it('passes exact bounded times to CloudWatch and enforces a per-group page cap', async () => {
  const commands: unknown[] = [];
  let count = 0;
  const adapter = cloudWatchCorrelationAdapter({ send: async (command: unknown) => { commands.push(command); return { nextToken: `changing-${count++}` }; } } as never,
    ['/allowlisted/group'], { attempts: 1, maxPagesPerGroup: 2 });
  await expect(adapter.observe(['request_A-12345678'], window)).rejects.toThrow(/limit/i);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ input: { logGroupName: '/allowlisted/group', startTime: window.startTime, endTime: window.endTime,
    filterPattern: '{ $.requestId = "request_A-12345678" }' } });
});

it('detects a repeated underlying CloudWatch token before the page cap', async () => {
  const adapter = cloudWatchCorrelationAdapter({ send: async () => ({ nextToken: 'same-service-token' }) } as never,
    ['/allowlisted/group'], { attempts: 1, maxPagesPerGroup: 10 });
  await expect(adapter.observe(['request_A-12345678'], window)).rejects.toThrow(/token repeated/i);
});
