import { expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { authenticatedUserFlowAdapter, initializePuppeteerBrowser, lighthouseCliAdapter, lighthouseWorkerEnvironment, measureWeb, validateWebMeasurement, type LighthouseAdapter } from '../measure-web.js';
import type { ProcessRunner } from '../preflight.js';
import { manifest } from './fakes.js';

const ready = { ...manifest, outputs: { ...manifest.outputs, FrontendUrl: 'https://portal.example' } };
const measuredAt = new Date('2026-09-07T10:00:00Z'); const options = { manifest: ready, now: () => measuredAt };
const navigationMetrics = { fcpMs: 900, lcpMs: 1800, speedIndexMs: 1200, totalBlockingTimeMs: 10, cumulativeLayoutShift: .01 };
const timespanMetrics = { totalBlockingTimeMs: 14, cumulativeLayoutShift: .01 };
const publicRun = (score: number) => ({ kind: 'navigation' as const, finalUrl: 'https://portal.example/', performanceScore: score,
  metrics: navigationMetrics, sessionEvidence: 'public-page' as const });

it('runs exactly three public mobile navigations and records the median score', async () => {
  let index = 0; const run = vi.fn(async () => publicRun([.91, .95, .93][index++]!));
  const result = await measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, { run }, options);
  expect(run).toHaveBeenCalledTimes(3); expect(result).toMatchObject({ measurement: 'public-navigation', mode: 'navigation',
    medianPerformanceScore: 93, sessionEvidence: 'public-page', target: { origin: 'https://portal.example', path: '/' } });
});

it('records authenticated timespan metrics without fabricating a navigation score', async () => {
  const adapter: LighthouseAdapter = { run: vi.fn(async () => ({ kind: 'timespan' as const, finalUrl: 'https://portal.example/appointments',
    metrics: timespanMetrics, sessionEvidence: 'authenticated-appointments' as const })) };
  const result = await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, adapter, options);
  expect(result).toMatchObject({ measurement: 'authenticated-user-flow', mode: 'timespan', medianMetrics: { totalBlockingTimeMs: 14 },
    sessionEvidence: 'authenticated-appointments' });
  expect(result).not.toHaveProperty('medianPerformanceScore'); expect(result.runs[0]).not.toHaveProperty('performanceScore');
});

it('rejects empty or weakened required metric sets and mismatched authenticated medians', async () => {
  const empty: LighthouseAdapter = { run: async () => ({ kind: 'timespan', finalUrl: 'https://portal.example/appointments', metrics: {}, sessionEvidence: 'authenticated-appointments' }) };
  await expect(measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, empty, options)).rejects.toThrow(/required metrics/i);
  const evidence = await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, {
    run: async () => ({ kind: 'timespan', finalUrl: 'https://portal.example/appointments', metrics: timespanMetrics, sessionEvidence: 'authenticated-appointments' }),
  }, options);
  expect(() => validateWebMeasurement({ ...evidence, medianMetrics: { totalBlockingTimeMs: 14 } }, ready, measuredAt)).toThrow(/required metrics/i);
  const weakPublic: LighthouseAdapter = { run: async () => ({ ...publicRun(.95), metrics: { lcpMs: 1800 } }) };
  await expect(measureWeb({ url: 'https://portal.example/', mode: 'public', runs: 3 }, weakPublic, options)).rejects.toThrow(/required metrics/i);
});

