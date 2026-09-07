import { expect, it, vi } from 'vitest';
import { manifest } from './fakes.js';
import { playwrightVerificationAdapter, verifyAws, type VerificationAdapter } from '../verify-aws.js';
import { awsPlaywrightEnvironment } from '../aws-lifecycle.js';
import type { ProcessRunner } from '../preflight.js';

const ready = { ...manifest, phase: 'ready' as const, sourceCommit: 'b'.repeat(40) };

it('records only fixed scenario text and allowlisted request IDs', async () => {
  const adapter: VerificationAdapter = {
    run: vi.fn(async (suite) => suite === 'aws-auth' ? { requestIds: [] } : suite === 'aws-api'
      ? { requestIds: ['request_A-12345678'], unsafeDetail: 'person@example.com Bearer secret-value' }
      : { requestIds: ['request_R-12345678'] }),
  };
  const summary = await verifyAws(ready, { adapter, now: () => new Date('2026-09-07T10:00:00Z') });
  expect(summary).toEqual({
    commit: 'b'.repeat(40), checkedAt: '2026-09-07T10:00:00.000Z',
    checks: [
      { name: 'deployed managed authentication', status: 'passed', detail: 'AWS auth suite passed.' },
      { name: 'deployed API and edge controls', status: 'passed', detail: 'AWS API suite passed; request IDs: request_A-12345678.' },
      { name: 'deployed booking races', status: 'passed', detail: 'AWS race suite passed; request IDs: request_R-12345678.' },
    ],
  });
  expect(JSON.stringify(summary)).not.toMatch(/example\.com|Bearer|secret-value/);
});

it('does not call deployed API or race verification passed without a request ID', async () => {
  const adapter: VerificationAdapter = { run: async () => ({ requestIds: [] }) };
  const summary = await verifyAws(ready, { adapter });
  expect(summary.checks.map((check) => check.status)).toEqual(['passed', 'failed', 'failed']);
});

it('fails closed for malformed request IDs and reports a generic suite failure', async () => {
  const malformed: VerificationAdapter = { run: async () => ({ requestIds: ['good_request-123', 'email@example.com'] }) };
  await expect(verifyAws(ready, { adapter: malformed })).rejects.toThrow(/request ID/i);
  const failing: VerificationAdapter = { run: async () => { throw new Error('Bearer token user@example.com'); } };
  const summary = await verifyAws(ready, { adapter: failing, now: () => new Date('2026-09-07T10:00:00Z') });
  expect(summary.checks.every((check) => check.status === 'failed')).toBe(true);
  expect(JSON.stringify(summary)).not.toMatch(/Bearer|example\.com/);
});

it('requires a ready manifest with an exact source commit before execution', async () => {
  const run = vi.fn();
  await expect(verifyAws({ ...ready, phase: 'bootstrap' }, { adapter: { run } })).rejects.toThrow(/ready/i);
  await expect(verifyAws({ ...ready, sourceCommit: undefined }, { adapter: { run } })).rejects.toThrow(/commit/i);
  expect(run).not.toHaveBeenCalled();
});

it('rejects extra runner variables and invalid deployed coordinates before launching a browser', () => {
  const files = { PORTAL_E2E_PATIENT_A_FILE: '/private/a', PORTAL_E2E_PATIENT_B_FILE: '/private/b',
    PORTAL_E2E_CLINICIAN_A_FILE: '/private/c', PORTAL_E2E_CLINICIAN_B_FILE: '/private/d' };
  expect(() => awsPlaywrightEnvironment('https://portal.example', { ...files, DEBUG: 'pw:protocol' })).toThrow(/exactly four/i);
  expect(() => awsPlaywrightEnvironment('https://portal.example/path', files)).toThrow(/origin/i);
  expect(() => awsPlaywrightEnvironment('https://portal.example', files, {}, { apiUrl: 'http://api.example', bucket: 'bucket', region: 'eu-north-1' })).toThrow(/coordinates/i);
});

it('runs managed browser behavior at desktop and mobile sizes while keeping API and race traffic single-pass', async () => {
  const runner = vi.fn<ProcessRunner>(async () => ({ stdout: 'PORTAL_REQUEST_ID:request-12345678\n', stderr: '' }));
  const adapter = playwrightVerificationAdapter({ PORTAL_E2E_AWS: '1' }, runner);
  await adapter.run('aws-auth');
  await adapter.run('aws-api');
  expect(runner.mock.calls[0]?.[1]).toEqual([
    'exec', 'playwright', 'test', 'tests/e2e/aws-auth.spec.ts', '--project=aws', '--project=aws-mobile',
  ]);
  expect(runner.mock.calls[1]?.[1]).toEqual([
    'exec', 'playwright', 'test', 'tests/e2e/aws-api.spec.ts', '--project=aws',
  ]);
});
