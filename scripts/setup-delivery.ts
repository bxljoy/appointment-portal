import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DescribeStacksCommand, CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { GetOpenIDConnectProviderCommand, IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { listStackResources, makeAwsPreflightProbe, readAwsDemoInput } from './aws-lifecycle.js';
import { runPreflight, runProcess, toPreflightInput, type PreflightProbe, type ProcessRunner } from './preflight.js';
import { APP_STACK, DELIVERY_STACK, PROJECT_TAG, QUALIFIER, TOOLKIT_STACK, deduplicateResources, loadDeploymentManifest, saveDeploymentManifest,
  type DeploymentManifest, type ResourceRecord } from './lifecycle-types.js';
import { readPrivateFile, writePrivateJson } from './private-file.js';

type SetupDeliveryDependencies = {
  sts?: Pick<STSClient, 'send'>;
  cloudformation?: Pick<CloudFormationClient, 'send'>;
  iam?: Pick<IAMClient, 'send'>;
  runner?: ProcessRunner;
  preflight?: (config: Awaited<ReturnType<typeof readAwsDemoInput>>) => Promise<void>;
  runPreflight?: typeof runPreflight;
  makePreflightProbe?: (config: Awaited<ReturnType<typeof readAwsDemoInput>>) => PreflightProbe;
  loadManifest?: () => Promise<DeploymentManifest | undefined>;
  saveManifest?: (manifest: DeploymentManifest) => Promise<void>;
  listResources?: (client: Pick<CloudFormationClient, 'send'>, name: string, prefix: string) => Promise<ResourceRecord[]>;
  readOutputs?: (path: string) => Promise<unknown>;
  writeResult?: (path: string, value: unknown) => Promise<void>;
  verifyGitHubIdentity?: (config: Pick<Awaited<ReturnType<typeof readAwsDemoInput>>, 'repository' | 'repositoryOwnerId' | 'repositoryId'>) => Promise<void>;
};

const repositoryIdentitySchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repositoryOwnerId: z.string().regex(/^[1-9]\d{0,19}$/),
  repositoryId: z.string().regex(/^[1-9]\d{0,19}$/),
});

export const verifyGitHubRepositoryIdentity = async (input: z.infer<typeof repositoryIdentitySchema>, runner: ProcessRunner = runProcess): Promise<void> => {
  const config = repositoryIdentitySchema.parse(input);
  const request = async (path: string): Promise<unknown> => {
    const { stdout } = await runner('gh', ['api', path]);
    try { return JSON.parse(stdout) as unknown; }
    catch { throw new Error('GitHub API returned invalid repository identity JSON.'); }
  };
  const repository = z.object({
    full_name: z.string(), id: z.number().int().positive(), owner: z.object({ id: z.number().int().positive() }),
  }).parse(await request(`repos/${config.repository}`));
  if (repository.full_name !== config.repository || String(repository.owner.id) !== config.repositoryOwnerId || String(repository.id) !== config.repositoryId) {
    throw new Error('GitHub repository identity does not match the selected deployment repository.');
  }
  const customization = z.object({ sub_claim_prefix: z.string() }).parse(
    await request(`repos/${config.repository}/actions/oidc/customization/sub`),
  );
  const [owner, name] = config.repository.split('/') as [string, string];
  const expected = `repo:${owner}@${config.repositoryOwnerId}/${name}@${config.repositoryId}`;
  if (customization.sub_claim_prefix !== expected) throw new Error('GitHub Actions OIDC subject prefix does not match the immutable repository identity.');
};

