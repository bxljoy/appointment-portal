import type { DeploymentManifest } from './lifecycle-types.js';
import { runProcess, type ProcessRunner } from './preflight.js';
import { isAwsRequestId, parseRequestIdMarkers } from './aws-request-id.js';
import { manualRegistrationCheck, type ManualRegistrationEvidence } from './manual-registration.js';
import type { CorrelationSummary } from './cloudwatch-correlation.js';

export { parseRequestIdMarkers } from './aws-request-id.js';

export type VerificationSummary = {
  commit: string;
  checkedAt: string;
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'manual-passed'; detail: string }>;
};
export type VerificationSuite = 'aws-auth' | 'aws-api' | 'aws-races';
export type VerificationAdapter = { run(suite: VerificationSuite): Promise<{ requestIds: string[]; unsafeDetail?: string }> };

const suites = [
  { id: 'aws-auth', name: 'deployed managed authentication', label: 'AWS auth suite' },
  { id: 'aws-api', name: 'deployed API and edge controls', label: 'AWS API suite' },
  { id: 'aws-races', name: 'deployed booking races', label: 'AWS race suite' },
] as const;
export type CorrelationAdapter = { observe(requestIds: string[]): Promise<CorrelationSummary> };

export function playwrightVerificationAdapter(environment: NodeJS.ProcessEnv, runner: ProcessRunner = runProcess): VerificationAdapter {
  return {
    async run(suite) {
      const projects = suite === 'aws-auth' ? ['--project=aws', '--project=aws-mobile'] : ['--project=aws'];
      const result = await runner('pnpm', ['exec', 'playwright', 'test', `tests/e2e/${suite}.spec.ts`, ...projects], { env: environment });
      return { requestIds: parseRequestIdMarkers(result.stdout) };
    },
  };
}

export async function verifyAws(manifest: DeploymentManifest, options: {
  adapter?: VerificationAdapter; environment?: NodeJS.ProcessEnv; correlation?: CorrelationAdapter;
  manualRegistration?: ManualRegistrationEvidence; now?: () => Date;
} = {}): Promise<VerificationSummary> {
  if (manifest.phase !== 'ready') throw new Error('A ready deployment manifest is required for AWS verification.');
  if (!manifest.sourceCommit || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new Error('An exact deployed source commit is required for AWS verification.');
  const adapter = options.adapter ?? (options.environment ? playwrightVerificationAdapter(options.environment) : undefined);
  if (!adapter) throw new Error('A sanitized AWS verification environment is required.');
  const checks: VerificationSummary['checks'] = [];
  const correlatedIds: string[] = [];
  const checkedAt = (options.now ?? (() => new Date()))();
  for (const suite of suites) {
    try {
      const observation = await adapter.run(suite.id);
      if (observation.requestIds.some((id) => !isAwsRequestId(id))) throw new Error('AWS verification returned an invalid request ID.');
      const requestIds = [...new Set(observation.requestIds)].sort();
      if (suite.id !== 'aws-auth' && requestIds.length === 0) throw new Error('AWS verification did not return a request ID.');
      checks.push({ name: suite.name, status: 'passed', detail: requestIds.length
        ? `${suite.label} passed; request IDs: ${requestIds.join(', ')}.`
        : `${suite.label} passed.` });
      correlatedIds.push(...requestIds);
    } catch (error) {
      if (error instanceof Error && /invalid request ID/i.test(error.message)) throw error;
      checks.push({ name: suite.name, status: 'failed', detail: `${suite.label} failed; inspect private request-correlated diagnostics.` });
    }
  }
  try {
    if (!options.correlation) throw new Error();
    const result = await options.correlation.observe([...new Set(correlatedIds)].sort());
    if (result.requestCount !== new Set(correlatedIds).size || result.coldCount + result.warmCount !== result.requestCount ||
        !Number.isInteger(result.maxDurationMs) || result.maxDurationMs < 0) throw new Error();
    checks.push({ name: 'request-correlated CloudWatch observations', status: 'passed',
      detail: `CloudWatch confirmed ${result.requestCount} request records: ${result.coldCount} cold and ${result.warmCount} warm; maximum observed application duration ${result.maxDurationMs} ms. This is diagnostic evidence, not an SLA.` });
  } catch {
    checks.push({ name: 'request-correlated CloudWatch observations', status: 'failed', detail: 'Request-correlated CloudWatch observations are incomplete.' });
  }
  checks.push(manualRegistrationCheck(manifest, options.manualRegistration, checkedAt));
  return { commit: manifest.sourceCommit, checkedAt: checkedAt.toISOString(), checks };
}