it('reuses and always closes the concrete authenticated-session boundary', async () => {
  const close = vi.fn(async () => {}); const create = vi.fn(async () => ({ close, run: async () => ({ kind: 'timespan' as const,
    finalUrl: 'https://portal.example/appointments', metrics: timespanMetrics, sessionEvidence: 'authenticated-appointments' as const }) }));
  await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, authenticatedUserFlowAdapter(create), options);
  expect(create).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

it('closes the browser and removes the profile when newPage or viewport initialization fails', async () => {
  for (const stage of ['newPage', 'viewport'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'portal-browser-init-')); const profile = await mkdtemp(join(root, 'profile-'));
    const close = vi.fn(async () => {}); const removeProfile = vi.fn((path: string) => rm(path, { recursive: true, force: true }));
    const setViewport = vi.fn(async () => { if (stage === 'viewport') throw new Error('viewport failed'); });
    const launch = vi.fn(async () => ({ close, newPage: async () => {
      if (stage === 'newPage') throw new Error('new page failed'); return { setViewport };
    } }));
    await expect(initializePuppeteerBrowser({ createProfile: async () => profile, secureProfile: (path) => chmod(path, 0o700), launch,
      removeProfile })).rejects.toThrow(/failed/i);
    expect(close).toHaveBeenCalledTimes(1); expect(removeProfile).toHaveBeenCalledWith(profile);
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' }); await rm(root, { recursive: true, force: true });
  }
});

it('rejects same-origin path, query, and hash final URL diversions in both modes', async () => {
  const cases = [
    { mode: 'public' as const, requested: 'https://portal.example/', actual: 'https://portal.example/sign-in', result: 'navigation' as const },
    { mode: 'public' as const, requested: 'https://portal.example/', actual: 'https://portal.example/?error=x', result: 'navigation' as const },
    { mode: 'public' as const, requested: 'https://portal.example/', actual: 'https://portal.example/#error', result: 'navigation' as const },
    { mode: 'authenticated' as const, requested: 'https://portal.example/appointments', actual: 'https://portal.example/auth/callback', result: 'timespan' as const },
    { mode: 'authenticated' as const, requested: 'https://portal.example/appointments', actual: 'https://portal.example/appointments?code=stale', result: 'timespan' as const },
    { mode: 'authenticated' as const, requested: 'https://portal.example/appointments', actual: 'https://portal.example/appointments#stale', result: 'timespan' as const },
  ];
  for (const item of cases) {
    const adapter: LighthouseAdapter = { run: async () => item.result === 'navigation'
      ? { kind: 'navigation', finalUrl: item.actual, performanceScore: .95, metrics: navigationMetrics, sessionEvidence: 'public-page' }
      : { kind: 'timespan', finalUrl: item.actual, metrics: timespanMetrics, sessionEvidence: 'authenticated-appointments' } };
    await expect(measureWeb({ url: item.requested, mode: item.mode, runs: 3 }, adapter, options)).rejects.toThrow(/invalid|URL/i);
  }
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
  for (const finalUrl of ['https://portal.example/sign-in', 'https://portal.example/?error=x', 'https://portal.example/#error']) {
    expect(() => validateWebMeasurement({ ...evidence, runs: evidence.runs.map((run) => ({ ...run, finalUrl })) }, ready, measuredAt)).toThrow(/final URL|authentication data/i);
  }
  const authenticated = await measureWeb({ url: 'https://portal.example/appointments', mode: 'authenticated', runs: 3 }, {
    run: async () => ({ kind: 'timespan', finalUrl: 'https://portal.example/appointments', metrics: timespanMetrics,
      sessionEvidence: 'authenticated-appointments' }),
  }, options);
  for (const finalUrl of ['https://portal.example/auth/callback', 'https://portal.example/appointments?code=stale', 'https://portal.example/appointments#stale']) {
    expect(() => validateWebMeasurement({ ...authenticated, runs: authenticated.runs.map((run) => ({ ...run, finalUrl })) }, ready, measuredAt)).toThrow(/final URL|authentication data/i);
  }
  expect(() => validateWebMeasurement(evidence, { ...ready, sourceCommit: 'b'.repeat(40) }, measuredAt)).toThrow(/identity|commit/i);
  expect(() => validateWebMeasurement(evidence, { ...ready, phase: 'bootstrap' }, measuredAt)).toThrow(/ready/i);
  expect(() => validateWebMeasurement(evidence, ready, new Date('2026-09-08T00:00:01Z'))).toThrow(/stale/i);
});

