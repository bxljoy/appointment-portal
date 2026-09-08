import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { parseDeploymentManifest } from './lifecycle-types.js';
import { ensurePrivateDirectory, readPrivateBytes, writePrivateFile, writePrivateJson } from './private-file.js';
import { runProcess, type ProcessRunner } from './preflight.js';

const expectedSchema = z.strictObject({ account: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflowPath: z.literal('.github/workflows/demo.yml'),
  branch: z.string().min(1), artifactName: z.literal('deployment-manifest'), runId: z.string().regex(/^\d+$/).optional() });
const runSchema = z.object({ id: z.number().int().positive(), repository: z.object({ full_name: z.string() }), path: z.string(),
  head_branch: z.string(), head_sha: z.string().regex(/^[a-f0-9]{40}$/), conclusion: z.string().nullable(), status: z.string() });
const artifactSchema = z.object({ id: z.number().int().positive(), name: z.string(), expired: z.boolean(), digest: z.string().optional(),
  expires_at: z.iso.datetime({ offset: true }), workflow_run: z.object({ id: z.number().int().positive(), head_sha: z.string() }) });

export type DestroyProvenanceExpected = z.infer<typeof expectedSchema>;
export function validateDestroyProvenance(rawRun: unknown, rawArtifacts: unknown[], rawExpected: DestroyProvenanceExpected, now = new Date()) {
  const expected = expectedSchema.parse(rawExpected); const run = runSchema.parse(rawRun);
  const workflowPath = run.path.split('@', 1)[0];
  const artifact = rawArtifacts.map((value) => artifactSchema.parse(value)).find((value) => value.name === expected.artifactName);
  const digest = artifact?.digest;
  const valid = (!expected.runId || String(run.id) === expected.runId) && run.repository.full_name === expected.repository &&
    workflowPath === expected.workflowPath && run.head_branch === expected.branch &&
    run.status === 'completed' && run.conclusion === 'success' && artifact && !artifact.expired &&
    /^sha256:[a-f0-9]{64}$/.test(digest ?? '') && new Date(artifact.expires_at).getTime() > now.getTime() &&
    artifact.workflow_run.head_sha === run.head_sha && (!expected.runId || String(artifact.workflow_run.id) === expected.runId);
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
  const archivePath = resolve(runtimeDirectory, `.deployment-${provenance.artifactId}-${randomUUID()}.zip`);
  const deploymentPath = resolve(runtimeDirectory, 'deployment.json');
  let deploymentBytes: Uint8Array;
  try {
    await runner('gh', ['api', `repos/${parsed.repository}/actions/artifacts/${provenance.artifactId}/zip`,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'], { stdoutFile: archivePath });
    const archive = await readPrivateBytes(archivePath, 8_000_000);
    const actualDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
    if (actualDigest !== provenance.digest) throw new Error('Downloaded artifact digest does not match authenticated metadata.');
    deploymentBytes = extractDeploymentJson(archive);
  } finally { await rm(archivePath, { force: true }); }
  let manifest;
  try { manifest = parseDeploymentManifest(JSON.parse(Buffer.from(deploymentBytes).toString('utf8'))); }
  catch (error) { throw new Error('Downloaded manifest is invalid.', { cause: error }); }
  if (manifest.account !== parsed.account || manifest.region !== parsed.region ||
    manifest.repository !== parsed.repository || manifest.branch !== parsed.branch || manifest.sourceCommit !== provenance.headSha) {
    throw new Error('Downloaded manifest does not match validated provenance and deployment authority.');
  }
  await writePrivateFile(deploymentPath, deploymentBytes);
  await writePrivateJson(resolve(runtimeDirectory, 'destroy-provenance.json'), { account: parsed.account, region: parsed.region,
    repository: parsed.repository, workflow: parsed.workflowPath,
    branch: parsed.branch, runId: parsed.runId, artifactName: parsed.artifactName, ...provenance });
}

type ZipEntry = { name: string; flags: number; method: number; crc: number; compressedSize: number; size: number; localOffset: number; mode: number; unix: boolean };
const MAX_MANIFEST_BYTES = 4_000_000;

export function extractDeploymentJson(input: Uint8Array): Uint8Array {
  const archive = Buffer.from(input); const end = findEndRecord(archive);
  const entries = readCentralDirectory(archive, end);
  const manifest = entries.find((entry) => entry.name === 'deployment.json');
  if (!manifest) throw new Error('Artifact ZIP does not contain deployment.json at its root.');
  if (manifest.unix && (manifest.mode & 0o170000) !== 0o100000) throw new Error('Artifact deployment.json must be a regular file, not a symlink.');
  if (manifest.size > MAX_MANIFEST_BYTES || manifest.compressedSize > MAX_MANIFEST_BYTES) throw new Error('Artifact deployment.json is too large.');
  const offset = manifest.localOffset;
  if (offset < 0 || offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error('Artifact ZIP local header is invalid.');
  const flags = archive.readUInt16LE(offset + 6); const method = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26); const extraLength = archive.readUInt16LE(offset + 28);
  const nameStart = offset + 30; const dataStart = nameStart + nameLength + extraLength;
  if (dataStart + manifest.compressedSize > archive.length || decodeName(archive.subarray(nameStart, nameStart + nameLength)) !== manifest.name ||
    flags !== manifest.flags || method !== manifest.method) throw new Error('Artifact ZIP entry metadata is inconsistent.');
  if (flags & 1) throw new Error('Encrypted artifact ZIP entries are not accepted.');
  const compressed = archive.subarray(dataStart, dataStart + manifest.compressedSize);
  const contents = method === 0 ? Buffer.from(compressed) : method === 8
    ? inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES }) : (() => { throw new Error('Artifact ZIP compression method is unsupported.'); })();
  if (contents.length !== manifest.size || crc32(contents) !== manifest.crc) throw new Error('Artifact ZIP deployment.json integrity check failed.');
  return contents;
}

