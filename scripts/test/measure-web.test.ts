import { expect, it, vi } from 'vitest';
import { lighthouseCliAdapter, measureWeb, type LighthouseAdapter } from '../measure-web.js';
import type { ProcessRunner } from '../preflight.js';

it('runs three public mobile Lighthouse navigations and reports their median', async () => {
  let runIndex = 0;
  const run: LighthouseAdapter['run'] = vi.fn(async (input) => { void input; return { finalUrl: 'https://portal.example/clinicians', performance: [0.91, 0.95, 0.93][runIndex++]!, metrics: { lcpMs: 1_800 } }; });
  const result = await measureWeb({ url: 'https://portal.example/clinicians', mode: 'public', runs: 3 }, { run } as LighthouseAdapter);
  expect(run).toHaveBeenCalledTimes(3);
  expect(vi.mocked(run).mock.calls.every(([input]) => input.profile === 'mobile' && input.mode === 'navigation')).toBe(true);
  expect(result.medianPerformance).toBe(93);
  expect(result.measurement).toBe('public-navigation');
});

it('uses an authenticated user-flow adapter and rejects a sign-in redirect', async () => {
  const adapter: LighthouseAdapter = { run: vi.fn(async () => ({ finalUrl: 'https://portal.example/sign-in', performance: 0.99, metrics: {} })) };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, adapter)).rejects.toThrow(/sign-in/i);
  expect(vi.mocked(adapter.run).mock.calls.every(([input]) => input.mode === 'user-flow')).toBe(true);
});

it('refuses to label a protected route as a public navigation measurement', async () => {
  const adapter: LighthouseAdapter = { run: vi.fn() };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'public', runs: 3 }, adapter)).rejects.toThrow(/public route/i);
  expect(adapter.run).not.toHaveBeenCalled();
});

it('requires exactly three runs and rejects cross-origin final URLs', async () => {
  const adapter: LighthouseAdapter = { run: async () => ({ finalUrl: 'https://attacker.invalid/', performance: 0.9, metrics: {} }) };
  await expect(measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 2 }, adapter)).rejects.toThrow(/three/i);
  await expect(measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, adapter)).rejects.toThrow(/origin/i);
});

it('parses only numeric Lighthouse navigation results and refuses auth in the navigation CLI', async () => {
  const runner: ProcessRunner = vi.fn(async () => ({ stdout: JSON.stringify({ finalDisplayedUrl: 'https://portal.example/clinicians',
    categories: { performance: { score: 0.94 } }, audits: { 'largest-contentful-paint': { numericValue: 1700 },
      'cumulative-layout-shift': { numericValue: 0.02 } } }), stderr: '' }));
  const adapter = lighthouseCliAdapter(runner);
  await expect(adapter.run({ url: 'https://portal.example/clinicians', profile: 'mobile', mode: 'navigation' })).resolves.toEqual({
    finalUrl: 'https://portal.example/clinicians', performance: 0.94, metrics: { lcpMs: 1700, cumulativeLayoutShift: 0.02 },
  });
  expect(vi.mocked(runner).mock.calls[0]?.[1]).toContain('--form-factor=mobile');
  await expect(adapter.run({ url: 'https://portal.example/appointments', profile: 'mobile', mode: 'user-flow' })).rejects.toThrow(/user-flow/i);
});
