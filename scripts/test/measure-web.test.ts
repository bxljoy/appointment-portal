import { expect, it, vi } from 'vitest';
import { authenticatedUserFlowAdapter, lighthouseCliAdapter, measureWeb, validateWebMeasurement, type LighthouseAdapter } from '../measure-web.js';
import type { ProcessRunner } from '../preflight.js';
import { manifest } from './fakes.js';

const ready = { ...manifest, phase: 'ready' as const, sourceCommit: 'a'.repeat(40), outputs: { ...manifest.outputs, FrontendUrl: 'https://portal.example' } };
const measuredAt = new Date('2026-09-07T10:00:00Z');
const options = { manifest: ready, now: () => measuredAt };

it('runs three public mobile Lighthouse navigations and reports their median', async () => {
  let runIndex = 0;
  const run: LighthouseAdapter['run'] = vi.fn(async (input) => { void input; return { finalUrl: 'https://portal.example/clinicians', performance: [0.91, 0.95, 0.93][runIndex++]!, metrics: { lcpMs: 1_800 } }; });
  const result = await measureWeb({ url: 'https://portal.example/clinicians', mode: 'public', runs: 3 }, { run } as LighthouseAdapter, options);
  expect(run).toHaveBeenCalledTimes(3);
  expect(vi.mocked(run).mock.calls.every(([input]) => input.profile === 'mobile' && input.mode === 'navigation')).toBe(true);
  expect(result.medianPerformance).toBe(93);
  expect(result.measurement).toBe('public-navigation');
  expect(result).toMatchObject({ commit: 'a'.repeat(40), checkedAt: measuredAt.toISOString(), lighthouseVersion: '13.4.1', runCount: 3,
    mode: 'navigation', target: { origin: 'https://portal.example', path: '/clinicians' } });
});

it('uses an authenticated user-flow adapter and rejects a sign-in redirect', async () => {
  const close = vi.fn(async () => {});
  const adapter: LighthouseAdapter = { run: vi.fn(async () => ({ finalUrl: 'https://portal.example/appointments', performance: 0.99, metrics: {}, sessionEvidence: 'sign-in' as const })), close };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, adapter, options)).rejects.toThrow(/authenticated appointment/i);
  expect(vi.mocked(adapter.run).mock.calls.every(([input]) => input.mode === 'user-flow')).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses to label a protected route as a public navigation measurement', async () => {
  const adapter: LighthouseAdapter = { run: vi.fn() };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'public', runs: 3 }, adapter, options)).rejects.toThrow(/public route/i);
  expect(adapter.run).not.toHaveBeenCalled();
});

it('requires exactly three runs and rejects cross-origin final URLs', async () => {
  const adapter: LighthouseAdapter = { run: async () => ({ finalUrl: 'https://attacker.invalid/', performance: 0.9, metrics: {} }) };
  await expect(measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 2 }, adapter, options)).rejects.toThrow(/three/i);
  await expect(measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, adapter, options)).rejects.toThrow(/origin/i);
});

it('wires one authenticated user-flow session for all runs and always closes it', async () => {
  const close = vi.fn(async () => {});
  const create = vi.fn(async () => ({ close, run: async () => ({ finalUrl: 'https://portal.example/appointments', performance: 0.92,
    metrics: { lcpMs: 1800 }, sessionEvidence: 'authenticated-appointments' as const }) }));
  const adapter = authenticatedUserFlowAdapter(create);
  const result = await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, adapter, options);
  expect(result.measurement).toBe('authenticated-user-flow');
  expect(create).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects stale, mismatched, or non-ready performance evidence', async () => {
  const run: LighthouseAdapter['run'] = async () => ({ finalUrl: 'https://portal.example/', performance: 0.9, metrics: {} });
  const result = await measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, { run }, options);
  expect(() => validateWebMeasurement(result, ready, new Date('2026-09-07T11:00:00Z'))).not.toThrow();
  expect(() => validateWebMeasurement(result, { ...ready, sourceCommit: 'b'.repeat(40) }, measuredAt)).toThrow(/commit/i);
  expect(() => validateWebMeasurement(result, { ...ready, phase: 'bootstrap' }, measuredAt)).toThrow(/ready/i);
  expect(() => validateWebMeasurement(result, ready, new Date('2026-09-08T00:00:01Z'))).toThrow(/stale/i);
});

it('parses only numeric Lighthouse navigation results and refuses auth in the navigation CLI', async () => {
  const runner: ProcessRunner = vi.fn(async () => ({ stdout: JSON.stringify({ finalDisplayedUrl: 'https://portal.example/clinicians',
    categories: { performance: { score: 0.94 } }, audits: { 'largest-contentful-paint': { numericValue: 1700 },
      'cumulative-layout-shift': { numericValue: 0.02 } } }), stderr: '' }));
  const adapter = lighthouseCliAdapter(runner);
  await expect(adapter.run({ url: 'https://portal.example/clinicians', profile: 'mobile', mode: 'navigation' })).resolves.toEqual({
    finalUrl: 'https://portal.example/clinicians', performance: 0.94, metrics: { lcpMs: 1700, cumulativeLayoutShift: 0.02 }, sessionEvidence: 'public-page',
  });
  expect(vi.mocked(runner).mock.calls[0]?.[1]).toContain('--form-factor=mobile');
  await expect(adapter.run({ url: 'https://portal.example/appointments', profile: 'mobile', mode: 'user-flow' })).rejects.toThrow(/user-flow/i);
});
