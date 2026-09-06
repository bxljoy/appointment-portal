import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

type Workflow = { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, { permissions?: unknown; services?: Record<string, { image: string }>; steps: { uses?: string; run?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean }[] }> };
function validate(text: string) {
  const parsed = parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length) throw new Error('Invalid workflow YAML.');
  const workflow = parsed.toJS() as Workflow;
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(text).not.toMatch(/secrets\.|id-token|configure-aws-credentials|pull_request_target/);
  const job = workflow.jobs.quality!;
  expect(job.permissions).toBeUndefined();
  expect(job.services?.postgres?.image ?? '').toMatch(/^postgres:17\./);
  for (const step of job.steps) { if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/); expect(step['continue-on-error']).toBeUndefined(); }
  expect(job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.['persist-credentials']).toBe(false);
  expect(job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version-file']).toBe('.nvmrc');
  expect(job.steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'))?.with?.version).toBe('11.22.0');
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  for (const gate of ['install --frozen-lockfile --ignore-scripts', 'pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'build:lambdas', 'pnpm check:infra', 'pnpm check:bundles', 'pnpm check:artifacts', 'pnpm audit', 'playwright install --with-deps chromium', 'playwright test --project=local-desktop --project=local-mobile']) expect(commands).toContain(gate);
  expect(commands.indexOf('pnpm --filter @portal/contracts build')).toBeGreaterThan(commands.indexOf('install --frozen-lockfile --ignore-scripts'));
  expect(commands.indexOf('pnpm --filter @portal/contracts build')).toBeLessThan(commands.indexOf('pnpm typecheck'));
  expect(commands).not.toMatch(/\|\|\s*true|--project=aws/);
}

describe('read-only pull-request workflow', () => {
  it('enforces local quality gates without cloud secrets or writable credentials', async () => validate(await readFile(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8')));
  it('rejects duplicate YAML keys before evaluating the workflow', () => expect(() => validate('name: a\nname: b')).toThrow('Invalid workflow YAML'));
});
