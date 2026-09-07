import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { authorityFromManifest, assertManagedLoginOrigin, type AwsAuthority } from './aws-authority.js';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { runProcess, type ProcessRunner } from './preflight.js';
import { writePrivateJson } from './private-file.js';

export const LIGHTHOUSE_VERSION = '13.4.1';
export type NavigationResult = { kind: 'navigation'; finalUrl: string; performanceScore: number; metrics: Record<string, number>; sessionEvidence: 'public-page' };
export type TimespanResult = { kind: 'timespan'; finalUrl: string; metrics: Record<string, number>; sessionEvidence: 'authenticated-appointments' | 'sign-in' };
export type LighthouseResult = NavigationResult | TimespanResult;
export type LighthouseAdapter = { run(input: { url: string; profile: 'mobile'; mode: 'navigation' | 'timespan' }): Promise<LighthouseResult>; close?(): Promise<void> };

type Run = { metrics: Record<string, number> };
export type WebMeasurement = {
  commit: string; checkedAt: string; lighthouseVersion: typeof LIGHTHOUSE_VERSION; url: string; target: { origin: string; path: string };
  profile: 'mobile'; runCount: 3;
} & ({ measurement: 'public-navigation'; mode: 'navigation'; runs: Array<Run & { performanceScore: number }>; medianPerformanceScore: number;
  sessionEvidence: 'public-page' } | { measurement: 'authenticated-user-flow'; mode: 'timespan'; runs: Run[];
  medianMetrics: Record<string, number>; sessionEvidence: 'authenticated-appointments' });

const navigationReport = z.object({ finalDisplayedUrl: z.url(), categories: z.object({ performance: z.object({ score: z.number().min(0).max(1) }) }),
  audits: z.record(z.string(), z.object({ numericValue: z.number().nonnegative().optional() })) });
const navigationMetrics = ['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift'] as const;
const metricNames: Record<string, string> = { 'first-contentful-paint': 'fcpMs', 'largest-contentful-paint': 'lcpMs', 'speed-index': 'speedIndexMs',
  'total-blocking-time': 'totalBlockingTimeMs', 'cumulative-layout-shift': 'cumulativeLayoutShift', 'interaction-to-next-paint': 'interactionToNextPaintMs' };
const metrics = (audits: Record<string, { numericValue?: number }>, names: readonly string[]) => Object.fromEntries(names.flatMap((name) => {
  const value = audits[name]?.numericValue; return value === undefined ? [] : [[metricNames[name]!, value]];
}));

export function lighthouseCliAdapter(runner: ProcessRunner = runProcess, executable = 'lighthouse'): LighthouseAdapter {
  return { async run(input) {
    if (input.mode !== 'navigation') throw new Error('Authenticated Lighthouse evidence requires a controlled timespan session.');
    const result = await runner(executable, [input.url, '--quiet', '--output=json', '--output-path=stdout', '--only-categories=performance',
      '--form-factor=mobile', '--screenEmulation.mobile=true', '--chrome-flags=--headless=new']);
    const report = navigationReport.parse(JSON.parse(result.stdout));
    return { kind: 'navigation', finalUrl: report.finalDisplayedUrl, performanceScore: report.categories.performance.score,
      metrics: metrics(report.audits, navigationMetrics), sessionEvidence: 'public-page' };
  } };
}

export type AuthenticatedLighthouseSession = { run(input: Parameters<LighthouseAdapter['run']>[0]): Promise<TimespanResult>; close(): Promise<void> };
export function authenticatedUserFlowAdapter(create: () => Promise<AuthenticatedLighthouseSession>): LighthouseAdapter {
  let session: Promise<AuthenticatedLighthouseSession> | undefined;
  return { async run(input) { if (input.mode !== 'timespan') throw new Error('The authenticated adapter supports only timespan measurements.');
      session ??= create(); return (await session).run(input); },
    async close() { if (session) await (await session).close(); } };
}

