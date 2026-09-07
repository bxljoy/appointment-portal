import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { readPrivateFile, writePrivateJson } from './private-file.js';

const evidenceSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  checkedAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  signupAlias: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
  status: z.literal('manual-passed'),
});

export type ManualRegistrationEvidence = { commit: string; checkedAt: string; signupAlias: string; status: 'manual-passed' };

export function confirmManualRegistration(manifest: DeploymentManifest, input: { signupAlias: string; confirmed: boolean }, now = () => new Date()): ManualRegistrationEvidence {
  if (manifest.phase !== 'ready' || !manifest.sourceCommit) throw new Error('A ready deployment manifest with an exact source commit is required.');
  if (!input.confirmed) throw new Error('Manual registration evidence requires explicit human confirmation.');
  if (input.signupAlias.includes('@')) throw new Error('Use a non-email signup alias; do not persist an email address.');
  return evidenceSchema.parse({ commit: manifest.sourceCommit, checkedAt: now().toISOString(), signupAlias: input.signupAlias, status: 'manual-passed' });
}

export function manualRegistrationCheck(manifest: DeploymentManifest, evidence: ManualRegistrationEvidence | undefined, now = new Date()) {
  const name = 'controlled-inbox registration and recovery';
  if (!evidence) return { name, status: 'failed' as const, detail: 'Manual controlled-inbox registration and recovery is incomplete.' };
  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success || manifest.phase !== 'ready' || parsed.data.commit !== manifest.sourceCommit) {
    return { name, status: 'failed' as const, detail: 'Manual registration evidence does not match the ready deployed commit.' };
  }
  const age = now.getTime() - new Date(parsed.data.checkedAt).getTime();
  if (age < -5 * 60_000 || age > 6 * 60 * 60_000) {
    return { name, status: 'failed' as const, detail: 'Manual registration evidence is stale or outside the current deployment window.' };
  }
  return { name, status: 'manual-passed' as const,
    detail: `A human confirmed registration, email verification, initial patient role, sign-in, sign-out, and password recovery for signup alias ${parsed.data.signupAlias}.` };
}

export const parseManualRegistrationEvidence = (value: unknown): ManualRegistrationEvidence => evidenceSchema.parse(value);

export async function loadManualRegistration(path = resolve('.runtime/manual-registration.json')): Promise<ManualRegistrationEvidence | undefined> {
  try { return parseManualRegistrationEvidence(JSON.parse(await readPrivateFile(path))); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Manual registration evidence is invalid.', { cause: error });
  }
}

export async function recordManualRegistration(options: {
  args: readonly string[]; manifestPath?: string; evidencePath?: string; now?: () => Date;
}): Promise<ManualRegistrationEvidence> {
  const [flag, signupAlias, confirmation, ...extra] = options.args;
  if (flag !== '--signup-alias' || !signupAlias || confirmation !== '--confirm-all' || extra.length) {
    throw new Error('Usage: pnpm demo:confirm-registration -- --signup-alias <non-email-alias> --confirm-all');
  }
  const manifest = await loadDeploymentManifest(options.manifestPath);
  if (!manifest) throw new Error('A ready deployment manifest is required.');
  const evidence = confirmManualRegistration(manifest, { signupAlias, confirmed: true }, options.now);
  await writePrivateJson(options.evidencePath ?? resolve('.runtime/manual-registration.json'), evidence);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await recordManualRegistration({ args: process.argv.slice(2) });
    process.stdout.write('Manual registration and recovery confirmation recorded for the deployed commit.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Manual confirmation failed.'}\n`);
    process.exitCode = 1;
  }
}
