import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DescribeStacksCommand, CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { GetOpenIDConnectProviderCommand, IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { listStackResources, makeAwsPreflightProbe, readAwsDemoInput } from './aws-lifecycle.js';
import { runPreflight, runProcess } from './preflight.js';
import { APP_STACK, DELIVERY_STACK, PROJECT_TAG, QUALIFIER, TOOLKIT_STACK, deduplicateResources, loadDeploymentManifest, saveDeploymentManifest } from './lifecycle-types.js';

export const setupDelivery = async (configPath: string): Promise<{ roleArn: string; oidcProviderArn?: string }> => {
  const config = await readAwsDemoInput(configPath);
  const sts = new STSClient({ region: config.region });
  const account = z.string().regex(/^\d{12}$/).parse((await sts.send(new GetCallerIdentityCommand({}))).Account);
  if (account !== config.account) throw new Error('AWS account mismatch.');
  const cloudformation = new CloudFormationClient({ region: config.region });
  await runPreflight(config, makeAwsPreflightProbe(config));
  const toolkit = await stack(cloudformation, TOOLKIT_STACK);
  if (toolkit && !owned(toolkit)) throw new Error(`Refusing to adopt unowned stack ${TOOLKIT_STACK}.`);
  if (!toolkit) {
    await runProcess('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'bootstrap', `aws://${config.account}/${config.region}`,
      '--stack-name', TOOLKIT_STACK, '--qualifier', QUALIFIER, '--tags', `Project=${PROJECT_TAG}`]);
  }
  await requireOwnedStack(cloudformation, TOOLKIT_STACK);
  await refuseUnownedStack(cloudformation, DELIVERY_STACK);
  const oidcProviderArn = await findGitHubProvider(new IAMClient({ region: config.region }));
  await runProcess('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'deploy', DELIVERY_STACK, '--exclusively', '--require-approval', 'never',
    '--outputs-file', resolve('.runtime/delivery-outputs.json'),
    '-c', `account=${config.account}`, '-c', `region=${config.region}`, '-c', `postgresVersion=${config.postgresVersion}`,
    '-c', 'phase=bootstrap', '-c', `qualifier=${QUALIFIER}`, '-c', `repository=${config.repository}`, '-c', `branch=${config.branch}`,
    ...(oidcProviderArn ? ['-c', `oidcProviderArn=${oidcProviderArn}`] : [])]);
  const outputs = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(await readFile(resolve('.runtime/delivery-outputs.json'), 'utf8')));
  const roleArn = z.string().startsWith('arn:aws:iam::').parse(outputs[DELIVERY_STACK]?.DeliveryRoleArn);
  const result = { roleArn, ...(oidcProviderArn ? { oidcProviderArn } : {}) };
  await writeFile(resolve('.runtime/delivery.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const prior = await loadDeploymentManifest();
  const resources = deduplicateResources([
    ...(prior?.resources ?? []),
    ...await listStackResources(cloudformation, TOOLKIT_STACK, 'Bootstrap::'),
    ...await listStackResources(cloudformation, DELIVERY_STACK, 'Delivery::'),
    ...(oidcProviderArn ? [{ type: 'AWS::IAM::OIDCProvider', id: 'token.actions.githubusercontent.com', arn: oidcProviderArn, owned: false }] : []),
  ]);
  await saveDeploymentManifest(prior ? { ...prior, deliveryStack: DELIVERY_STACK, resources } : {
    account: config.account, region: config.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
    deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER,
    phase: 'bootstrap', outputs: {}, resources,
  });
  return result;
};

const findGitHubProvider = async (iam: IAMClient): Promise<string | undefined> => {
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

const stack = async (client: CloudFormationClient, name: string) => {
  try { return (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]; }
  catch (error) { if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ValidationError') return undefined; throw error; }
};
const owned = (value: Awaited<ReturnType<typeof stack>>) => value?.Tags?.some((tag) => tag.Key === 'Project' && tag.Value === PROJECT_TAG) ?? false;
const requireOwnedStack = async (client: CloudFormationClient, name: string) => { const value = await stack(client, name); if (!value || !owned(value)) throw new Error(`${name} must exist with established project ownership.`); };
const refuseUnownedStack = async (client: CloudFormationClient, name: string) => { const value = await stack(client, name); if (value && !owned(value)) throw new Error(`Refusing to adopt unowned stack ${name}.`); };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime deployment configuration path.');
    const result = await setupDelivery(process.argv[2]!);
    process.stdout.write(`Delivery role created or updated: ${result.roleArn}\n`);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Delivery setup failed.'}\n`); process.exitCode = 1; }
}