export const setupDelivery = async (configPath: string, dependencies: SetupDeliveryDependencies = {}): Promise<{ roleArn: string; oidcProviderArn?: string }> => {
  const config = await readAwsDemoInput(configPath, { requireCurrentCreation: false, requireUnexpired: false });
  const sts = dependencies.sts ?? new STSClient({ region: config.region });
  const account = z.string().regex(/^\d{12}$/).parse((await sts.send(new GetCallerIdentityCommand({}))).Account);
  if (account !== config.account) throw new Error('AWS account mismatch.');
  const cloudformation = dependencies.cloudformation ?? new CloudFormationClient({ region: config.region });
  const iam = dependencies.iam ?? new IAMClient({ region: config.region });
  const runner = dependencies.runner ?? runProcess;
  const loadManifest = dependencies.loadManifest ?? loadDeploymentManifest;
  const saveManifest = dependencies.saveManifest ?? saveDeploymentManifest;
  const listResources = dependencies.listResources ?? listStackResources;
  const writeResult = dependencies.writeResult ?? writePrivateJson;
  const readOutputs = dependencies.readOutputs ?? (async (path: string) => JSON.parse(await readPrivateFile(path)) as unknown);
  await (dependencies.preflight ?? (async (input) => {
    await (dependencies.runPreflight ?? runPreflight)(toPreflightInput(input), (dependencies.makePreflightProbe ?? makeAwsPreflightProbe)(input));
  }))(config);
  await (dependencies.verifyGitHubIdentity ?? ((identity) => verifyGitHubRepositoryIdentity(identity, runner)))(config);
  const prior = await loadManifest();
  const deliveryOnly = prior?.phase === 'bootstrap' && Object.keys(prior.outputs).length === 0 && prior.resources.every((resource) =>
    resource.type.startsWith('Bootstrap::') || resource.type.startsWith('Delivery::') || resource.type === 'AWS::IAM::OIDCProvider');
  if (prior && (prior.account !== config.account || prior.region !== config.region || prior.projectTag !== PROJECT_TAG ||
    prior.appStack !== APP_STACK || prior.toolkitStack !== TOOLKIT_STACK || prior.qualifier !== QUALIFIER ||
    prior.deliveryStack !== undefined && prior.deliveryStack !== DELIVERY_STACK ||
    prior.repository !== undefined && prior.repository !== config.repository ||
    prior.repositoryOwnerId !== undefined && prior.repositoryOwnerId !== config.repositoryOwnerId ||
    prior.repositoryId !== undefined && prior.repositoryId !== config.repositoryId ||
    prior.branch !== undefined && prior.branch !== config.branch ||
    !deliveryOnly && prior.sourceCommit !== config.sourceCommit ||
    !deliveryOnly && (prior.repository === undefined || prior.repositoryOwnerId === undefined || prior.repositoryId === undefined || prior.branch === undefined))) {
    throw new Error('Saved deployment manifest does not match the delivery target.');
  }
  if ((prior === undefined || deliveryOnly) && await stack(cloudformation, APP_STACK)) {
    throw new Error(`Delivery setup requires application stack ${APP_STACK} to be absent before binding a fresh deployment identity.`);
  }
  const baseManifest = (): DeploymentManifest => prior ? { ...prior, deliveryStack: DELIVERY_STACK,
    ...(deliveryOnly ? { sourceCommit: config.sourceCommit, repository: config.repository, repositoryOwnerId: config.repositoryOwnerId,
      repositoryId: config.repositoryId, branch: config.branch, expiresAt: config.expiresAt } : {}) } : {
    account: config.account, region: config.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
    deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER,
    sourceCommit: config.sourceCommit, repository: config.repository, repositoryOwnerId: config.repositoryOwnerId,
    repositoryId: config.repositoryId, branch: config.branch, phase: 'bootstrap', outputs: {}, resources: [],
  };
  let recovery = baseManifest();
  const checkpoint = async (resource: ResourceRecord) => {
    recovery = { ...recovery, resources: deduplicateResources([...recovery.resources, resource]) };
    await saveManifest(recovery);
  };
  const toolkit = await stack(cloudformation, TOOLKIT_STACK);
  if (toolkit && !owned(toolkit)) throw new Error(`Refusing to adopt unowned stack ${TOOLKIT_STACK}.`);
  if (!toolkit) {
    recovery = { ...recovery, resources: recovery.resources.filter((resource) => !resource.type.startsWith('Bootstrap::')) };
    await saveManifest(recovery);
    await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'bootstrap', `aws://${config.account}/${config.region}`,
      '--toolkit-stack-name', TOOLKIT_STACK, '--qualifier', QUALIFIER, '--tags', `Project=${PROJECT_TAG}`,
      '-c', `account=${config.account}`, '-c', `region=${config.region}`, '-c', `postgresVersion=${config.postgresVersion}`,
      '-c', 'phase=bootstrap', '-c', `lambdaConcurrencyMode=${config.lambdaConcurrencyMode}`,
      '-c', `qualifier=${QUALIFIER}`, '-c', `expiresAt=${config.expiresAt}`]);
    await saveManifest(recovery);
  }
  await requireOwnedStack(cloudformation, TOOLKIT_STACK);
  await checkpoint({ type: 'Bootstrap::AWS::CloudFormation::Stack', id: TOOLKIT_STACK, owned: true });
  await refuseUnownedStack(cloudformation, DELIVERY_STACK);
  const oidcProviderArn = await findGitHubProvider(iam);
  const outputPath = resolve('.runtime/delivery-outputs.json');
  await writeResult(outputPath, {});
  await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'deploy', DELIVERY_STACK, '--exclusively', '--require-approval', 'never',
    '--outputs-file', outputPath,
    '-c', `account=${config.account}`, '-c', `region=${config.region}`, '-c', `postgresVersion=${config.postgresVersion}`,
    '-c', 'phase=bootstrap', '-c', `lambdaConcurrencyMode=${config.lambdaConcurrencyMode}`,
    '-c', `qualifier=${QUALIFIER}`, '-c', `repository=${config.repository}`, '-c', `branch=${config.branch}`,
    '-c', `repositoryOwnerId=${config.repositoryOwnerId}`, '-c', `repositoryId=${config.repositoryId}`,
    '-c', `sourceCommit=${config.sourceCommit}`,
    ...(oidcProviderArn ? ['-c', `oidcProviderArn=${oidcProviderArn}`] : [])]);
  await saveManifest(recovery);
  await requireOwnedStack(cloudformation, DELIVERY_STACK);
  await checkpoint({ type: 'Delivery::AWS::CloudFormation::Stack', id: DELIVERY_STACK, owned: true });
  const outputs = z.record(z.string(), z.record(z.string(), z.string())).parse(await readOutputs(outputPath));
  const roleArn = z.string().startsWith('arn:aws:iam::').parse(outputs[DELIVERY_STACK]?.DeliveryRoleArn);
  const result = { roleArn, ...(oidcProviderArn ? { oidcProviderArn } : {}) };
  await writeResult(resolve('.runtime/delivery.json'), result);
  const resources = deduplicateResources([
    ...recovery.resources,
    ...await listResources(cloudformation, TOOLKIT_STACK, 'Bootstrap::'),
    ...await listResources(cloudformation, DELIVERY_STACK, 'Delivery::'),
    ...(oidcProviderArn ? [{ type: 'AWS::IAM::OIDCProvider', id: 'token.actions.githubusercontent.com', arn: oidcProviderArn, owned: false }] : []),
  ]);
  await saveManifest({ ...recovery, resources });
  return result;
};