export async function createAuthenticatedLighthouseSession(authority: AwsAuthority,
  credential: () => Promise<{ email: string; password: string }>): Promise<AuthenticatedLighthouseSession> {
  const [{ default: puppeteer }, { startFlow }, { chromium }] = await Promise.all([import('puppeteer-core'), import('lighthouse'), import('@playwright/test')]);
  const userDataDir = await mkdtemp(join(tmpdir(), 'portal-lighthouse-')); await chmod(userDataDir, 0o700);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try { browser = await puppeteer.launch({ executablePath: chromium.executablePath(), headless: true, userDataDir,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'], dumpio: false }); }
  catch (error) { await rm(userDataDir, { recursive: true, force: true }); throw error; }
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  return { async run(input) {
    await page.goto(input.url, { waitUntil: 'networkidle0' });
    if (await page.$('#appointments-title')) throw new Error('Authenticated timespan must include managed reauthentication.');
    const flow = await startFlow(page, { name: 'Authenticated appointments mobile' });
    await flow.startTimespan({ name: 'Managed reauthentication to appointments' });
    const clicked = await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Sign in'); button?.click(); return Boolean(button); });
    if (!clicked) throw new Error('Authenticated Lighthouse could not start managed login.');
    await page.waitForFunction(() => Boolean(document.querySelector('#appointments-title') || document.querySelector('input[type="password"]')), { timeout: 30_000 });
    if (await page.$('input[type="password"]')) {
      assertManagedLoginOrigin(page.url(), authority);
      const secret = await credential();
      assertManagedLoginOrigin(page.url(), authority);
      const emailSelector = 'input[name="username"], input[type="email"]'; await page.waitForSelector(emailSelector, { visible: true });
      await page.type(emailSelector, secret.email); assertManagedLoginOrigin(page.url(), authority);
      await page.type('input[type="password"]', secret.password); assertManagedLoginOrigin(page.url(), authority);
      const submitted = await page.evaluate(() => { const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]') ?? document.querySelector<HTMLInputElement>('input[name="signInSubmitButton"]'); submit?.click(); return Boolean(submit); });
      if (!submitted) throw new Error('Authenticated Lighthouse could not submit managed login.');
    }
    await page.waitForSelector('#appointments-title', { visible: true, timeout: 30_000 });
    const valid = await page.evaluate(() => document.querySelector('#appointments-title')?.textContent?.trim() === 'Your appointments' &&
      [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Sign out'));
    if (!valid) throw new Error('Authenticated Lighthouse did not reach the authenticated appointment DOM.');
    await flow.endTimespan(); const result = await flow.createFlowResult(); const lhr = result.steps.at(-1)?.lhr;
    if (!lhr) throw new Error('Lighthouse timespan did not return a report.');
    const audits = z.object({ audits: z.record(z.string(), z.object({ numericValue: z.number().nonnegative().optional() })) }).parse(lhr).audits;
    return { kind: 'timespan', finalUrl: page.url(), metrics: metrics(audits, ['total-blocking-time', 'cumulative-layout-shift', 'interaction-to-next-paint']),
      sessionEvidence: 'authenticated-appointments' };
  }, async close() { try { await browser.close(); } finally { await rm(userDataDir, { recursive: true, force: true }); } } };
}

const assertTarget = (url: string, mode: 'public' | 'authenticated', manifest: DeploymentManifest): URL => {
  if (manifest.phase !== 'ready' || !manifest.sourceCommit) throw new Error('A ready manifest with an exact source commit is required for performance evidence.');
  const target = new URL(url); const frontend = new URL(manifest.outputs.FrontendUrl ?? 'about:blank');
  if (frontend.protocol !== 'https:' || frontend.username || frontend.password || frontend.search || frontend.hash ||
      (frontend.href !== frontend.origin && frontend.href !== `${frontend.origin}/`) || target.protocol !== 'https:' || target.username || target.password ||
      target.search || target.hash || target.origin !== frontend.origin) throw new Error('Performance target must be the exact deployed HTTPS origin without credentials, query, or fragment.');
  const expectedPath = mode === 'public' ? '/' : '/appointments';
  if (target.pathname !== expectedPath || target.href !== `${target.origin}${expectedPath}`) throw new Error(`Performance target must use exact ${expectedPath} path.`);
  return target;
};
const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
export async function measureWeb(input: { url: string; mode: 'public' | 'authenticated'; runs: number }, adapter: LighthouseAdapter,
  options: { manifest: DeploymentManifest; now?: () => Date }): Promise<WebMeasurement> {
  if (input.runs !== 3) throw new Error('Production performance evidence requires exactly three repeat runs.');
  const target = assertTarget(input.url, input.mode, options.manifest); const results: LighthouseResult[] = [];
  try { for (let i = 0; i < 3; i += 1) results.push(await adapter.run({ url: target.href, profile: 'mobile', mode: input.mode === 'public' ? 'navigation' : 'timespan' })); }
  finally { await adapter.close?.(); }
  if (results.some((result) => new URL(result.finalUrl).origin !== target.origin || Object.values(result.metrics).some((value) => !Number.isFinite(value) || value < 0) ||
      result.kind === 'navigation' && (!Number.isFinite(result.performanceScore) || result.performanceScore < 0 || result.performanceScore > 1))) {
    throw new Error('Lighthouse returned invalid or cross-origin results.');
  }
  const common = { commit: options.manifest.sourceCommit!, checkedAt: (options.now ?? (() => new Date()))().toISOString(), lighthouseVersion: LIGHTHOUSE_VERSION as typeof LIGHTHOUSE_VERSION,
    url: target.href, target: { origin: target.origin, path: target.pathname }, profile: 'mobile' as const, runCount: 3 as const };
  if (input.mode === 'public') {
    if (results.some((item) => item.kind !== 'navigation' || item.sessionEvidence !== 'public-page')) throw new Error('Public navigation evidence is invalid.');
    const runs = (results as NavigationResult[]).map((item) => ({ performanceScore: Math.round(item.performanceScore * 100), metrics: item.metrics }));
    const evidence: WebMeasurement = { ...common, measurement: 'public-navigation', mode: 'navigation', runs,
      medianPerformanceScore: median(runs.map((item) => item.performanceScore)), sessionEvidence: 'public-page' };
    return validateWebMeasurement(evidence, options.manifest, new Date(common.checkedAt));
  }
  if (results.some((item) => item.kind !== 'timespan' || item.sessionEvidence !== 'authenticated-appointments')) throw new Error('Authenticated measurement did not reach the authenticated appointment DOM.');
  const runs = results.map((item) => ({ metrics: item.metrics }));
  const names = Object.keys(runs[0]?.metrics ?? {}).filter((name) => runs.every((item) => item.metrics[name] !== undefined));
  const evidence: WebMeasurement = { ...common, measurement: 'authenticated-user-flow', mode: 'timespan', runs,
    medianMetrics: Object.fromEntries(names.map((name) => [name, median(runs.map((item) => item.metrics[name]!))])), sessionEvidence: 'authenticated-appointments' };
  return validateWebMeasurement(evidence, options.manifest, new Date(common.checkedAt));
}

export function validateWebMeasurement(value: unknown, manifest: DeploymentManifest, now = new Date()): WebMeasurement {
  const safeMetrics = (allowed: readonly string[]) => z.record(z.string(), z.number().nonnegative()).refine((metricsValue) =>
    Object.keys(metricsValue).every((name) => allowed.includes(name)), 'Performance evidence includes an unsupported metric.');
  const common = { commit: z.string().regex(/^[a-f0-9]{40}$/), checkedAt: z.iso.datetime({ offset: true }), lighthouseVersion: z.literal(LIGHTHOUSE_VERSION),
    url: z.url(), target: z.strictObject({ origin: z.url(), path: z.string() }), profile: z.literal('mobile'), runCount: z.literal(3) };
  const navMetrics = ['fcpMs', 'lcpMs', 'speedIndexMs', 'totalBlockingTimeMs', 'cumulativeLayoutShift'];
  const spanMetrics = ['totalBlockingTimeMs', 'cumulativeLayoutShift', 'interactionToNextPaintMs'];
  const schema = z.discriminatedUnion('measurement', [
    z.strictObject({ ...common, measurement: z.literal('public-navigation'), mode: z.literal('navigation'), sessionEvidence: z.literal('public-page'),
      runs: z.array(z.strictObject({ performanceScore: z.number().int().min(0).max(100), metrics: safeMetrics(navMetrics) })).length(3),
      medianPerformanceScore: z.number().int().min(0).max(100) }),
    z.strictObject({ ...common, measurement: z.literal('authenticated-user-flow'), mode: z.literal('timespan'), sessionEvidence: z.literal('authenticated-appointments'),
      runs: z.array(z.strictObject({ metrics: safeMetrics(spanMetrics) })).length(3), medianMetrics: safeMetrics(spanMetrics) }),
  ]);
  const base = schema.parse(value);
  const mode = base.measurement === 'public-navigation' ? 'public' : 'authenticated'; const target = assertTarget(base.url, mode, manifest);
  if (base.commit !== manifest.sourceCommit || base.mode !== (mode === 'public' ? 'navigation' : 'timespan')) throw new Error('Performance evidence identity or mode does not match the ready deployment.');
  const regenerated = JSON.stringify(value); if (/access_token|id_token|code=|email|@/i.test(regenerated)) throw new Error('Performance evidence contains prohibited authentication data.');
  const age = now.getTime() - new Date(base.checkedAt).getTime(); if (age < -300_000 || age > 21_600_000) throw new Error('Performance evidence is stale or outside the current deployment window.');
  if ((value as WebMeasurement).target.origin !== target.origin || (value as WebMeasurement).target.path !== target.pathname) throw new Error('Performance evidence target identity is invalid.');
  if (base.measurement === 'public-navigation' && median(base.runs.map((item) => item.performanceScore)) !== base.medianPerformanceScore) throw new Error('Public performance median is inconsistent.');
  if (base.measurement === 'authenticated-user-flow') for (const [name, metric] of Object.entries(base.medianMetrics)) {
    if (!base.runs.every((run) => run.metrics[name] !== undefined) || median(base.runs.map((run) => run.metrics[name]!)) !== metric) throw new Error('Authenticated metric median is inconsistent.');
  }
  return base as WebMeasurement;
}

const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV'] as const;
export function lighthouseWorkerEnvironment(environment: NodeJS.ProcessEnv, credentialFile: string, authority: AwsAuthority): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(CHILD_ENV.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]])),
    APPT_MEASURE_CREDENTIAL_FILE: credentialFile, APPT_MEASURE_ACCOUNT: authority.account, APPT_MEASURE_REGION: authority.region,
    APPT_MEASURE_ISSUER: authority.issuer, APPT_MEASURE_CLIENT_ID: authority.clientId, APPT_MEASURE_USER_POOL_ID: authority.userPoolId,
    APPT_MEASURE_COGNITO_DOMAIN: authority.cognitoDomain, APPT_MEASURE_FRONTEND_URL: authority.frontendUrl };
}
export function assertLighthousePrivacy(environment: NodeJS.ProcessEnv): void {
  const unsafe = Object.entries(environment).some(([name, value]) => value && (/^(NODE_DEBUG|NODE_OPTIONS|PWDEBUG|PUPPETEER_|CHROME_LOG_FILE|DUMPIO|VSCODE_INSPECTOR_OPTIONS|NODE_INSPECT|NODE_CHANNEL_FD)/i.test(name) ||
    /(?:REMOTE_DEBUG|DEVTOOLS|DEBUG_PORT|ENVPORT|DUMPIO)/i.test(name) || (/^(DEBUG)$/i.test(name) && /puppeteer|protocol|devtools/i.test(value)) ||
    /--inspect|diagnostic|envPort|dumpio|devtools|puppeteer:protocol/i.test(value)));
  if (unsafe) throw new Error('Authenticated Lighthouse refuses diagnostic or protocol-debug configuration.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [url, mode = 'public'] = process.argv.slice(2); if (!url || (mode !== 'public' && mode !== 'authenticated')) throw new Error('Usage: pnpm demo:measure -- <https-url> <public|authenticated>.');
    const manifest = await loadDeploymentManifest(); if (!manifest) throw new Error('A ready deployment manifest is required.');
    let result: WebMeasurement;
    if (mode === 'public') result = await measureWeb({ url, mode, runs: 3 }, lighthouseCliAdapter(), { manifest });
    else {
      const credentialFile = process.env.PORTAL_LIGHTHOUSE_CREDENTIAL_FILE; if (!credentialFile) throw new Error('Authenticated measurement requires one private controlled-account credential file.');
      const authority = authorityFromManifest(manifest); const child = await runProcess('pnpm', ['exec', 'tsx', 'scripts/measure-web-worker.ts', url],
        { env: lighthouseWorkerEnvironment(process.env, credentialFile, authority) });
      result = validateWebMeasurement(JSON.parse(child.stdout), manifest);
    }
    await writePrivateJson(resolve('.runtime/performance.json'), result);
    process.stdout.write(`Three ${result.measurement} mobile Lighthouse runs completed.\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Performance measurement failed.'}\n`); process.exitCode = 1; }
}
