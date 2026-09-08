import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { setupDelivery } from '../setup-delivery.js';
import { DELIVERY_STACK, TOOLKIT_STACK, type DeploymentManifest } from '../lifecycle-types.js';
import { manifest } from './fakes.js';

const preparedAt = new Date();
const expiry = { createdAt: preparedAt.toISOString(), expiresAt: new Date(preparedAt.getTime() + 60 * 60_000).toISOString() };

it('persists an ownership-neutral recovery target before bootstrap can fail', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-bootstrap-failure-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), ...expiry,
      accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => { throw Object.assign(new Error('stack absent'), { name: 'ValidationError' }); } } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => { throw new Error('bootstrap failed after partial mutation'); }, preflight: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('bootstrap failed after partial mutation');
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ account: manifest.account, region: manifest.region, toolkitStack: TOOLKIT_STACK,
      phase: 'bootstrap', outputs: {}, resources: [] });
    expect(saves[0]!.resources.some((resource) => resource.owned)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('checkpoints toolkit and delivery ownership before output parsing or inventory can fail', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-delivery-'));
  const configPath = join(root, 'config.json');
  let toolkitExists = false; let deliveryExists = false;
  const saves: DeploymentManifest[] = [];
  const commands: (readonly string[])[] = [];
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, lambdaConcurrencyMode: 'shared-unreserved', repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40),
      ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    const cloudformation = { send: vi.fn(async (command: { constructor: { name: string }; input: { StackName?: string } }) => {
      if (command.constructor.name !== 'DescribeStacksCommand') throw new Error('unexpected command');
      const exists = command.input.StackName === TOOLKIT_STACK ? toolkitExists : deliveryExists;
      if (!exists) throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
      return { Stacks: [{ StackName: command.input.StackName, Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] };
    }) };
    const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
      commands.push(args);
      if (args.includes('bootstrap')) toolkitExists = true;
      if (args.includes('deploy')) deliveryExists = true;
      return { stdout: '', stderr: '' };
    });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: cloudformation as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner, preflight: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); },
      readOutputs: async () => { throw new Error('output parse failed'); }, writeResult: async () => {},
      listResources: async () => { throw new Error('inventory must happen after output parsing'); },
    })).rejects.toThrow('output parse failed');
    expect(commands.map((args) => args.includes('bootstrap') ? 'bootstrap' : 'deploy')).toEqual(['bootstrap', 'deploy']);
    expect(commands.find((args) => args.includes('deploy'))).toContain('lambdaConcurrencyMode=shared-unreserved');
    expect(saves).toHaveLength(5);
    expect(saves[0]!.resources).toEqual([]);
    expect(saves[1]!.resources).toEqual([]);
    expect(saves[2]!.resources).toEqual([{ type: 'Bootstrap::AWS::CloudFormation::Stack', id: TOOLKIT_STACK, owned: true }]);
    expect(saves[3]!.resources).toEqual(saves[2]!.resources);
    expect(saves[4]!.resources).toEqual(expect.arrayContaining([
      { type: 'Bootstrap::AWS::CloudFormation::Stack', id: TOOLKIT_STACK, owned: true },
      { type: 'Delivery::AWS::CloudFormation::Stack', id: DELIVERY_STACK, owned: true },
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('persists recovery immediately after toolkit bootstrap even when ownership reinspection fails', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-toolkit-recovery-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  let inspections = 0;
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => {
        inspections += 1;
        if (inspections === 1) throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
        throw new Error('ownership reinspection unavailable');
      } } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => ({ stdout: '', stderr: '' }), preflight: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('ownership reinspection unavailable');
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ toolkitStack: TOOLKIT_STACK, deliveryStack: DELIVERY_STACK, resources: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
