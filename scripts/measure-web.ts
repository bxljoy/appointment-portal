import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runProcess, type ProcessRunner } from './preflight.js';
import { writePrivateJson } from './private-file.js';

export type LighthouseAdapter = {
  run(input: { url: string; profile: 'mobile'; mode: 'navigation' | 'user-flow' }): Promise<{
    finalUrl: string; performance: number; metrics: Record<string, number>;
  }>;
};

export type WebMeasurement = {
  url: string;
  measurement: 'public-navigation' | 'authenticated-user-flow';
  profile: 'mobile';
  runs: Array<{ performance: number; metrics: Record<string, number> }>;
  medianPerformance: number;
};

const lighthouseReportSchema = z.object({
  finalDisplayedUrl: z.url().startsWith('https://'),
  categories: z.object({ performance: z.object({ score: z.number().min(0).max(1) }) }),
  audits: z.record(z.string(), z.object({ numericValue: z.number().nonnegative().optional() })),
});

export function lighthouseCliAdapter(runner: ProcessRunner = runProcess, executable = 'lighthouse'): LighthouseAdapter {
  return {
    async run(input) {
      if (input.mode !== 'navigation') throw new Error('Authenticated Lighthouse evidence requires an injected user-flow adapter with an active in-memory session.');
      const result = await runner(executable, [input.url, '--quiet', '--output=json', '--output-path=stdout', '--only-categories=performance',
        '--form-factor=mobile', '--screenEmulation.mobile=true', '--chrome-flags=--headless=new --no-sandbox']);
      const report = lighthouseReportSchema.parse(JSON.parse(result.stdout));
      const metric = (name: string) => report.audits[name]?.numericValue;
      return { finalUrl: report.finalDisplayedUrl, performance: report.categories.performance.score,
        metrics: Object.fromEntries([['fcpMs', metric('first-contentful-paint')], ['lcpMs', metric('largest-contentful-paint')],
          ['speedIndexMs', metric('speed-index')], ['totalBlockingTimeMs', metric('total-blocking-time')],
          ['cumulativeLayoutShift', metric('cumulative-layout-shift')]].filter((entry): entry is [string, number] => entry[1] !== undefined)) };
    },
  };
}

export async function measureWeb(input: { url: string; mode: 'public' | 'authenticated'; runs: number }, adapter: LighthouseAdapter): Promise<WebMeasurement> {
  if (input.runs !== 3) throw new Error('Production performance evidence requires exactly three repeat runs.');
  const target = new URL(input.url);
  if (target.protocol !== 'https:') throw new Error('Production performance measurements require HTTPS.');
  if (input.mode === 'public' && !/^\/(?:clinicians(?:\/[A-Za-z0-9_-]+)?)?\/?$/.test(target.pathname)) {
    throw new Error('Public navigation measurements require a public route.');
  }
  const mode = input.mode === 'authenticated' ? 'user-flow' as const : 'navigation' as const;
  const runs: WebMeasurement['runs'] = [];
  for (let index = 0; index < input.runs; index += 1) {
    const result = await adapter.run({ url: target.href, profile: 'mobile', mode });
    const finalUrl = new URL(result.finalUrl);
    if (finalUrl.origin !== target.origin) throw new Error('Lighthouse finished at an unexpected origin.');
    if (input.mode === 'authenticated' && /\/(?:auth\/callback|signed-out|sign-?in)(?:\/|$)/i.test(finalUrl.pathname)) {
      throw new Error('Authenticated measurement reached the sign-in page instead of the requested route.');
    }
    if (!Number.isFinite(result.performance) || result.performance < 0 || result.performance > 1 ||
        Object.values(result.metrics).some((metric) => !Number.isFinite(metric) || metric < 0)) {
      throw new Error('Lighthouse returned invalid numeric results.');
    }
    runs.push({ performance: Math.round(result.performance * 100), metrics: { ...result.metrics } });
  }
  const ordered = runs.map(({ performance }) => performance).sort((left, right) => left - right);
  return {
    url: target.href,
    measurement: input.mode === 'authenticated' ? 'authenticated-user-flow' : 'public-navigation',
    profile: 'mobile', runs, medianPerformance: ordered[1]!,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [url, mode = 'public'] = process.argv.slice(2);
    if (!url || (mode !== 'public' && mode !== 'authenticated')) throw new Error('Usage: pnpm demo:measure -- <https-url> <public|authenticated>.');
    const result = await measureWeb({ url, mode, runs: 3 }, lighthouseCliAdapter());
    await writePrivateJson(resolve('.runtime/performance.json'), result);
    process.stdout.write(`Three ${result.measurement} mobile Lighthouse runs completed; median performance ${result.medianPerformance}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Performance measurement failed.'}\n`);
    process.exitCode = 1;
  }
}
