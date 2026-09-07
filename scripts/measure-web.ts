import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { runProcess, type ProcessRunner } from './preflight.js';
import { readPrivateFile, writePrivateJson } from './private-file.js';

export const LIGHTHOUSE_VERSION = '13.4.1';
export type LighthouseResult = { finalUrl: string; performance: number; metrics: Record<string, number>;
  sessionEvidence?: 'public-page' | 'sign-in' | 'authenticated-appointments' };
export type LighthouseAdapter = {
  run(input: { url: string; profile: 'mobile'; mode: 'navigation' | 'user-flow' }): Promise<LighthouseResult>;
  close?(): Promise<void>;
};

export type WebMeasurement = {
  commit: string; checkedAt: string; lighthouseVersion: typeof LIGHTHOUSE_VERSION;
  url: string; target: { origin: string; path: string };
  measurement: 'public-navigation' | 'authenticated-user-flow'; mode: 'navigation' | 'user-flow'; profile: 'mobile'; runCount: 3;
  runs: Array<{ performance: number; metrics: Record<string, number> }>;
  medianPerformance: number;
};

const lighthouseReportSchema = z.object({
  finalDisplayedUrl: z.url(),
  categories: z.object({ performance: z.object({ score: z.number().min(0).max(1) }) }),
  audits: z.record(z.string(), z.object({ numericValue: z.number().nonnegative().optional() })),
});
const measurementSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/), checkedAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  lighthouseVersion: z.literal(LIGHTHOUSE_VERSION),
  url: z.url().startsWith('https://'), target: z.strictObject({ origin: z.url().startsWith('https://'), path: z.string().startsWith('/') }),
  measurement: z.enum(['public-navigation', 'authenticated-user-flow']), mode: z.enum(['navigation', 'user-flow']),
  profile: z.literal('mobile'), runCount: z.literal(3),
  runs: z.array(z.strictObject({ performance: z.number().int().min(0).max(100), metrics: z.record(z.string(), z.number().nonnegative()) })).length(3),
  medianPerformance: z.number().int().min(0).max(100),
}).refine((value) => value.mode === (value.measurement === 'public-navigation' ? 'navigation' : 'user-flow'),
  'Performance measurement mode is inconsistent.')
  .refine((value) => [...value.runs].sort((left, right) => left.performance - right.performance)[1]?.performance === value.medianPerformance,
    'Performance median is inconsistent.');

const metricsFromReport = (raw: unknown): LighthouseResult => {
  const report = lighthouseReportSchema.parse(raw);
  const metric = (name: string) => report.audits[name]?.numericValue;
  return { finalUrl: report.finalDisplayedUrl, performance: report.categories.performance.score,
    metrics: Object.fromEntries([['fcpMs', metric('first-contentful-paint')], ['lcpMs', metric('largest-contentful-paint')],
      ['speedIndexMs', metric('speed-index')], ['totalBlockingTimeMs', metric('total-blocking-time')],
      ['cumulativeLayoutShift', metric('cumulative-layout-shift')]].filter((entry): entry is [string, number] => entry[1] !== undefined)) };
};

export function lighthouseCliAdapter(runner: ProcessRunner = runProcess, executable = 'lighthouse'): LighthouseAdapter {
  return {
    async run(input) {
      if (input.mode !== 'navigation') throw new Error('Authenticated Lighthouse evidence requires a controlled user-flow session.');
      const result = await runner(executable, [input.url, '--quiet', '--output=json', '--output-path=stdout', '--only-categories=performance',
        '--form-factor=mobile', '--screenEmulation.mobile=true', '--chrome-flags=--headless=new']);
      return { ...metricsFromReport(JSON.parse(result.stdout)), sessionEvidence: 'public-page' };
    },
  };
}

export type AuthenticatedLighthouseSession = { run(input: Parameters<LighthouseAdapter['run']>[0]): Promise<LighthouseResult>; close(): Promise<void> };
export function authenticatedUserFlowAdapter(create: () => Promise<AuthenticatedLighthouseSession>): LighthouseAdapter {
  let session: Promise<AuthenticatedLighthouseSession> | undefined;
  return {
    async run(input) {
      if (input.mode !== 'user-flow') throw new Error('The authenticated adapter supports only user-flow measurements.');
      session ??= create();
      return (await session).run(input);
    },
    async close() { if (session) await (await session).close(); },
  };
}

