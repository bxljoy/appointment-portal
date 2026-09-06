import { expect, it, vi } from 'vitest';
import { runPreflightCli, toPreflightInput, type PreflightInput, type PreflightProbe } from '../preflight.js';
import { setupDelivery } from '../setup-delivery.js';
import { manifest } from './fakes.js';

const fullInput = {
  account: manifest.account,
  region: manifest.region,
  postgresVersion: '17.6',
  durationHours: 1,
  maxCostUsd: 5,
  repository: 'OWNER/REPOSITORY',
  branch: 'main',
  sourceCommit: 'a'.repeat(40),
  accountsFile: '/private/credentials/accounts.json',
  priceReport: '/private/prices.json',
};
const preflightKeys = ['account', 'durationHours', 'maxCostUsd', 'postgresVersion', 'region'];
const unusedProbe = {} as PreflightProbe;

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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
