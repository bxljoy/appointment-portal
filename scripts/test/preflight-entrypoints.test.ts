import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runPreflightCli } from '../preflight-cli.js';
import { runProcess, toPreflightInput, type PreflightInput, type PreflightProbe } from '../preflight.js';
import { setupDelivery } from '../setup-delivery.js';
import { manifest } from './fakes.js';

const preparedAt = new Date();
const fullInput = {
  account: manifest.account,
  region: manifest.region,
  postgresVersion: '17.6',
  durationHours: 1,
  maxCostUsd: 5,
  lambdaConcurrencyMode: 'shared-unreserved' as const,
  repository: 'OWNER/REPOSITORY',
  branch: 'main',
  sourceCommit: 'a'.repeat(40),
  createdAt: preparedAt.toISOString(),
  expiresAt: new Date(preparedAt.getTime() + 60 * 60_000).toISOString(),
  accountsFile: '/private/credentials/accounts.json',
  priceReport: '/private/prices.json',
};
const preflightKeys = ['account', 'durationHours', 'lambdaConcurrencyMode', 'maxCostUsd', 'postgresVersion', 'region'];
const unusedProbe = {} as PreflightProbe;

it('streams subprocess bytes to a private output file without UTF-8 conversion', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-binary-process-'));
  const output = join(root, 'artifact.zip');
  try {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,80,75]))'], { stdoutFile: output });
    expect(result.stdout).toBe('');
    expect([...await readFile(output)]).toEqual([0, 255, 80, 75]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('projects the public preflight CLI input to the exact strict contract', async () => {
  const observed: PreflightInput[] = [];
  await runPreflightCli('/private/runtime/demo-config.json', {
    readInput: async () => fullInput,
    makeProbe: () => unusedProbe,
    run: async (input) => { observed.push(input); return {} as never; },
  });
  expect(Object.keys(observed[0]!).sort()).toEqual(preflightKeys);
  expect(observed[0]).toEqual(toPreflightInput(fullInput));
});

it('terminates the configured public preflight entrypoint normally for a missing private config', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-preflight-process-'));
  const missing = join(root, 'missing-config.json');
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: { 'demo:preflight': string } };
  const entrypoint = /^tsx\s+(\S+)\s+/.exec(packageJson.scripts['demo:preflight'])?.[1];
  expect(entrypoint).toBeTruthy();
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve(entrypoint!), missing], {
        cwd: resolve('.'), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' },
      });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { resolveResult({ code, stdout, stderr }); });
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ENOENT|no such file/i);
    expect(result.stderr).not.toMatch(/unsettled top-level await|missing-config\.json.*missing-config\.json/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('projects setup-delivery default preflight input to the exact strict contract', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-preflight-entrypoint-'));
  const configPath = join(root, 'config.json');
  const observed: PreflightInput[] = [];
  const run = vi.fn(async (input: PreflightInput) => {
    observed.push(input);
    throw new Error('stop after preflight capture');
  });
  try {
    await writeFile(configPath, JSON.stringify(fullInput), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => ({}) } as never,
      iam: { send: async () => ({}) } as never,
      runPreflight: run,
      makePreflightProbe: () => unusedProbe,
    })).rejects.toThrow('stop after preflight capture');
    expect(run).toHaveBeenCalledTimes(1);
    expect(Object.keys(observed[0]!).sort()).toEqual(preflightKeys);
    expect(observed[0]).toEqual(toPreflightInput(fullInput));
  } finally { await rm(root, { recursive: true, force: true }); }
});