it('parses navigation output and keeps the production Chromium flags sandboxed', async () => {
  const runner: ProcessRunner = vi.fn(async () => ({ stdout: JSON.stringify({ finalDisplayedUrl: 'https://portal.example/', categories: { performance: { score: .94 } },
    audits: { 'largest-contentful-paint': { numericValue: 1700 }, 'cumulative-layout-shift': { numericValue: .02 } } }), stderr: '' }));
  const result = await lighthouseCliAdapter(runner).run({ url: 'https://portal.example/', profile: 'mobile', mode: 'navigation' });
  expect(result).toMatchObject({ kind: 'navigation', performanceScore: .94, metrics: { lcpMs: 1700 } });
  const defaultArgs = vi.mocked(runner).mock.calls[0]?.[1] ?? [];
  expect(defaultArgs).toContain('--form-factor=mobile');
  expect(defaultArgs.filter((arg) => arg.startsWith('--chrome-flags='))).toEqual(['--chrome-flags=--headless=new']);
  expect(defaultArgs.join(' ')).not.toContain('--no-sandbox');
});

it('scrubs the credential-bearing worker and rejects hostile Puppeteer diagnostics in a real subprocess before credential access', async () => {
  const authority = { account: manifest.account, region: manifest.region, issuer: manifest.outputs.Issuer!, clientId: manifest.outputs.ClientId!,
    userPoolId: manifest.outputs.UserPoolId!, cognitoDomain: manifest.outputs.CognitoDomain!, frontendUrl: manifest.outputs.FrontendUrl! };
  const env = lighthouseWorkerEnvironment({ PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: 'inherited-secret', GITHUB_TOKEN: 'github-secret',
    PORTAL_OTHER_SECRET: 'portal-secret', NODE_DEBUG: 'puppeteer:protocol*' }, '/private/credential', authority);
  expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY'); expect(env).not.toHaveProperty('GITHUB_TOKEN'); expect(env).not.toHaveProperty('NODE_DEBUG');
  const root = await mkdtemp(join(tmpdir(), 'portal-lh-privacy-')); const credential = join(root, 'credential.json'); const sentinel = 'UNIQUE_SENTINEL_PASSWORD';
  await writeFile(credential, JSON.stringify({ email: 'sentinel@example.invalid', password: sentinel }), { mode: 0o600 });
  await chmod(credential, 0o000);
  const deployment = join(root, 'deployment.json'); await writeFile(deployment, JSON.stringify(manifest), { mode: 0o600 });
  const beforeAccess = (await stat(credential)).atimeMs;
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/measure-web-worker.ts', 'https://portal.example/appointments'], { cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_DEBUG: 'puppeteer:protocol,puppeteer:*', APPT_MEASURE_CREDENTIAL_FILE: credential,
        APPT_MEASURE_MANIFEST_FILE: deployment, APPT_MEASURE_ACCOUNT: authority.account, APPT_MEASURE_REGION: authority.region,
        APPT_MEASURE_ISSUER: authority.issuer, APPT_MEASURE_CLIENT_ID: authority.clientId, APPT_MEASURE_USER_POOL_ID: authority.userPoolId,
        APPT_MEASURE_COGNITO_DOMAIN: authority.cognitoDomain, APPT_MEASURE_FRONTEND_URL: authority.frontendUrl, INHERITED_SENTINEL: sentinel } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
  const afterAccess = (await stat(credential)).atimeMs;
  const files = (await readdir(root)).filter((name) => name !== 'credential.json');
  const contents = await Promise.all(files.map((name) => readFile(join(root, name), 'utf8')));
  expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/refuses diagnostic/i); expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
  expect(afterAccess).toBe(beforeAccess);
  expect(contents.join('\n')).not.toContain(sentinel);
  await rm(root, { recursive: true, force: true });
});
