import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { restoreDeploymentManifest, validateDestroyProvenance } from '../destroy-provenance.js';
import { manifest } from './fakes.js';

const expected = { account: manifest.account, region: manifest.region, repository: 'OWNER/REPOSITORY', workflowPath: '.github/workflows/demo.yml',
  branch: 'main', headSha: 'a'.repeat(40), artifactName: 'deployment-manifest', runId: '42' } as const;
const run = { id: 42, repository: { full_name: expected.repository }, path: expected.workflowPath, head_branch: expected.branch, head_sha: expected.headSha,
  conclusion: 'success', status: 'completed' };
const artifact = { name: expected.artifactName, expired: false, expires_at: '2031-06-01T00:00:00Z', digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 42, head_sha: expected.headSha } };

describe('destroy artifact provenance', () => {
  it('accepts a successful exact workflow, repository, branch, commit and unexpired digest-bound artifact', () => {
    expect(validateDestroyProvenance(run, [artifact], expected)).toMatchObject({ headSha: expected.headSha, digest: artifact.digest });
  });
  it.each([
    ['repository', { ...run, repository: { full_name: 'ATTACKER/REPOSITORY' } }, artifact],
    ['workflow', { ...run, path: '.github/workflows/other.yml' }, artifact],
    ['branch', { ...run, head_branch: 'evil' }, artifact],
    ['commit', { ...run, head_sha: 'c'.repeat(40) }, artifact],
    ['run id', { ...run, id: 41 }, artifact],
    ['conclusion', { ...run, conclusion: 'failure' }, artifact],
    ['expiry', run, { ...artifact, expired: true }],
    ['expiry timestamp', run, { ...artifact, expires_at: '2020-06-01T00:00:00Z' }],
    ['digest', run, { ...artifact, digest: undefined }],
    ['artifact run', run, { ...artifact, workflow_run: { ...artifact.workflow_run, id: 41 } }],
  ])('rejects mismatched %s provenance', (_name, candidateRun, candidateArtifact) => {
    expect(() => validateDestroyProvenance(candidateRun, [candidateArtifact], expected)).toThrow(/provenance/i);
  });

  it('queries run and artifact metadata before download and binds the downloaded manifest to validated authority', async () => {
    const runtime = await mkdtemp(join(await realpath(tmpdir()), 'portal-provenance-'));
    const calls: string[] = [];
    try {
      await restoreDeploymentManifest(expected, { runtimeDirectory: runtime, runner: async (_executable, args) => {
        calls.push(args.join(' '));
        if (args[1]?.includes('/actions/runs/42/artifacts')) return { stdout: JSON.stringify([{ artifacts: [artifact] }]), stderr: '' };
        if (args[1]?.includes('/actions/runs/42')) return { stdout: JSON.stringify(run), stderr: '' };
        await writeFile(join(runtime, 'deployment.json'), JSON.stringify({ ...manifest, repository: expected.repository,
          branch: expected.branch, sourceCommit: expected.headSha }), { mode: 0o600 });
        return { stdout: '', stderr: '' };
      } });
      expect(calls[0]).toContain('/actions/runs/42');
      expect(calls[1]).toContain('/actions/runs/42/artifacts');
      expect(calls[2]).toContain('run download 42');
      expect(JSON.parse(await readFile(join(runtime, 'destroy-provenance.json'), 'utf8'))).toMatchObject({
        account: expected.account, region: expected.region, repository: expected.repository, headSha: expected.headSha,
      });
    } finally { await rm(runtime, { recursive: true, force: true }); }
  });
});
