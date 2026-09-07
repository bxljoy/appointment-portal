import type { DeploymentManifest } from './lifecycle-types.js';
import { runProcess, type ProcessRunner } from './preflight.js';

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
const requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const marker = /PORTAL_REQUEST_ID:([A-Za-z0-9_-]{8,128})/g;

export function playwrightVerificationAdapter(environment: NodeJS.ProcessEnv, runner: ProcessRunner = runProcess): VerificationAdapter {
  return {
    async run(suite) {
      const projects = suite === 'aws-auth' ? ['--project=aws', '--project=aws-mobile'] : ['--project=aws'];
      const result = await runner('pnpm', ['exec', 'playwright', 'test', `tests/e2e/${suite}.spec.ts`, ...projects], { env: environment });
      return { requestIds: [...result.stdout.matchAll(marker)].map((match) => match[1]!) };
    },
  };
}

export async function verifyAws(manifest: DeploymentManifest, options: {
  adapter?: VerificationAdapter; environment?: NodeJS.ProcessEnv; now?: () => Date;
} = {}): Promise<VerificationSummary> {
  if (manifest.phase !== 'ready') throw new Error('A ready deployment manifest is required for AWS verification.');
  if (!manifest.sourceCommit || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new Error('An exact deployed source commit is required for AWS verification.');
  const adapter = options.adapter ?? (options.environment ? playwrightVerificationAdapter(options.environment) : undefined);
  if (!adapter) throw new Error('A sanitized AWS verification environment is required.');
  const checks: VerificationSummary['checks'] = [];
  for (const suite of suites) {
    try {
      const observation = await adapter.run(suite.id);
      if (observation.requestIds.some((id) => !requestIdPattern.test(id))) throw new Error('AWS verification returned an invalid request ID.');
      const requestIds = [...new Set(observation.requestIds)].sort();
      if (suite.id !== 'aws-auth' && requestIds.length === 0) throw new Error('AWS verification did not return a request ID.');
      checks.push({ name: suite.name, status: 'passed', detail: requestIds.length
        ? `${suite.label} passed; request IDs: ${requestIds.join(', ')}.`
        : `${suite.label} passed.` });
    } catch (error) {
      if (error instanceof Error && /invalid request ID/i.test(error.message)) throw error;
      checks.push({ name: suite.name, status: 'failed', detail: `${suite.label} failed; inspect private request-correlated diagnostics.` });
    }
  }
  return { commit: manifest.sourceCommit, checkedAt: (options.now ?? (() => new Date()))().toISOString(), checks };
}
