import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { readPrivateFile, writePrivateJson } from './private-file.js';

const evidenceSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/), region: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/),
  frontendUrl: z.url().startsWith('https://'), distributionId: z.string().min(1),
  checkedAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  expiresAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  signupAlias: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/), status: z.literal('manual-passed'),
});
export type ManualRegistrationEvidence = z.infer<typeof evidenceSchema>;
export type ManualPrompter = { ask(question: string): Promise<string> };

const identity = (manifest: DeploymentManifest) => {
  if (manifest.phase !== 'ready' || !manifest.sourceCommit) throw new Error('A ready deployment manifest with an exact source commit is required.');
  const frontendUrl = manifest.outputs.FrontendUrl;
  const distributionId = manifest.outputs.DistributionId;
  if (!frontendUrl || !distributionId) throw new Error('Ready deployment frontend identity is incomplete.');
  return { account: manifest.account, region: manifest.region, commit: manifest.sourceCommit, frontendUrl, distributionId };
};

export async function confirmManualRegistration(manifest: DeploymentManifest, prompter: ManualPrompter,
  now = () => new Date()): Promise<ManualRegistrationEvidence> {
  const bound = identity(manifest);
  const signupAlias = (await prompter.ask('Non-email alias used for this signup check: ')).trim();
  if (signupAlias.includes('@')) throw new Error('Use a non-email signup alias; do not persist an email address.');
  const checks = ['self-registration completed', 'verification email received and code accepted', 'initial patient role confirmed',
    'sign-in completed', 'sign-out completed', 'password recovery completed'];
  for (const check of checks) if ((await prompter.ask(`Confirm ${check} [yes/no]: `)).trim().toLowerCase() !== 'yes') {
    throw new Error('Manual registration evidence requires explicit human confirmation of every checklist item.');
  }
  const checkedAt = now();
  return evidenceSchema.parse({ ...bound, checkedAt: checkedAt.toISOString(), expiresAt: new Date(checkedAt.getTime() + 6 * 60 * 60_000).toISOString(),
    signupAlias, status: 'manual-passed' });
}

export function manualRegistrationCheck(manifest: DeploymentManifest, evidence: ManualRegistrationEvidence | undefined, now = new Date()) {
  const name = 'controlled-inbox registration and recovery';
  if (!evidence) return { name, status: 'failed' as const, detail: 'Manual controlled-inbox registration and recovery is incomplete.' };
  const parsed = evidenceSchema.safeParse(evidence);
  let bound: ReturnType<typeof identity>;
  try { bound = identity(manifest); } catch { return { name, status: 'failed' as const, detail: 'Manual registration evidence does not match the ready deployment.' }; }
  if (!parsed.success || Object.entries(bound).some(([key, value]) => parsed.data[key as keyof typeof bound] !== value)) {
    return { name, status: 'failed' as const, detail: 'Manual registration evidence does not match the ready deployment identity.' };
  }
  const checked = new Date(parsed.data.checkedAt).getTime();
  const expiry = new Date(parsed.data.expiresAt).getTime();
  if (expiry !== checked + 6 * 60 * 60_000 || now.getTime() < checked - 5 * 60_000 || now.getTime() > expiry) {
    return { name, status: 'failed' as const, detail: 'Manual registration evidence is stale or outside the current deployment window.' };
  }
  return { name, status: 'manual-passed' as const,
    detail: `A human confirmed registration, email verification, initial patient role, sign-in, sign-out, and password recovery for signup alias ${parsed.data.signupAlias}.` };
}

export const parseManualRegistrationEvidence = (value: unknown): ManualRegistrationEvidence => evidenceSchema.parse(value);
export async function loadManualRegistration(path = resolve('.runtime/manual-registration.json')): Promise<ManualRegistrationEvidence | undefined> {
  try { return parseManualRegistrationEvidence(JSON.parse(await readPrivateFile(path))); }
  catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('Manual registration evidence is invalid.', { cause: error }); }
}

export async function recordManualRegistration(options: { args: readonly string[]; stdinIsTTY: boolean; stdoutIsTTY: boolean; ci?: string;
  prompter: ManualPrompter; manifestPath?: string; evidencePath?: string; now?: () => Date }): Promise<ManualRegistrationEvidence> {
  if (options.args.length || !options.stdinIsTTY || !options.stdoutIsTTY || options.ci) {
    throw new Error('Manual confirmation requires an interactive TTY and cannot accept command flags or CI input.');
  }
  const manifest = await loadDeploymentManifest(options.manifestPath);
  if (!manifest) throw new Error('A ready deployment manifest is required.');
  const evidence = await confirmManualRegistration(manifest, options.prompter, options.now);
  await writePrivateJson(options.evidencePath ?? resolve('.runtime/manual-registration.json'), evidence);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await recordManualRegistration({ args: process.argv.slice(2), stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY),
      ci: process.env.CI, prompter: { ask: (question) => prompt.question(question) } });
    process.stdout.write('Manual registration and recovery confirmation recorded for this deployment.\n');
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Manual confirmation failed.'}\n`); process.exitCode = 1; }
  finally { prompt.close(); }
}
