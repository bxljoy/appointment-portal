import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, lstat } from 'node:fs/promises';
import { z } from 'zod';
import { loadDeploymentManifest } from './lifecycle-types.js';
import { ensurePrivateDirectory, writePrivateJson } from './private-file.js';
import { runProcess, type ProcessRunner } from './preflight.js';

const expectedSchema = z.strictObject({ account: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowPath: z.literal('.github/workflows/demo.yml'),
  branch: z.string().min(1), headSha: z.string().regex(/^[a-f0-9]{40}$/), artifactName: z.literal('deployment-manifest'), runId: z.string().regex(/^\d+$/).optional() });
const runSchema = z.object({ id: z.number().int().positive(), repository: z.object({ full_name: z.string() }), path: z.string(),
  head_branch: z.string(), head_sha: z.string(), conclusion: z.string().nullable(), status: z.string() });
const artifactSchema = z.object({ id: z.number().int().positive().optional(), name: z.string(), expired: z.boolean(), digest: z.string().optional(),
  expires_at: z.iso.datetime({ offset: true }), workflow_run: z.object({ id: z.number().int().positive(), head_sha: z.string() }) });

export type DestroyProvenanceExpected = z.infer<typeof expectedSchema>;
export function validateDestroyProvenance(rawRun: unknown, rawArtifacts: unknown[], rawExpected: DestroyProvenanceExpected, now = new Date()) {
  const expected = expectedSchema.parse(rawExpected); const run = runSchema.parse(rawRun);
  const workflowPath = run.path.split('@', 1)[0];
  const artifact = rawArtifacts.map((value) => artifactSchema.parse(value)).find((value) => value.name === expected.artifactName);
  const digest = artifact?.digest;
  const valid = (!expected.runId || String(run.id) === expected.runId) && run.repository.full_name === expected.repository &&
    workflowPath === expected.workflowPath && run.head_branch === expected.branch &&
    run.head_sha === expected.headSha && run.status === 'completed' && run.conclusion === 'success' && artifact && !artifact.expired &&
    /^sha256:[a-f0-9]{64}$/.test(digest ?? '') && new Date(artifact.expires_at).getTime() > now.getTime() &&
    artifact.workflow_run.head_sha === expected.headSha && (!expected.runId || String(artifact.workflow_run.id) === expected.runId);
  if (!valid) throw new Error('Destroy artifact provenance validation failed.');
  return { headSha: run.head_sha, digest: digest!, artifactId: artifact.id, expiresAt: artifact.expires_at };
}

export async function restoreDeploymentManifest(expected: DestroyProvenanceExpected, dependencies: {
  runner?: ProcessRunner; runtimeDirectory?: string;
} = {}) {
  const runner = dependencies.runner ?? runProcess;
  const parsed = expectedSchema.extend({ runId: z.string().regex(/^\d+$/) }).parse(expected);
  const runResult = await runner('gh', ['api', `repos/${parsed.repository}/actions/runs/${parsed.runId}`]);
  const artifactsResult = await runner('gh', ['api', `repos/${parsed.repository}/actions/runs/${parsed.runId}/artifacts`, '--paginate', '--slurp']);
  const artifactPages = JSON.parse(artifactsResult.stdout) as unknown;
  const artifacts = Array.isArray(artifactPages) ? artifactPages.flatMap((page) => z.object({ artifacts: z.array(z.unknown()) }).parse(page).artifacts) :
    z.object({ artifacts: z.array(z.unknown()) }).parse(artifactPages).artifacts;
  const provenance = validateDestroyProvenance(JSON.parse(runResult.stdout), artifacts, parsed);
  const runtimeDirectory = resolve(dependencies.runtimeDirectory ?? '.runtime');
  await ensurePrivateDirectory(runtimeDirectory);
  await runner('gh', ['run', 'download', parsed.runId, '--repo', parsed.repository, '--name', parsed.artifactName, '--dir', runtimeDirectory]);
  const deploymentPath = resolve(runtimeDirectory, 'deployment.json');
  const downloaded = await lstat(deploymentPath);
  if (!downloaded.isFile() || downloaded.isSymbolicLink()) throw new Error('Downloaded manifest is not a safe regular file.');
  await chmod(deploymentPath, 0o600);
  const manifest = await loadDeploymentManifest(deploymentPath);
  if (!manifest || manifest.account !== parsed.account || manifest.region !== parsed.region ||
    manifest.repository !== parsed.repository || manifest.branch !== parsed.branch || manifest.sourceCommit !== parsed.headSha) {
    throw new Error('Downloaded manifest does not match validated provenance and deployment authority.');
  }
  await writePrivateJson(resolve(runtimeDirectory, 'destroy-provenance.json'), { account: parsed.account, region: parsed.region,
    repository: parsed.repository, workflow: parsed.workflowPath,
    branch: parsed.branch, runId: parsed.runId, artifactName: parsed.artifactName, ...provenance });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await restoreDeploymentManifest({ account: process.env.AWS_ACCOUNT_ID ?? '', region: process.env.AWS_REGION ?? '',
      repository: process.env.GITHUB_REPOSITORY ?? '', workflowPath: '.github/workflows/demo.yml',
      branch: process.env.DEMO_BRANCH ?? '', headSha: process.env.DEMO_HEAD_SHA ?? '', artifactName: 'deployment-manifest', runId: process.env.DEMO_RUN_ID ?? '' });
    process.stdout.write('Validated deployment manifest restored.\n');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Manifest restore failed.'}\n`); process.exitCode = 1; }
}