const findGitHubProvider = async (iam: Pick<IAMClient, 'send'>): Promise<string | undefined> => {
  for (const provider of (await iam.send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? []) {
    if (!provider.Arn) continue;
    const details = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: provider.Arn }));
    if (details.Url === 'token.actions.githubusercontent.com') {
      if (!details.ClientIDList?.includes('sts.amazonaws.com')) throw new Error('Existing GitHub OIDC provider lacks the AWS STS audience.');
      return provider.Arn;
    }
  }
  return undefined;
};

const stack = async (client: Pick<CloudFormationClient, 'send'>, name: string) => {
  try { return (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]; }
  catch (error) { if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ValidationError') return undefined; throw error; }
};
const owned = (value: Awaited<ReturnType<typeof stack>>) => value?.Tags?.some((tag) => tag.Key === 'Project' && tag.Value === PROJECT_TAG) ?? false;
const requireOwnedStack = async (client: Pick<CloudFormationClient, 'send'>, name: string) => { const value = await stack(client, name); if (!value || !owned(value)) throw new Error(`${name} must exist with established project ownership.`); };
const refuseUnownedStack = async (client: Pick<CloudFormationClient, 'send'>, name: string) => { const value = await stack(client, name); if (value && !owned(value)) throw new Error(`Refusing to adopt unowned stack ${name}.`); };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime deployment configuration path.');
    const result = await setupDelivery(process.argv[2]!);
    process.stdout.write(`Delivery role created or updated: ${result.roleArn}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Delivery setup failed.'}\n`); process.exitCode = 1; }
}
