import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { authenticatedUserFlowAdapter, lighthouseCliAdapter, lighthouseWorkerEnvironment, measureWeb, validateWebMeasurement, type LighthouseAdapter } from '../measure-web.js';
import { runProcess, type ProcessRunner } from '../preflight.js';
import { manifest } from './fakes.js';

const ready = { ...manifest, outputs: { ...manifest.outputs, FrontendUrl: 'https://portal.example' } };
const measuredAt = new Date('2026-09-07T10:00:00Z'); const options = { manifest: ready, now: () => measuredAt };
const publicRun = (score: number) => ({ kind: 'navigation' as const, finalUrl: 'https://portal.example/', performanceScore: score,
  metrics: { lcpMs: 1800 }, sessionEvidence: 'public-page' as const });

it('runs exactly three public mobile navigations and records the median score', async () => {
  let index = 0; const run = vi.fn(async () => publicRun([.91, .95, .93][index++]!));
  const result = await measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, { run }, options);
  expect(run).toHaveBeenCalledTimes(3); expect(result).toMatchObject({ measurement: 'public-navigation', mode: 'navigation',
    medianPerformanceScore: 93, sessionEvidence: 'public-page', target: { origin: 'https://portal.example', path: '/' } });
});

it('records authenticated timespan metrics without fabricating a navigation score', async () => {
  const adapter: LighthouseAdapter = { run: vi.fn(async () => ({ kind: 'timespan' as const, finalUrl: 'https://portal.example/appointments',
    metrics: { totalBlockingTimeMs: 14, cumulativeLayoutShift: .01 }, sessionEvidence: 'authenticated-appointments' as const })) };
  const result = await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, adapter, options);
  expect(result).toMatchObject({ measurement: 'authenticated-user-flow', mode: 'timespan', medianMetrics: { totalBlockingTimeMs: 14 },
    sessionEvidence: 'authenticated-appointments' });
  expect(result).not.toHaveProperty('medianPerformanceScore'); expect(result.runs[0]).not.toHaveProperty('performanceScore');
});

it('reuses and always closes the concrete authenticated-session boundary', async () => {
  const close = vi.fn(async () => {}); const create = vi.fn(async () => ({ close, run: async () => ({ kind: 'timespan' as const,
    finalUrl: 'https://portal.example/appointments', metrics: { totalBlockingTimeMs: 9 }, sessionEvidence: 'authenticated-appointments' as const }) }));
  await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, authenticatedUserFlowAdapter(create), options);
  expect(create).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

it('rejects sign-in DOM evidence and exact-target credentials, queries, fragments, and alternate paths', async () => {
  const signIn: LighthouseAdapter = { run: async () => ({ kind: 'timespan', finalUrl: 'https://portal.example/appointments', metrics: {}, sessionEvidence: 'sign-in' }) };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, signIn, options)).rejects.toThrow(/authenticated appointment/i);
  const never: LighthouseAdapter = { run: vi.fn() };
  for (const url of ['https://u:p@portal.example/', 'https://portal.example/?code=x', 'https://portal.example/#token', 'https://portal.example/clinicians']) {
    await expect(measureWeb({ url, mode: 'public', runs: 3 }, never, options)).rejects.toThrow(/exact|credentials|query|fragment/i);
  }
  expect(never.run).not.toHaveBeenCalled();
});

it('revalidates tool, mode, session, target, query, and ready-manifest identity when evidence is loaded', async () => {
  const evidence = await measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, { run: async () => publicRun(.93) }, options);
  expect(() => validateWebMeasurement(evidence, ready, measuredAt)).not.toThrow();
  for (const changed of [
    { ...evidence, lighthouseVersion: '13.4.0' }, { ...evidence, url: 'https://portal.example/?x=1' },
    { ...evidence, sessionEvidence: 'authenticated-appointments' }, { ...evidence, mode: 'timespan' },
  ]) expect(() => validateWebMeasurement(changed, ready, measuredAt)).toThrow();
  expect(() => validateWebMeasurement(evidence, { ...ready, sourceCommit: 'b'.repeat(40) }, measuredAt)).toThrow(/identity|commit/i);
  expect(() => validateWebMeasurement(evidence, { ...ready, phase: 'bootstrap' }, measuredAt)).toThrow(/ready/i);
  expect(() => validateWebMeasurement(evidence, ready, new Date('2026-09-08T00:00:01Z'))).toThrow(/stale/i);
});

