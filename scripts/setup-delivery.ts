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
};

export const setupDelivery = async (configPath: string, dependencies: SetupDeliveryDependencies = {}): Promise<{ roleArn: string; oidcProviderArn?: string }> => {
  const config = await readAwsDemoInput(configPath);
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
  const prior = await loadManifest();
  if (prior && (prior.account !== config.account || prior.region !== config.region || prior.projectTag !== PROJECT_TAG ||
    prior.appStack !== APP_STACK || prior.toolkitStack !== TOOLKIT_STACK || prior.qualifier !== QUALIFIER || prior.sourceCommit !== config.sourceCommit)) {
    throw new Error('Saved deployment manifest does not match the delivery target.');
  }
  const baseManifest = (): DeploymentManifest => prior ? { ...prior, deliveryStack: DELIVERY_STACK, sourceCommit: config.sourceCommit } : {
    account: config.account, region: config.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
    deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER,
    sourceCommit: config.sourceCommit, phase: 'bootstrap', outputs: {}, resources: [],
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
      '--stack-name', TOOLKIT_STACK, '--qualifier', QUALIFIER, '--tags', `Project=${PROJECT_TAG}`]);
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
    '-c', 'phase=bootstrap', '-c', `qualifier=${QUALIFIER}`, '-c', `repository=${config.repository}`, '-c', `branch=${config.branch}`,
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
