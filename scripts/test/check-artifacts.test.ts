import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArtifacts, productionDirectories } from '../check-artifacts.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'portal-artifact-guard-'));
  try {
    for (const directory of productionDirectories) { await mkdir(join(root, directory), { recursive: true }); await writeFile(join(root, directory, 'index.js'), 'export const application = true;'); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe('production and sensitive-runtime artifact inspection', () => {
  it('accepts clean generated artifacts and documentation containing example credentials', () => fixture(async (root) => {
    await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/example.md'), 'patient-a X-Local-Actor E2E_PASSWORD_DO_NOT_DEPLOY');
    await checkArtifacts(root, ['docs/example.md', 'docs/reports/example.md', 'docs/error-context-example.md', '.env.example', 'infra/assets/rds-global-bundle.pem']);
  }));
  it.each(['X-Local-Actor', 'LOCAL_AUTH_DEVELOPMENT_ONLY', 'local-session', 'dev-toolbar', 'patient-a', 'clinician-b', 'E2E_PASSWORD_DO_NOT_DEPLOY', 'PORTAL_E2E_PASSWORD_SENTINEL', 'Only-in-memory-password!234', 'Stored-password!234', 'Runtime-secret!234', 'test-only-bootstrap-password', 'test-only-before-rollback', 'fixture-memory-only', 'fixture-memory-token'])('rejects a generated artifact containing %s', (sentinel) => fixture(async (root) => {
    await writeFile(join(root, 'apps/web/dist/injected.js'), `const value = ${JSON.stringify(sentinel)};`);
    await expect(checkArtifacts(root, [])).rejects.toThrow(/Unsafe artifacts/);
  }));
  it('rejects a token-bearing production runtime configuration', () => fixture(async (root) => {
    await writeFile(join(root, 'apps/web/dist/config.json'), JSON.stringify({ mode: 'cognito', access_token: 'fixture-only-token' }));
    await expect(checkArtifacts(root, [])).rejects.toThrow(/Unsafe artifacts/);
  }));
  it.each(['.runtime/account.json', '.auth/state.json', 'test-results/a/trace.zip', 'playwright-report/index.html', 'traces/auth.zip', 'storage-state/state.json', '.env.production', 'private.key', 'reports/index.html', 'reports/login/error-context.md', 'error-context/login.md', 'tests/e2e/error-context.md', 'tests/e2e/storage/account.json', 'tests/e2e/playwright-results/login.json', 'tests/e2e/playwright-reports/login.html', 'blob-report/results.zip', 'docs/.runtime/notes.md'])('rejects sensitive tracked runtime path %s', (path) => fixture(async (root) => {
    await expect(checkArtifacts(root, [path])).rejects.toThrow(/Unsafe artifacts/);
  }));
  it('fails closed for a missing required build', () => fixture(async (root) => {
    await rm(join(root, 'apps/web/dist'), { recursive: true }); await expect(checkArtifacts(root, [])).rejects.toThrow();
  }));
  it('does not follow artifact symlinks', () => fixture(async (root) => {
    await symlink(join(root, 'apps/web/dist/index.js'), join(root, 'apps/web/dist/link.js')); await expect(checkArtifacts(root, [])).rejects.toThrow(/symlinks/);
  }));
  it.each(['apps', 'apps/web', 'apps/web/dist'])('rejects the %s symlink before reading any external contents', (ancestor) => fixture(async (root) => {
    const external = await mkdtemp(join(tmpdir(), 'portal-outside-checkout-'));
    try {
      const targetBuild = join(external, ...'apps/web/dist'.split('/').slice(ancestor.split('/').length));
      await mkdir(targetBuild, { recursive: true });
      await writeFile(join(targetBuild, 'outside.js'), 'patient-a');
      // Even listing the target is forbidden. The error must come from the symlink check, not EACCES or a content scan.
      await chmod(external, 0o000);
      await rm(join(root, ancestor), { recursive: true });
      await symlink(external, join(root, ancestor));
      await expect(checkArtifacts(root, [])).rejects.toThrow(/symlinks/);
    } finally { await chmod(external, 0o700); await rm(external, { recursive: true, force: true }); }
  }));
});