it('parses real navigation-shaped Lighthouse output and passes mobile flags', async () => {
  const runner: ProcessRunner = vi.fn(async () => ({ stdout: JSON.stringify({ finalDisplayedUrl: 'https://portal.example/', categories: { performance: { score: .94 } },
    audits: { 'largest-contentful-paint': { numericValue: 1700 }, 'cumulative-layout-shift': { numericValue: .02 } } }), stderr: '' }));
  const result = await lighthouseCliAdapter(runner).run({ url: 'https://portal.example/', profile: 'mobile', mode: 'navigation' });
  expect(result).toMatchObject({ kind: 'navigation', performanceScore: .94, metrics: { lcpMs: 1700 } });
  expect(vi.mocked(runner).mock.calls[0]?.[1]).toContain('--form-factor=mobile');
});

it('executes the pinned Lighthouse navigation adapter against a real local page', async () => {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Fixture</title><main>Ready</main>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local Lighthouse fixture did not bind.');
  try {
    const runner: ProcessRunner = (_executable, args) => runProcess(process.execPath, ['node_modules/lighthouse/cli/index.js', ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CHROME_PATH: chromium.executablePath() } });
    const result = await lighthouseCliAdapter(runner).run({ url: `http://127.0.0.1:${address.port}/`, profile: 'mobile', mode: 'navigation' });
    expect(result).toMatchObject({ kind: 'navigation', sessionEvidence: 'public-page' });
    if (result.kind === 'navigation') expect(result.performanceScore).toBeGreaterThan(0);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}, 30_000);

it('scrubs the credential-bearing worker and rejects hostile Puppeteer diagnostics in a real subprocess before credential access', async () => {
  const authority = { account: manifest.account, region: manifest.region, issuer: manifest.outputs.Issuer!, clientId: manifest.outputs.ClientId!,
    userPoolId: manifest.outputs.UserPoolId!, cognitoDomain: manifest.outputs.CognitoDomain!, frontendUrl: manifest.outputs.FrontendUrl! };
  const env = lighthouseWorkerEnvironment({ PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: 'inherited-secret', GITHUB_TOKEN: 'github-secret',
    PORTAL_OTHER_SECRET: 'portal-secret', NODE_DEBUG: 'puppeteer:protocol*' }, '/private/credential', authority);
  expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY'); expect(env).not.toHaveProperty('GITHUB_TOKEN'); expect(env).not.toHaveProperty('NODE_DEBUG');
  const root = await mkdtemp(join(tmpdir(), 'portal-lh-privacy-')); const credential = join(root, 'credential.json'); const sentinel = 'UNIQUE_SENTINEL_PASSWORD';
  await writeFile(credential, JSON.stringify({ email: 'sentinel@example.invalid', password: sentinel }), { mode: 0o600 });
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/measure-web-worker.ts', 'https://portal.example/appointments'], { cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_DEBUG: 'puppeteer:protocol*', APPT_MEASURE_CREDENTIAL_FILE: credential, INHERITED_SENTINEL: sentinel } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
  const files = await readdir(root); const contents = await Promise.all(files.map((name) => readFile(join(root, name), 'utf8')));
  expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/refuses diagnostic/i); expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
  expect(contents.join('\n').replace(await readFile(credential, 'utf8'), '')).not.toContain(sentinel);
  await rm(root, { recursive: true, force: true });
});
