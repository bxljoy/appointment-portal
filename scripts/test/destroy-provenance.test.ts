import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDeploymentJson, restoreDeploymentManifest, validateDestroyProvenance } from '../destroy-provenance.js';
import { manifest } from './fakes.js';

const expected = { account: manifest.account, region: manifest.region, repository: 'OWNER/REPOSITORY', workflowPath: '.github/workflows/demo.yml',
  branch: 'main', artifactName: 'deployment-manifest', runId: '42' } as const;
const run = { id: 42, repository: { full_name: expected.repository }, path: expected.workflowPath, head_branch: expected.branch, head_sha: 'a'.repeat(40),
  conclusion: 'success', status: 'completed' };
const artifact = { id: 99, name: expected.artifactName, expired: false, expires_at: '2031-06-01T00:00:00Z',
  digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 42, head_sha: run.head_sha } };

describe('destroy artifact provenance', () => {
  it('accepts a successful exact workflow, repository, branch, commit and unexpired digest-bound artifact', () => {
    expect(validateDestroyProvenance(run, [artifact], expected)).toMatchObject({ headSha: run.head_sha, digest: artifact.digest, artifactId: 99 });
  });
  it.each([
    ['repository', { ...run, repository: { full_name: 'ATTACKER/REPOSITORY' } }, artifact],
    ['workflow', { ...run, path: '.github/workflows/other.yml' }, artifact],
    ['branch', { ...run, head_branch: 'evil' }, artifact],
    ['run id', { ...run, id: 41 }, artifact],
    ['conclusion', { ...run, conclusion: 'failure' }, artifact],
    ['expiry', run, { ...artifact, expired: true }],
    ['expiry timestamp', run, { ...artifact, expires_at: '2020-06-01T00:00:00Z' }],
    ['digest', run, { ...artifact, digest: undefined }],
    ['artifact run', run, { ...artifact, workflow_run: { ...artifact.workflow_run, id: 41 } }],
    ['artifact commit', run, { ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: 'c'.repeat(40) } }],
  ])('rejects mismatched %s provenance', (_name, candidateRun, candidateArtifact) => {
    expect(() => validateDestroyProvenance(candidateRun, [candidateArtifact], expected)).toThrow(/provenance/i);
  });

  it('queries run and artifact metadata before download and binds the downloaded manifest to validated authority', async () => {
    const runtime = await mkdtemp(join(await realpath(tmpdir()), 'portal-provenance-'));
    const calls: string[] = [];
    try {
      const archive = zip([{ name: 'deployment.json', contents: JSON.stringify({ ...manifest, repository: expected.repository,
        branch: expected.branch, sourceCommit: run.head_sha }) }]);
      const exactArtifact = { ...artifact, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
      await restoreDeploymentManifest(expected, { runtimeDirectory: runtime, runner: async (_executable, args, options?: { stdoutFile?: string }) => {
        calls.push(args.join(' '));
        if (args[1]?.includes('/actions/runs/42/artifacts')) return { stdout: JSON.stringify([{ artifacts: [exactArtifact] }]), stderr: '' };
        if (args[1]?.includes('/actions/runs/42')) return { stdout: JSON.stringify(run), stderr: '' };
        expect(args[1]).toContain('/actions/artifacts/99/zip');
        expect(options?.stdoutFile).toBeTruthy();
        await writeFile(options!.stdoutFile!, archive, { mode: 0o600 });
        return { stdout: '', stderr: '' };
      } });
      expect(calls[0]).toContain('/actions/runs/42');
      expect(calls[1]).toContain('/actions/runs/42/artifacts');
      expect(calls[2]).toContain('/actions/artifacts/99/zip');
      expect(JSON.parse(await readFile(join(runtime, 'destroy-provenance.json'), 'utf8'))).toMatchObject({
        account: expected.account, region: expected.region, repository: expected.repository, headSha: run.head_sha,
      });
    } finally { await rm(runtime, { recursive: true, force: true }); }
  });

  it('rejects raw artifact bytes whose SHA-256 does not match authenticated metadata', async () => {
    const runtime = await mkdtemp(join(await realpath(tmpdir()), 'portal-provenance-digest-'));
    const archive = zip([{ name: 'deployment.json', contents: JSON.stringify({ ...manifest, repository: expected.repository,
      branch: expected.branch, sourceCommit: run.head_sha }) }]);
    try {
      await expect(restoreDeploymentManifest(expected, { runtimeDirectory: runtime, runner: async (_executable, args, options?: { stdoutFile?: string }) => {
        if (args[1]?.includes('/actions/runs/42/artifacts')) return { stdout: JSON.stringify([{ artifacts: [artifact] }]), stderr: '' };
        if (args[1]?.includes('/actions/runs/42')) return { stdout: JSON.stringify(run), stderr: '' };
        await writeFile(options!.stdoutFile!, archive, { mode: 0o600 }); return { stdout: '', stderr: '' };
      } })).rejects.toThrow(/digest/i);
      await expect(readFile(join(runtime, 'deployment.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(runtime, { recursive: true, force: true }); }
  });

  it('extracts only one regular root deployment manifest and rejects unsafe ZIP entries', () => {
    expect(Buffer.from(extractDeploymentJson(zip([{ name: 'deployment.json', contents: '{"safe":true}' }]))).toString()).toBe('{"safe":true}');
    expect(() => extractDeploymentJson(zip([{ name: '../deployment.json', contents: '{}' }]))).toThrow(/unsafe/i);
    expect(() => extractDeploymentJson(zip([{ name: 'deployment.json', contents: 'target', mode: 0o120777 }]))).toThrow(/symlink|regular/i);
    expect(() => extractDeploymentJson(zip([
      { name: 'deployment.json', contents: '{}' }, { name: 'other', contents: 'target', mode: 0o120777 },
    ]))).toThrow(/symlink/i);
    expect(() => extractDeploymentJson(zip([
      { name: 'deployment.json', contents: '{}' }, { name: 'deployment.json', contents: '{}' },
    ]))).toThrow(/duplicate/i);
  });
});

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (input: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of input) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const zip = (entries: Array<{ name: string; contents: string; mode?: number }>) => {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const contents = Buffer.from(entry.contents); const checksum = crc32(contents);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, contents);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((entry.mode ?? 0o100600) * 0x10000, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + contents.length;
  }
  const centralBytes = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
};