export async function createAuthenticatedLighthouseSession(credentials: { email: string; password: string }): Promise<AuthenticatedLighthouseSession> {
  const [{ default: puppeteer }, { startFlow }, { chromium }] = await Promise.all([
    import('puppeteer-core'), import('lighthouse'), import('@playwright/test'),
  ]);
  const userDataDir = await mkdtemp(join(tmpdir(), 'portal-lighthouse-'));
  await chmod(userDataDir, 0o700);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try {
    browser = await puppeteer.launch({ executablePath: chromium.executablePath(), headless: true, userDataDir,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
  let page: Awaited<ReturnType<typeof browser.newPage>>;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  } catch (error) {
    try { await browser.close(); } finally { await rm(userDataDir, { recursive: true, force: true }); }
    throw error;
  }
  return {
    async run(input) {
      await page.goto(input.url, { waitUntil: 'networkidle0' });
      let authenticated = await page.$('#appointments-title');
      if (!authenticated) {
        const clicked = await page.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Sign in');
          button?.click(); return Boolean(button);
        });
        if (!clicked) throw new Error('Authenticated Lighthouse could not start managed login.');
        await page.waitForFunction(() => Boolean(document.querySelector('#appointments-title') || document.querySelector('input[type="password"]')),
          { timeout: 30_000 });
        const password = await page.$('input[type="password"]');
        if (password) {
          const emailSelector = 'input[name="username"], input[type="email"]';
          await page.waitForSelector(emailSelector, { visible: true });
          await page.type(emailSelector, credentials.email);
          await page.type('input[type="password"]', credentials.password);
          const submitted = await page.evaluate(() => {
            const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]') ??
              document.querySelector<HTMLInputElement>('input[name="signInSubmitButton"]');
            submit?.click(); return Boolean(submit);
          });
          if (!submitted) throw new Error('Authenticated Lighthouse could not submit managed login.');
        }
        await page.waitForSelector('#appointments-title', { visible: true, timeout: 30_000 });
        authenticated = await page.$('#appointments-title');
      }
      const hasSessionEvidence = Boolean(authenticated) && await page.evaluate(() => {
        const title = document.querySelector('#appointments-title')?.textContent?.trim();
        const signOut = [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Sign out');
        return title === 'Your appointments' && signOut;
      });
      if (!hasSessionEvidence) throw new Error('Authenticated Lighthouse did not reach the authenticated appointment DOM.');
      const flow = await startFlow(page, { name: 'Authenticated appointments mobile' });
      await flow.snapshot({ name: 'Authenticated appointment DOM' });
      const flowResult = await flow.createFlowResult();
      const lhr = flowResult.steps.at(-1)?.lhr;
      if (!lhr) throw new Error('Lighthouse user-flow did not return a report.');
      return { ...metricsFromReport(lhr), finalUrl: page.url(), sessionEvidence: 'authenticated-appointments' };
    },
    async close() {
      try { await browser.close(); } finally { await rm(userDataDir, { recursive: true, force: true }); }
    },
  };
}

const assertReadyMeasurementManifest = (manifest: DeploymentManifest, target: URL): string => {
  if (manifest.phase !== 'ready' || !manifest.sourceCommit) throw new Error('A ready manifest with an exact source commit is required for performance evidence.');
  const frontend = manifest.outputs.FrontendUrl;
  if (!frontend || new URL(frontend).origin !== target.origin) throw new Error('Performance target does not match the ready deployment manifest.');
  return manifest.sourceCommit;
};

