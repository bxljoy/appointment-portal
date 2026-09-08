import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { setupDelivery, verifyGitHubRepositoryIdentity } from '../setup-delivery.js';
import { APP_STACK, DELIVERY_STACK, TOOLKIT_STACK, type DeploymentManifest } from '../lifecycle-types.js';
import { manifest } from './fakes.js';

const preparedAt = new Date();
const expiry = { createdAt: preparedAt.toISOString(), expiresAt: new Date(preparedAt.getTime() + 60 * 60_000).toISOString() };

it('verifies the selected numeric repository identity and exact immutable OIDC subject prefix through gh api', async () => {
  const calls: string[][] = [];
  const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[1] === 'repos/OWNER/REPOSITORY') return { stdout: JSON.stringify({ full_name: 'OWNER/REPOSITORY', id: 1360681625, owner: { id: 18458919 } }), stderr: '' };
    return { stdout: JSON.stringify({ use_default: true, use_immutable_subject: false,
      sub_claim_prefix: 'repo:OWNER@18458919/REPOSITORY@1360681625' }), stderr: '' };
  });
  await expect(verifyGitHubRepositoryIdentity({ repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919',
    repositoryId: '1360681625' }, runner)).resolves.toBeUndefined();
  expect(calls).toEqual([
    ['api', 'repos/OWNER/REPOSITORY'],
    ['api', 'repos/OWNER/REPOSITORY/actions/oidc/customization/sub'],
  ]);
});

