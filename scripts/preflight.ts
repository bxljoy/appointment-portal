import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { estimateCost, type CostRates } from './deploy.js';

export type PreflightInput = {
  account: string; region: string; postgresVersion: string;
  durationHours: number; maxCostUsd: number;
};
export type PreflightProbe = {
  identity(): Promise<string>;
  regionalCapabilities(input: { region: string; postgresVersion: string }): Promise<{ postgres: boolean; instanceClass: boolean; proxyApiReachable: boolean }>;
  unreservedConcurrency(region: string): Promise<number>;
  runtimeVersions(): Promise<{ node: string; pnpm: string; docker: string }>;
  gitClean(): Promise<boolean>;
  costRates(input: { region: string; postgresVersion: string }): Promise<CostRates>;
};

const inputSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  postgresVersion: z.string().regex(/^17\.[1-9]\d*$/), durationHours: z.number().positive().max(24), maxCostUsd: z.number().positive(),
});

export const runPreflight = async (raw: PreflightInput, probe: PreflightProbe) => {
  const input = inputSchema.parse(raw);
  const account = await probe.identity();
  if (account !== input.account) throw new Error(`AWS account mismatch: expected ${input.account}.`);
  const regional = await probe.regionalCapabilities({ region: input.region, postgresVersion: input.postgresVersion });
  if (!regional.postgres || !regional.instanceClass) throw new Error('Requested PostgreSQL engine or db.t4g.small class is unavailable in this region.');
  if (!regional.proxyApiReachable) throw new Error('RDS Proxy API reachability could not be confirmed for this account and region.');
  const unreserved = await probe.unreservedConcurrency(input.region);
  const reservedConcurrencyRequired = 16;
  if (unreserved < 100 + reservedConcurrencyRequired) throw new Error('Insufficient Lambda concurrency headroom for 16 reserved executions while retaining 100 unreserved.');
  const versions = await probe.runtimeVersions();
  if (!versions.node.startsWith('24.') || versions.pnpm !== '11.22.0' || !/^\d+\./.test(versions.docker)) throw new Error('Node 24, pnpm 11.22.0, and Docker are required.');
  if (!await probe.gitClean()) throw new Error('Git worktree must be clean before deployment.');
  const rates = await probe.costRates({ region: input.region, postgresVersion: input.postgresVersion });
  const cost = estimateCost({ durationHours: input.durationHours, capUsd: input.maxCostUsd, rates });
  if (!cost.allowed) throw new Error(`Estimated temporary deployment cost ${cost.totalUsd.toFixed(2)} USD exceeds the supplied cap.`);
  return { account, region: input.region, versions, regional, unreservedConcurrency: unreserved, reservedConcurrencyRequired, cost };
};

export type ProcessResult = { stdout: string; stderr: string };
export type ProcessRunner = (executable: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (executable, args, options = {}) => new Promise((resolvePromise, reject) => {
  if (args.some((arg) => /password|secret(?:access)?key|sessiontoken/i.test(arg))) {
    reject(new Error('Credentials and secret payloads are forbidden in subprocess arguments.')); return;
  }
  const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${executable} exited with status ${code ?? 'unknown'}.`)));
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime preflight configuration path.');
    const { makeAwsPreflightProbe, readAwsDemoInput } = await import('./aws-lifecycle.js');
    const full = await readAwsDemoInput(process.argv[2]!);
    const report = await runPreflight(full, makeAwsPreflightProbe(full));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Preflight failed.'}\n`);
    process.exitCode = 1;
  }
}