const findEndRecord = (archive: Buffer) => {
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== archive.length || archive.readUInt16LE(offset + 4) !== 0 || archive.readUInt16LE(offset + 6) !== 0 ||
      archive.readUInt16LE(offset + 8) !== archive.readUInt16LE(offset + 10)) throw new Error('Artifact ZIP directory is unsafe.');
    return { count: archive.readUInt16LE(offset + 10), size: archive.readUInt32LE(offset + 12), offset: archive.readUInt32LE(offset + 16) };
  }
  throw new Error('Artifact ZIP end record is missing.');
};

const readCentralDirectory = (archive: Buffer, end: { count: number; size: number; offset: number }): ZipEntry[] => {
  if (end.count > 1_000 || end.offset + end.size > archive.length) throw new Error('Artifact ZIP directory is unsafe.');
  const entries: ZipEntry[] = []; const names = new Set<string>(); let cursor = end.offset;
  for (let index = 0; index < end.count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Artifact ZIP directory is invalid.');
    const madeBy = archive.readUInt16LE(cursor + 4); const flags = archive.readUInt16LE(cursor + 8); const method = archive.readUInt16LE(cursor + 10);
    const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > archive.length || archive.readUInt16LE(cursor + 34) !== 0) throw new Error('Artifact ZIP directory is unsafe.');
    const name = decodeName(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    assertSafeZipName(name);
    if (names.has(name)) throw new Error('Artifact ZIP contains a duplicate entry.');
    names.add(name);
    const mode = Math.floor(archive.readUInt32LE(cursor + 38) / 0x10000); const unix = (madeBy >>> 8) === 3;
    if (flags & 1) throw new Error('Artifact ZIP contains an encrypted entry.');
    if (unix && (mode & 0o170000) === 0o120000) throw new Error('Artifact ZIP contains a symlink entry.');
    entries.push({ name, flags, method, crc: archive.readUInt32LE(cursor + 16), compressedSize: archive.readUInt32LE(cursor + 20),
      size: archive.readUInt32LE(cursor + 24), mode, unix, localOffset: archive.readUInt32LE(cursor + 42) });
    cursor = next;
  }
  if (cursor !== end.offset + end.size) throw new Error('Artifact ZIP directory size is invalid.');
  return entries;
};

const decodeName = (input: Uint8Array) => {
  const name = Buffer.from(input).toString('utf8');
  if (name.includes('\uFFFD') || !Buffer.from(name).equals(Buffer.from(input))) throw new Error('Artifact ZIP filename encoding is unsafe.');
  return name;
};

const assertSafeZipName = (name: string) => {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => part === '..')) throw new Error('Artifact ZIP contains an unsafe path.');
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (input: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of input) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await restoreDeploymentManifest({ account: process.env.AWS_ACCOUNT_ID ?? '', region: process.env.AWS_REGION ?? '',
      repository: process.env.GITHUB_REPOSITORY ?? '', workflowPath: '.github/workflows/demo.yml',
      branch: process.env.DEMO_BRANCH ?? '', artifactName: 'deployment-manifest', runId: process.env.DEMO_RUN_ID ?? '' });
    process.stdout.write('Validated deployment manifest restored.\n');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Manifest restore failed.'}\n`); process.exitCode = 1; }
}