it('rejects a mismatched GitHub repository ID or OIDC subject prefix', async () => {
  const config = { repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625' };
  await expect(verifyGitHubRepositoryIdentity(config, async () => ({
    stdout: JSON.stringify({ full_name: 'OWNER/REPOSITORY', id: 999, owner: { id: 18458919 } }), stderr: '',
  }))).rejects.toThrow(/identity/i);
  let call = 0;
  await expect(verifyGitHubRepositoryIdentity(config, async () => ({ stdout: JSON.stringify(call++ === 0
    ? { full_name: 'OWNER/REPOSITORY', id: 1360681625, owner: { id: 18458919 } }
    : { use_default: true, use_immutable_subject: false, sub_claim_prefix: 'repo:OWNER/REPOSITORY' }), stderr: '' })))
    .rejects.toThrow(/subject prefix/i);
});

it('stops before manifest or AWS mutation when GitHub identity verification fails', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-github-identity-'));
  const configPath = join(root, 'config.json');
  const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const saveManifest = vi.fn(async () => {});
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
      sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => { throw new Error('must not inspect mutation targets'); } } as never,
      iam: { send: async () => { throw new Error('must not inspect mutation targets'); } } as never,
      runner, preflight: async () => {}, verifyGitHubIdentity: async () => { throw new Error('GitHub identity mismatch.'); },
      loadManifest: async () => { throw new Error('must not load mutable recovery state'); }, saveManifest, writeResult: async () => {},
    })).rejects.toThrow('GitHub identity mismatch.');
    expect(saveManifest).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('projects the full setup configuration into the strict default GitHub identity verifier', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-github-projection-'));
  const configPath = join(root, 'config.json');
  const runner = vi.fn(async (_executable: string, args: readonly string[]) => ({ stdout: JSON.stringify(
    args[1] === 'repos/OWNER/REPOSITORY'
      ? { full_name: 'OWNER/REPOSITORY', id: 1360681625, owner: { id: 18458919 } }
      : { use_default: true, use_immutable_subject: false, sub_claim_prefix: 'repo:OWNER@18458919/REPOSITORY@1360681625' },
  ), stderr: '' }));
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
      sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => { throw new Error('must not reach AWS stack inspection'); } } as never,
      iam: { send: async () => { throw new Error('must not reach IAM inspection'); } } as never,
      runner, preflight: async () => {}, loadManifest: async () => { throw new Error('identity projection passed'); },
      saveManifest: async () => {}, writeResult: async () => {},
    })).rejects.toThrow('identity projection passed');
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ['api', 'repos/OWNER/REPOSITORY'],
      ['api', 'repos/OWNER/REPOSITORY/actions/oidc/customization/sub'],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('persists an ownership-neutral recovery target before bootstrap can fail', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-bootstrap-failure-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main', sourceCommit: 'a'.repeat(40), ...expiry,
      accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => { throw Object.assign(new Error('stack absent'), { name: 'ValidationError' }); } } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => { throw new Error('bootstrap failed after partial mutation'); }, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('bootstrap failed after partial mutation');
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ account: manifest.account, region: manifest.region, toolkitStack: TOOLKIT_STACK,
      phase: 'bootstrap', outputs: {}, resources: [] });
    expect(saves[0]!.resources.some((resource) => resource.owned)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses fresh delivery setup when any live application stack exists', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-fresh-live-application-'));
  const configPath = join(root, 'config.json');
  const saveManifest = vi.fn(async () => {});
  const writeResult = vi.fn(async () => {});
  const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const iam = { send: vi.fn(async () => ({ OpenIDConnectProviderList: [] })) };
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
      sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => ({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }) } as never,
      iam: iam as never, runner, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => undefined,
      saveManifest, writeResult,
    })).rejects.toThrow(/application stack.*absent/i);
    expect(saveManifest).not.toHaveBeenCalled();
    expect(writeResult).not.toHaveBeenCalled();
    expect(iam.send).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
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
      maxCostUsd: 5, lambdaConcurrencyMode: 'shared-unreserved', repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main', sourceCommit: 'a'.repeat(40),
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
      runner, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); },
      readOutputs: async () => { throw new Error('output parse failed'); }, writeResult: async () => {},
      listResources: async () => { throw new Error('inventory must happen after output parsing'); },
    })).rejects.toThrow('output parse failed');
    expect(commands.map((args) => args.includes('bootstrap') ? 'bootstrap' : 'deploy')).toEqual(['bootstrap', 'deploy']);
    const bootstrap = commands.find((args) => args.includes('bootstrap'))!;
    const toolkitStackName = bootstrap.indexOf('--toolkit-stack-name');
    expect(bootstrap.slice(toolkitStackName, toolkitStackName + 2)).toEqual(['--toolkit-stack-name', TOOLKIT_STACK]);
    expect(bootstrap).not.toContain('--stack-name');
    const contexts = bootstrap.flatMap((arg, index) => arg === '-c' ? [bootstrap[index + 1]!] : []);
    expect(contexts).toEqual([`account=${manifest.account}`, `region=${manifest.region}`, 'postgresVersion=17.6', 'phase=bootstrap',
      'lambdaConcurrencyMode=shared-unreserved', `qualifier=${manifest.qualifier}`, `expiresAt=${expiry.expiresAt}`]);
    expect(bootstrap.some((arg) => /^repository=|^branch=|^sourceCommit=/.test(arg))).toBe(false);
    expect(JSON.stringify(bootstrap)).not.toMatch(/password|secret(?:access)?key|sessiontoken|@example\./i);
    expect(commands.find((args) => args.includes('deploy'))).toContain('lambdaConcurrencyMode=shared-unreserved');
    expect(commands.find((args) => args.includes('deploy'))).toEqual(expect.arrayContaining([
      'repositoryOwnerId=18458919', 'repositoryId=1360681625',
    ]));
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
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main', sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async (command: { input: { StackName: string } }) => {
        if (command.input.StackName === APP_STACK) throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
        inspections += 1;
        if (inspections === 1) throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
        throw new Error('ownership reinspection unavailable');
      } } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => ({ stdout: '', stderr: '' }), preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => undefined,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('ownership reinspection unavailable');
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ toolkitStack: TOOLKIT_STACK, deliveryStack: DELIVERY_STACK, resources: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('adopts immutable repository identity and a new commit for a legacy delivery-only bootstrap manifest', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-legacy-delivery-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  const prior: DeploymentManifest = {
    ...manifest, phase: 'bootstrap', outputs: {}, sourceCommit: 'b'.repeat(40), resources: [
      { type: 'Bootstrap::AWS::CloudFormation::Stack', id: TOOLKIT_STACK, owned: true },
      { type: 'Delivery::AWS::CloudFormation::Stack', id: DELIVERY_STACK, owned: true },
      { type: 'AWS::IAM::OIDCProvider', id: 'token.actions.githubusercontent.com', owned: false },
    ],
  };
  delete prior.repository;
  delete prior.repositoryOwnerId;
  delete prior.repositoryId;
  delete prior.branch;
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
      sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async (command: { input: { StackName: string } }) => {
        if (command.input.StackName === APP_STACK) throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
        return { Stacks: [{ Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] };
      } } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => { throw new Error('stop after safe legacy adoption'); }, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => prior,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('stop after safe legacy adoption');
    expect(saves[0]).toMatchObject({ sourceCommit: 'a'.repeat(40), expiresAt: expiry.expiresAt, repository: 'OWNER/REPOSITORY',
      repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses legacy delivery-only manifest adoption when any live application stack exists', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-live-application-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const prior: DeploymentManifest = {
    ...manifest, phase: 'bootstrap', outputs: {}, sourceCommit: 'b'.repeat(40), resources: [
      { type: 'Bootstrap::AWS::CloudFormation::Stack', id: TOOLKIT_STACK, owned: true },
      { type: 'Delivery::AWS::CloudFormation::Stack', id: DELIVERY_STACK, owned: true },
    ],
  };
  delete prior.repository;
  delete prior.repositoryOwnerId;
  delete prior.repositoryId;
  delete prior.branch;
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
      sourceCommit: 'a'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => ({ Stacks: [{ StackStatus: 'ROLLBACK_COMPLETE' }] }) } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => prior,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow(/application stack.*absent/i);
    expect(saves).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses to rebind an application manifest to a different source commit', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-setup-existing-application-'));
  const configPath = join(root, 'config.json');
  const saves: DeploymentManifest[] = [];
  try {
    await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 5, repository: manifest.repository, repositoryOwnerId: manifest.repositoryOwnerId, repositoryId: manifest.repositoryId,
      branch: manifest.branch, sourceCommit: 'b'.repeat(40), ...expiry, accountsFile: '/unused', priceReport: '/unused' }), { mode: 0o600 });
    await expect(setupDelivery(configPath, {
      sts: { send: async () => ({ Account: manifest.account }) } as never,
      cloudformation: { send: async () => ({ Stacks: [{ Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] }) } as never,
      iam: { send: async () => ({ OpenIDConnectProviderList: [] }) } as never,
      runner: async () => { throw new Error('runner must not mutate AWS'); }, preflight: async () => {}, verifyGitHubIdentity: async () => {}, loadManifest: async () => manifest,
      saveManifest: async (value) => { saves.push(structuredClone(value)); }, writeResult: async () => {},
    })).rejects.toThrow('Saved deployment manifest does not match the delivery target.');
    expect(saves).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