export async function measureWeb(input: { url: string; mode: 'public' | 'authenticated'; runs: number }, adapter: LighthouseAdapter,
  options: { manifest: DeploymentManifest; now?: () => Date }): Promise<WebMeasurement> {
  if (input.runs !== 3) throw new Error('Production performance evidence requires exactly three repeat runs.');
  const target = new URL(input.url);
  if (target.protocol !== 'https:') throw new Error('Production performance measurements require HTTPS.');
  const commit = assertReadyMeasurementManifest(options.manifest, target);
  if (target.username || target.password || target.hash) throw new Error('Performance target must not contain credentials or a fragment.');
  if (input.mode === 'public' && !/^\/(?:clinicians(?:\/[A-Za-z0-9_-]+)?)?\/?$/.test(target.pathname)) {
    throw new Error('Public navigation measurements require a public route.');
  }
  if (input.mode === 'authenticated' && !/^\/appointments\/?$/.test(target.pathname)) {
    throw new Error('Authenticated measurements require the appointments route.');
  }
  const mode = input.mode === 'authenticated' ? 'user-flow' as const : 'navigation' as const;
  const runs: WebMeasurement['runs'] = [];
  try {
    for (let index = 0; index < input.runs; index += 1) {
      const result = await adapter.run({ url: target.href, profile: 'mobile', mode });
      const finalUrl = new URL(result.finalUrl);
      if (finalUrl.origin !== target.origin) throw new Error('Lighthouse finished at an unexpected origin.');
      if (input.mode === 'authenticated' && result.sessionEvidence !== 'authenticated-appointments') {
        throw new Error('Authenticated measurement did not reach the authenticated appointment DOM.');
      }
      if (!Number.isFinite(result.performance) || result.performance < 0 || result.performance > 1 ||
          Object.values(result.metrics).some((metric) => !Number.isFinite(metric) || metric < 0)) throw new Error('Lighthouse returned invalid numeric results.');
      runs.push({ performance: Math.round(result.performance * 100), metrics: { ...result.metrics } });
    }
  } finally { await adapter.close?.(); }
  const ordered = runs.map(({ performance }) => performance).sort((left, right) => left - right);
  return measurementSchema.parse({ commit, checkedAt: (options.now ?? (() => new Date()))().toISOString(), lighthouseVersion: LIGHTHOUSE_VERSION,
    url: target.href, target: { origin: target.origin, path: `${target.pathname}${target.search}` },
    measurement: input.mode === 'authenticated' ? 'authenticated-user-flow' : 'public-navigation', mode, profile: 'mobile', runCount: 3,
    runs, medianPerformance: ordered[1]! });
}

export function validateWebMeasurement(value: unknown, manifest: DeploymentManifest, now = new Date()): WebMeasurement {
  if (manifest.phase !== 'ready') throw new Error('Ready deployment manifest required for performance evidence.');
  const evidence = measurementSchema.parse(value);
  if (evidence.commit !== manifest.sourceCommit) throw new Error('Performance evidence commit does not match the ready deployment.');
  const frontend = manifest.outputs.FrontendUrl;
  if (!frontend || evidence.target.origin !== new URL(frontend).origin || evidence.url !== `${evidence.target.origin}${evidence.target.path}`) {
    throw new Error('Performance evidence target does not match the ready deployment.');
  }
  const age = now.getTime() - new Date(evidence.checkedAt).getTime();
  if (age < -5 * 60_000 || age > 6 * 60 * 60_000) throw new Error('Performance evidence is stale or outside the current deployment window.');
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [url, mode = 'public'] = process.argv.slice(2);
    if (!url || (mode !== 'public' && mode !== 'authenticated')) throw new Error('Usage: pnpm demo:measure -- <https-url> <public|authenticated>.');
    const manifest = await loadDeploymentManifest();
    if (!manifest) throw new Error('A ready deployment manifest is required.');
    let adapter: LighthouseAdapter;
    if (mode === 'public') adapter = lighthouseCliAdapter();
    else {
      const credentialPath = process.env.PORTAL_LIGHTHOUSE_CREDENTIAL_FILE;
      if (!credentialPath) throw new Error('Authenticated measurement requires one private controlled-account credential file.');
      const credential = z.object({ email: z.email(), password: z.string().min(12), role: z.literal('patient') })
        .parse(JSON.parse(await readPrivateFile(credentialPath, 16_384)));
      adapter = authenticatedUserFlowAdapter(() => createAuthenticatedLighthouseSession(credential));
    }
    const result = await measureWeb({ url, mode, runs: 3 }, adapter, { manifest });
    await writePrivateJson(resolve('.runtime/performance.json'), result);
    process.stdout.write(`Three ${result.measurement} mobile Lighthouse runs completed; median performance ${result.medianPerformance}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Performance measurement failed.'}\n`);
    process.exitCode = 1;
  }
}
