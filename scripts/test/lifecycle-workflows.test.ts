import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Workflow = { on: { workflow_dispatch: unknown }; permissions: Record<string, string>;
  concurrency: Record<string, unknown>; jobs: Record<string, { environment: string; 'timeout-minutes': number }> };
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

  it('installs the AWS verification browser before deployment', async () => {
    const text = JSON.stringify(await workflow('demo'));
    expect(text).toContain('playwright install --with-deps chromium');
    expect(text.indexOf('playwright install --with-deps chromium')).toBeLessThan(text.indexOf('pnpm demo:deploy'));
  });

  it('restores an explicit manifest and dry-runs before deleting', async () => {
    const value = await workflow('destroy');
    const text = JSON.stringify(value);
    expect(text.indexOf('pnpm demo:destroy -- --dry-run')).toBeLessThan(text.indexOf('pnpm demo:destroy -- --force-disposable-secrets'));
    expect(text).toContain('pnpm demo:verify-cleanup');
    expect(text.indexOf('github.ref_name != vars.DEMO_BRANCH')).toBeLessThan(text.indexOf('configure-aws-credentials'));
  });
});
