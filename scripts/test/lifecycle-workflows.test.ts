import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Workflow = { on: { workflow_dispatch: unknown }; permissions: Record<string, string>;
  concurrency: Record<string, unknown>; jobs: Record<string, { environment: string; 'timeout-minutes': number;
    env?: Record<string, string>;
    services?: Record<string, { image: string; env?: Record<string, string>; ports?: string[]; options?: string }>;
    steps: { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: { path?: string; ref?: string; 'persist-credentials'?: boolean } }[] }> };
const workflow = async (name: string) => parse(await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Workflow;

describe('manual disposable environment workflows', () => {
  it.each(['demo', 'destroy'])('uses manual dispatch, OIDC, bounded non-cancelling concurrency, and timeouts in %s', async (name) => {
    const value = await workflow(name);
    expect(value.on.workflow_dispatch).toBeDefined();
    expect(value.permissions).toMatchObject({ 'id-token': 'write', contents: 'read' });
    expect(value.concurrency).toEqual({ group: 'appointment-portal-demo', 'cancel-in-progress': false });
    for (const job of Object.values(value.jobs)) {
      expect(job.environment).toBe('demo');
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(60);
    }
  });

  it('runs verification, captures sanitized inventory, and attempts application cleanup on failure', async () => {
    const value = await workflow('demo');
    const text = JSON.stringify(value);
    expect(text).toContain('pnpm demo:deploy');
    expect(text).toContain('pnpm demo:destroy -- --force-disposable-secrets');
    expect(text).toContain('.runtime/deployment.json');
    expect(text).not.toContain('.runtime/credentials');
    expect(text).not.toMatch(/AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/);
    expect(text).toContain('pnpm demo:diagnostics');
    expect(text).toContain('.runtime/diagnostics.json');
  });

  it('takes a validated Lambda concurrency mode from the demo environment with the reserved default', async () => {
    const value = await workflow('demo');
    expect(value.jobs['deploy-and-verify']!.env?.LAMBDA_CONCURRENCY_MODE)
      .toBe("${{ vars.LAMBDA_CONCURRENCY_MODE || 'reserved' }}");
  });

  it('installs the browser before tests and deployment', async () => {
    const text = JSON.stringify(await workflow('demo'));
    expect(text).toContain('playwright install --with-deps chromium');
    expect(text.indexOf('playwright install --with-deps chromium')).toBeLessThan(text.indexOf('pnpm test'));
    expect(text.indexOf('playwright install --with-deps chromium')).toBeLessThan(text.indexOf('pnpm demo:deploy'));
  });

  it('builds workspace contract exports after a fresh install and before typechecking', async () => {
    const value = await workflow('demo');
    const gates = value.jobs['deploy-and-verify']!.steps.find((step) => step.name === 'Install and run local quality gates')!.run!;
    const install = gates.indexOf('pnpm install --frozen-lockfile --ignore-scripts');
    const contracts = gates.indexOf('pnpm --filter @portal/contracts build');
    const typecheck = gates.indexOf('pnpm typecheck');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(contracts).toBeGreaterThan(install);
    expect(contracts).toBeLessThan(typecheck);
    expect(gates.match(/pnpm --filter @portal\/contracts build/g)).toHaveLength(1);
  });

  it('runs database tests against the pinned local PostgreSQL service without AWS credentials', async () => {
    const value = await workflow('demo');
    const job = value.jobs['deploy-and-verify']!;
    expect(job.services?.postgres).toEqual({
      image: 'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929',
      env: { POSTGRES_USER: 'portal', POSTGRES_DB: 'portal', POSTGRES_HOST_AUTH_METHOD: 'trust' },
      ports: ['127.0.0.1:54329:5432'],
      options: '--health-cmd pg_isready --health-interval 2s --health-timeout 3s --health-retries 20',
    });
    expect(job.env).toMatchObject({
      DATABASE_URL: 'postgres://portal@127.0.0.1:54329/portal', AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
    });
    const gates = job.steps.findIndex((step) => step.name === 'Install and run local quality gates');
    const credentials = job.steps.findIndex((step) => step.uses?.includes('configure-aws-credentials'));
    expect(gates).toBeGreaterThanOrEqual(0);
    expect(credentials).toBeGreaterThan(gates);
  });

  it('uploads failure diagnostics only after their artifact scan succeeds', async () => {
    const value = await workflow('demo');
    const steps = value.jobs['deploy-and-verify']!.steps;
    const scan = steps.find((step) => step.run?.includes('pnpm demo:diagnostics'))!;
    const diagnosticUpload = steps.find((step) => step.uses?.includes('upload-artifact') && step.with?.path?.includes('diagnostics.json'))!;
    expect(scan.id).toBeTruthy();
    expect(scan.run).toContain('pnpm check:artifacts -- --additional-only .runtime/diagnostics.json');
    expect(diagnosticUpload.if).toContain(`steps.${scan.id}.outcome == 'success'`);
    expect(diagnosticUpload.if).toContain('failure()');
    const unconditionalUpload = steps.find((step) => step.uses?.includes('upload-artifact') && step.if === 'always()');
    expect(unconditionalUpload?.with?.path).not.toContain('diagnostics.json');
  });

  it('restores an explicit manifest and dry-runs before deleting', async () => {
    const value = await workflow('destroy');
    const text = JSON.stringify(value);
    const branchGate = "github.ref != format('refs/heads/{0}', vars.DEMO_BRANCH)";
    expect(text.indexOf('pnpm demo:destroy -- --dry-run')).toBeLessThan(text.indexOf('pnpm demo:destroy -- --force-disposable-secrets'));
    expect(text).toContain('pnpm demo:verify-cleanup');
    expect(text).toContain(branchGate);
    expect(text.indexOf(branchGate)).toBeLessThan(text.indexOf('configure-aws-credentials'));
    expect(text).toContain('pnpm demo:restore-manifest');
    expect(text).not.toContain('demo_head_sha');
    expect(text).toContain('${{ github.sha }}');
    expect(text).not.toContain('gh run download');
    expect(Object.keys((value.on.workflow_dispatch as { inputs: object }).inputs)).toEqual(['demo_run_id']);
    const checkout = value.jobs.destroy!.steps.find((step) => step.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(text.indexOf('pnpm demo:restore-manifest')).toBeLessThan(text.indexOf('configure-aws-credentials'));
  });

  it('runs the high-severity dependency audit before deployment', async () => {
    const text = JSON.stringify(await workflow('demo'));
    expect(text).toContain('pnpm audit --audit-level high');
    expect(text.indexOf('pnpm audit --audit-level high')).toBeLessThan(text.indexOf('pnpm demo:deploy'));
  });
});
