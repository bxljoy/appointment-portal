import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand, ListStackResourcesCommand, waitUntilStackDeleteComplete } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, CreateInvalidationCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { DeleteVpcEndpointsCommand, DescribeNetworkInterfacesCommand, DescribeVpcEndpointsCommand, EC2Client, type DescribeNetworkInterfacesCommandOutput } from '@aws-sdk/client-ec2';
import { DeleteRepositoryCommand, DescribeRepositoriesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { DeleteOpenIDConnectProviderCommand, GetOpenIDConnectProviderCommand, IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { GetAccountSettingsCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteParameterCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DeleteDBInstanceAutomatedBackupCommand, DeleteDBSnapshotCommand, DescribeDBEngineVersionsCommand, DescribeDBInstanceAutomatedBackupsCommand, DescribeDBInstancesCommand, DescribeDBProxiesCommand, DescribeDBProxyTargetsCommand, DescribeDBSnapshotsCommand, DescribeOrderableDBInstanceOptionsCommand, RDSClient, type DescribeDBInstanceAutomatedBackupsCommandOutput, type DescribeDBInstancesCommandOutput, type DescribeDBProxiesCommandOutput } from '@aws-sdk/client-rds';
import { DeleteBucketCommand, DeleteObjectsCommand, HeadBucketCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteSecretCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DeleteLogGroupCommand, DescribeLogGroupsCommand, CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { z } from 'zod';
import { invokeMigration } from './invoke-migration.js';
import { provisionUsers, RuntimeCredentialStore, type ControlledAccount } from './provision.js';
import { runPreflight, runProcess, type PreflightProbe, type ProcessRunner } from './preflight.js';
import { publishFrontend, type PublishFile } from './publish.js';
import { APP_STACK, DELIVERY_STACK, PROJECT_TAG, QUALIFIER, TOOLKIT_STACK, deduplicateResources, type DeploymentManifest, type InventoryAdapter, type InventoryPage, type ResourceRecord } from './lifecycle-types.js';
import type { DemoConfig, DemoDependencies } from './deploy.js';

const configSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  postgresVersion: z.string().regex(/^17\.[1-9]\d*$/), durationHours: z.number().positive().max(24), maxCostUsd: z.number().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  accountsFile: z.string().min(1), priceReport: z.string().min(1),
  oidcProviderArn: z.string().startsWith('arn:aws:iam::').optional(),
});
export type AwsDemoInput = z.infer<typeof configSchema>;

const priceSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }), region: z.string(), currency: z.literal('USD'),
  sources: z.array(z.url()).min(2), assumptions: z.string().min(20),
  rates: z.strictObject({
    databaseHourly: z.number().nonnegative(), proxyVcpuHourly: z.number().nonnegative(), databaseVcpus: z.number().int().positive(),
    interfaceEndpointAzHourly: z.number().nonnegative(), azCount: z.number().int().min(2).max(3),
    cognito: z.number().nonnegative(), logging: z.number().nonnegative(), storage: z.number().nonnegative(), transfer: z.number().nonnegative(),
  }),
});

export type AwsClients = {
  cloudformation: CloudFormationClient; cloudfront: CloudFrontClient; ec2: EC2Client; ecr: ECRClient; iam: IAMClient;
  lambda: LambdaClient; rds: RDSClient; s3: S3Client; secrets: SecretsManagerClient; ssm: SSMClient;
  sts: STSClient; logs: CloudWatchLogsClient; cognito: CognitoIdentityProviderClient;
};

const clientsFor = (region: string): AwsClients => ({
  cloudformation: new CloudFormationClient({ region }), cloudfront: new CloudFrontClient({ region }), ec2: new EC2Client({ region }),
  ecr: new ECRClient({ region }), iam: new IAMClient({ region }), lambda: new LambdaClient({ region }), rds: new RDSClient({ region }),
  s3: new S3Client({ region }), secrets: new SecretsManagerClient({ region }), ssm: new SSMClient({ region }),
  sts: new STSClient({ region }), logs: new CloudWatchLogsClient({ region }), cognito: new CognitoIdentityProviderClient({ region }),
});

export const readAwsDemoInput = async (path: string): Promise<AwsDemoInput> => configSchema.parse(JSON.parse(await readFile(path, 'utf8')));

export const makeAwsPreflightProbe = (input: AwsDemoInput, clients: AwsClients = clientsFor(input.region), runner: ProcessRunner = runProcess): PreflightProbe => ({
  async identity() { return z.string().regex(/^\d{12}$/).parse((await clients.sts.send(new GetCallerIdentityCommand({}))).Account); },
  async regionalCapabilities({ postgresVersion }) {
    const engine = await clients.rds.send(new DescribeDBEngineVersionsCommand({ Engine: 'postgres', EngineVersion: postgresVersion }));
    const options = await clients.rds.send(new DescribeOrderableDBInstanceOptionsCommand({ Engine: 'postgres', EngineVersion: postgresVersion, DBInstanceClass: 'db.t4g.small', Vpc: true }));
    await clients.rds.send(new DescribeDBProxiesCommand({ MaxRecords: 20 }));
    return { postgres: Boolean(engine.DBEngineVersions?.length), instanceClass: Boolean(options.OrderableDBInstanceOptions?.length), proxy: true };
  },
  async unreservedConcurrency() {
    return z.number().int().nonnegative().parse((await clients.lambda.send(new GetAccountSettingsCommand({}))).AccountLimit?.UnreservedConcurrentExecutions);
  },
  async runtimeVersions() {
    const [node, pnpm, docker] = await Promise.all([
      runner(process.execPath, ['--version']), runner('pnpm', ['--version']), runner('docker', ['--version']),
    ]);
    return { node: node.stdout.trim().replace(/^v/, ''), pnpm: pnpm.stdout.trim(), docker: z.string().regex(/\d+\.\d+\.\d+/).parse(docker.stdout.match(/\d+\.\d+\.\d+/)?.[0]) };
  },
  async gitClean() { return (await runner('git', ['status', '--porcelain'])).stdout.trim() === ''; },
  async costRates() {
    const report = priceSchema.parse(JSON.parse(await readFile(input.priceReport, 'utf8')));
    if (report.region !== input.region) throw new Error('Price report region does not match the deployment.');
    if (Date.now() - new Date(report.checkedAt).getTime() > 7 * 86_400_000) throw new Error('Price report is older than seven days.');
    return report.rates;
  },
});

const contextArgs = (input: AwsDemoInput, phase: 'bootstrap' | 'ready', frontendUrl?: string) => [
  '-c', `account=${input.account}`, '-c', `region=${input.region}`, '-c', `postgresVersion=${input.postgresVersion}`,
  '-c', `phase=${phase}`, '-c', `qualifier=${QUALIFIER}`, ...(frontendUrl ? ['-c', `frontendUrl=${frontendUrl}`] : []),
];

export const makeAwsDemoDependencies = (input: AwsDemoInput, clients = clientsFor(input.region), runner: ProcessRunner = runProcess): DemoDependencies => {
  const config: DemoConfig = { ...input, qualifier: QUALIFIER, toolkitStack: TOOLKIT_STACK, appStack: APP_STACK, projectTag: PROJECT_TAG };
  const credentials = new RuntimeCredentialStore(resolve('.runtime/credentials'));
  let activeManifest: DeploymentManifest | undefined;
  return {
    config,
    loadManifest: async () => {
      activeManifest = await (await import('./lifecycle-types.js')).loadDeploymentManifest();
      return activeManifest;
    },
    saveManifest: async (manifest) => { activeManifest = manifest; await (await import('./lifecycle-types.js')).saveDeploymentManifest(manifest); },
    preflight: async () => { await runPreflight(input, makeAwsPreflightProbe(input, clients, runner)); },
    inspectApplication: async () => inspectStackOwnership(clients.cloudformation, APP_STACK),
    inspectBootstrap: async () => inspectStackOwnership(clients.cloudformation, TOOLKIT_STACK),
    bootstrap: async () => {
      await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'bootstrap', `aws://${input.account}/${input.region}`,
        '--stack-name', TOOLKIT_STACK, '--qualifier', QUALIFIER, '--tags', `Project=${PROJECT_TAG}`]);
    },
    deploy: async (phase, frontendUrl) => {
      const outputPath = resolve('.runtime/cdk-outputs.json');
      try {
        await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'deploy', APP_STACK, '--exclusively', '--require-approval', 'never',
          '--outputs-file', outputPath, ...contextArgs(input, phase, frontendUrl)]);
      } catch (error) {
        const partial = await maybeListStackResources(clients.cloudformation, APP_STACK, 'Application::');
        if (partial.length > 0) {
          const toolkit = await listStackResources(clients.cloudformation, TOOLKIT_STACK, 'Bootstrap::');
          const delivery = await maybeListStackResources(clients.cloudformation, DELIVERY_STACK, 'Delivery::');
          const recoverable: DeploymentManifest = {
            account: input.account, region: input.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
            deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER,
            phase: activeManifest?.phase === 'ready' ? 'ready' : 'bootstrap', outputs: activeManifest?.outputs ?? {},
            resources: deduplicateResources([...partial, ...toolkit, ...delivery]),
          };
          activeManifest = recoverable;
          await (await import('./lifecycle-types.js')).saveDeploymentManifest(recoverable);
        }
        throw error;
      }
      const outputsFile = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(await readFile(outputPath, 'utf8')));
      const outputs = outputsFile[APP_STACK];
      if (!outputs) throw new Error('CDK outputs did not contain the application stack.');
      const application = await listStackResources(clients.cloudformation, APP_STACK, 'Application::');
      const toolkit = await listStackResources(clients.cloudformation, TOOLKIT_STACK, 'Bootstrap::');
      const delivery = await maybeListStackResources(clients.cloudformation, DELIVERY_STACK, 'Delivery::');
      activeManifest = {
        account: input.account, region: input.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
        deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER, phase, outputs,
        resources: deduplicateResources([...application, ...toolkit, ...delivery]),
      };
      return activeManifest;
    },
    migrate: async () => { await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'migrate' }, clients.lambda); },
    provision: async () => {
      const accounts = z.array(z.strictObject({ email: z.email(), displayName: z.string().min(1).max(100), role: z.enum(['patient', 'clinician']) })).parse(JSON.parse(await readFile(input.accountsFile, 'utf8'))) as ControlledAccount[];
      const users = await provisionUsers(requiredManifestOutput(activeManifest, 'UserPoolId'), accounts, { cognito: clients.cognito, credentials });
      await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'seed', users, now: new Date().toISOString() }, clients.lambda);
    },
    waitForProxy: async () => waitForProxy(clients.rds, requiredManifestOutput(activeManifest, 'ProxyName')),
    verifyMigration: async () => { await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'migrate' }, clients.lambda); },
    publish: async (manifest) => publishBuiltFrontend(manifest, clients),
    verify: async (manifest) => {
      const frontendUrl = requiredManifestOutput(manifest, 'FrontendUrl');
      await runner('pnpm', ['exec', 'playwright', 'test', '--project=aws'], { env: { ...process.env, PORTAL_E2E_AWS: '1', PORTAL_E2E_AWS_URL: frontendUrl } });
    },
  };
};

const inspectStackOwnership = async (client: CloudFormationClient, name: string) => {
  try {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    return { exists: Boolean(stack), owned: stack?.Tags?.some((tag) => tag.Key === 'Project' && tag.Value === PROJECT_TAG) ?? false };
  } catch (error) {
    if (isValidationError(error)) return { exists: false, owned: false };
    throw error;
  }
};

export const listStackResources = async (client: CloudFormationClient, name: string, prefix: string): Promise<ResourceRecord[]> => {
  const resources: ResourceRecord[] = [];
  let NextToken: string | undefined;
  do {
    const page = await client.send(new ListStackResourcesCommand({ StackName: name, NextToken }));
    for (const item of page.StackResourceSummaries ?? []) if (item.ResourceType && item.PhysicalResourceId) resources.push({
      type: `${prefix}${item.ResourceType}`, id: item.PhysicalResourceId, owned: true,
    });
    NextToken = page.NextToken;
  } while (NextToken);
  return resources;
};

const maybeListStackResources = async (client: CloudFormationClient, name: string, prefix: string): Promise<ResourceRecord[]> => {
  try { return await listStackResources(client, name, prefix); }
  catch (error) { if (isValidationError(error)) return []; throw error; }
};

const waitForProxy = async (client: RDSClient, proxyName: string): Promise<void> => {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const response = await client.send(new DescribeDBProxyTargetsCommand({ DBProxyName: proxyName }));
    const targets = response.Targets ?? [];
    if (targets.length > 0 && targets.every((target) => target.TargetHealth?.State === 'AVAILABLE')) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error('RDS Proxy targets did not become healthy.');
};

const requiredManifestOutput = (manifest: DeploymentManifest | undefined, name: string): string => {
  const value = manifest?.outputs[name]; if (!value) throw new Error(`Deployment output ${name} is unavailable.`); return value;
};

const publishBuiltFrontend = async (manifest: DeploymentManifest, clients: AwsClients): Promise<void> => {
  const files = await readFrontendFiles(resolve('apps/web/dist'));
  const frontendUrl = requiredManifestOutput(manifest, 'FrontendUrl');
  const userPoolId = requiredManifestOutput(manifest, 'UserPoolId');
  const clientId = requiredManifestOutput(manifest, 'ClientId');
  const client = await clients.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }));
  const callbacks = client.UserPoolClient?.CallbackURLs ?? [];
  const callbackUrl = callbacks.find((value) => value === `${frontendUrl}/auth/callback`);
  if (!callbackUrl) throw new Error('Deployed Cognito callback does not match CloudFront.');
  const bucket = requiredManifestOutput(manifest, 'WebBucketName');
  const distribution = requiredManifestOutput(manifest, 'DistributionId');
  await publishFrontend({
    frontendUrl, callbackUrl,
    publicConfig: { mode: 'cognito', issuer: requiredManifestOutput(manifest, 'Issuer'), clientId,
      cognitoDomain: requiredManifestOutput(manifest, 'CognitoDomain'), apiBaseUrl: '/api' }, files,
  }, {
    upload: async (entry) => {
      const checksum = createHash('sha256').update(entry.body).digest('base64');
      if (entry.cacheControl.includes('immutable')) {
        try {
          const prior = await clients.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: entry.key }));
          if (prior.ChecksumSHA256 !== checksum) throw new Error(`Refusing to overwrite immutable asset ${entry.key}.`);
          return;
        } catch (error) { if (!isNotFound(error)) throw error; }
      }
      await clients.s3.send(new PutObjectCommand({ Bucket: bucket, Key: entry.key, Body: entry.body,
        ContentType: entry.contentType, CacheControl: entry.cacheControl, ChecksumSHA256: checksum }));
    },
    invalidate: async (paths) => (await clients.cloudfront.send(new CreateInvalidationCommand({ DistributionId: distribution,
      InvalidationBatch: { CallerReference: `${Date.now()}-${createHash('sha256').update(paths.join('\0')).digest('hex').slice(0, 12)}`, Paths: { Quantity: paths.length, Items: paths } } }))).Invalidation?.Id ?? (() => { throw new Error('CloudFront did not return an invalidation ID.'); })(),
    waitInvalidation: async (id) => { const result = await waitUntilInvalidationCompleted({ client: clients.cloudfront, maxWaitTime: 300 }, { DistributionId: distribution, Id: id }); if (result.state !== 'SUCCESS') throw new Error('CloudFront invalidation did not complete.'); },
  });
};

const readFrontendFiles = async (root: string, directory = root): Promise<PublishFile[]> => {
  const files: PublishFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Frontend build must not contain symbolic links.');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await readFrontendFiles(root, path));
    else if (entry.isFile()) files.push({ key: path.slice(root.length + 1), body: await readFile(path), contentType: contentType(path) });
  }
  return files;
};

const contentType = (path: string) => ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(path)] ?? 'application/octet-stream');
const isValidationError = (error: unknown) => typeof error === 'object' && error !== null && 'name' in error && error.name === 'ValidationError';
const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && ('$metadata' in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404 || 'name' in error && error.name === 'NotFound');
const isParameterMissing = (error: unknown) => typeof error === 'object' && error !== null && 'name' in error && error.name === 'ParameterNotFound';

export class AwsInventoryAdapter implements InventoryAdapter {
  private resources?: ResourceRecord[];
  constructor(readonly manifest: DeploymentManifest, readonly clients: AwsClients = clientsFor(manifest.region), readonly options: { forceDeleteSecrets?: boolean; archivePath?: string } = {}) {}

  async account() { return z.string().regex(/^\d{12}$/).parse((await this.clients.sts.send(new GetCallerIdentityCommand({}))).Account); }
  async page(cursor?: string): Promise<InventoryPage> {
    this.resources ??= await this.inventory();
    const start = cursor ? z.coerce.number().int().nonnegative().parse(cursor) : 0;
    const items = this.resources.slice(start, start + 100);
    return { items, ...(start + 100 < this.resources.length ? { nextCursor: String(start + 100) } : {}) };
  }
  async archive(manifest: DeploymentManifest) { await writeFile(this.options.archivePath ?? resolve('.runtime/pre-destroy-inventory.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); }
  async deleteStack(name: string) {
    const stack = await inspectStackOwnership(this.clients.cloudformation, name);
    if (!stack.exists) return;
    if (!stack.owned) throw new Error(`Refusing to delete stack ${name} without established project ownership.`);
    await this.clients.cloudformation.send(new DeleteStackCommand({ StackName: name }));
  }
  async waitStackDeleted(name: string) { const result = await waitUntilStackDeleteComplete({ client: this.clients.cloudformation, maxWaitTime: 1800 }, { StackName: name }); if (result.state !== 'SUCCESS') throw new Error(`Stack ${name} deletion did not complete.`); this.resources = undefined; }
  async deleteResource(resource: ResourceRecord) {
    const type = resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '');
    if (type === 'AWS::RDS::DBSnapshot') await this.clients.rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: resource.id }));
    else if (type === 'AWS::RDS::DBInstanceAutomatedBackup') await this.clients.rds.send(new DeleteDBInstanceAutomatedBackupCommand({ DbiResourceId: resource.id }));
    else if (type === 'AWS::SecretsManager::Secret') {
      if (!this.options.forceDeleteSecrets) throw new Error(`Secret ${resource.id} requires explicit immediate-cleanup mode.`);
      await this.clients.secrets.send(new DeleteSecretCommand({ SecretId: resource.arn ?? resource.id, ForceDeleteWithoutRecovery: true }));
    } else if (type === 'AWS::Logs::LogGroup') await this.clients.logs.send(new DeleteLogGroupCommand({ logGroupName: resource.id }));
    else if (type === 'AWS::EC2::VPCEndpoint') await this.clients.ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [resource.id] }));
    else if (type === 'AWS::ECR::Repository') await this.clients.ecr.send(new DeleteRepositoryCommand({ repositoryName: resource.id, force: true }));
    else if (type === 'AWS::SSM::Parameter') await this.clients.ssm.send(new DeleteParameterCommand({ Name: resource.id }));
    else if (type === 'AWS::IAM::OIDCProvider') {
      if (!resource.owned || !resource.arn) throw new Error('Shared or unidentified OIDC providers cannot be deleted.');
      await this.clients.iam.send(new DeleteOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: resource.arn }));
    } else if (type === 'AWS::S3::ObjectVersion' || type === 'AWS::S3::DeleteMarker') {
      const parsed = z.strictObject({ bucket: z.string(), key: z.string(), versionId: z.string() }).parse(JSON.parse(resource.id));
      await this.clients.s3.send(new DeleteObjectsCommand({ Bucket: parsed.bucket, Delete: { Objects: [{ Key: parsed.key, VersionId: parsed.versionId }], Quiet: true } }));
    } else if (type === 'AWS::S3::Bucket') await this.clients.s3.send(new DeleteBucketCommand({ Bucket: resource.id }));
    else throw new Error(`No safe explicit cleanup operation exists for ${resource.type}:${resource.id}.`);
  }

  private async inventory(): Promise<ResourceRecord[]> {
    const known = new Map(this.manifest.resources.map((item) => [`${item.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '')}\0${item.id}`, item]));
    const ownedId = (type: string, id: string) => known.has(`${type}\0${id}`) || this.manifest.resources.some((item) => item.id === id && item.owned);
    const resources: ResourceRecord[] = [];
    const stackNames: string[] = [this.manifest.appStack, ...(this.manifest.deliveryStack ? [this.manifest.deliveryStack] : []), this.manifest.toolkitStack];
    for (const name of stackNames) {
      const prefix = name === this.manifest.appStack ? 'Application::' : name === this.manifest.deliveryStack ? 'Delivery::' : 'Bootstrap::';
      resources.push(...await maybeListStackResources(this.clients.cloudformation, name, prefix));
    }
    let Marker: string | undefined;
    do {
      const page = await this.clients.rds.send(new DescribeDBSnapshotsCommand({ Marker }));
      for (const snapshot of page.DBSnapshots ?? []) if (snapshot.DBSnapshotIdentifier &&
        (ownedId('AWS::RDS::DBSnapshot', snapshot.DBSnapshotIdentifier) || snapshot.DBInstanceIdentifier === this.manifest.outputs.DatabaseId)) resources.push({
        type: 'Application::AWS::RDS::DBSnapshot', id: snapshot.DBSnapshotIdentifier, arn: snapshot.DBSnapshotArn, owned: true });
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBInstancesCommandOutput = await this.clients.rds.send(new DescribeDBInstancesCommand({ Marker }));
      for (const database of page.DBInstances ?? []) if (database.DBInstanceIdentifier === this.manifest.outputs.DatabaseId) resources.push({
        type: 'AWS::RDS::DBInstance', id: database.DBInstanceIdentifier, arn: database.DBInstanceArn, owned: true,
      });
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBProxiesCommandOutput = await this.clients.rds.send(new DescribeDBProxiesCommand({ Marker }));
      for (const proxy of page.DBProxies ?? []) if (proxy.DBProxyName === this.manifest.outputs.ProxyName) resources.push({
        type: 'AWS::RDS::DBProxy', id: proxy.DBProxyName, arn: proxy.DBProxyArn, owned: true,
      });
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBInstanceAutomatedBackupsCommandOutput = await this.clients.rds.send(new DescribeDBInstanceAutomatedBackupsCommand({ Marker }));
      for (const backup of page.DBInstanceAutomatedBackups ?? []) if (backup.DBInstanceIdentifier === this.manifest.outputs.DatabaseId && backup.DbiResourceId) resources.push({
        type: 'AWS::RDS::DBInstanceAutomatedBackup', id: backup.DbiResourceId, arn: backup.DBInstanceAutomatedBackupsArn, owned: true,
      });
      Marker = page.Marker;
    } while (Marker);
    let secretToken: string | undefined;
    do {
      const page = await this.clients.secrets.send(new ListSecretsCommand({ NextToken: secretToken, IncludePlannedDeletion: true }));
      for (const secret of page.SecretList ?? []) if (secret.Name && secret.ARN && (ownedId('AWS::SecretsManager::Secret', secret.Name) ||
        ownedId('AWS::SecretsManager::Secret', secret.ARN) || secret.ARN === this.manifest.outputs.AdminSecretArn || secret.ARN === this.manifest.outputs.ApplicationSecretArn)) resources.push({
        type: 'AWS::SecretsManager::Secret', id: secret.Name, arn: secret.ARN, owned: true, ...(secret.DeletedDate ? { state: 'scheduled' as const } : {}),
      });
      secretToken = page.NextToken;
    } while (secretToken);
    let logToken: string | undefined;
    do {
      const page = await this.clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/appointment-portal/', nextToken: logToken }));
      for (const group of page.logGroups ?? []) if (group.logGroupName && ownedId('AWS::Logs::LogGroup', group.logGroupName)) resources.push({ type: 'AWS::Logs::LogGroup', id: group.logGroupName, arn: group.arn, owned: true });
      logToken = page.nextToken;
    } while (logToken);
    const knownBuckets = new Map(this.manifest.resources.filter((item) => item.type.endsWith('AWS::S3::Bucket') && item.owned).map((item) => [item.id, item.type.startsWith('Bootstrap::') ? 'Bootstrap::' : item.type.startsWith('Delivery::') ? 'Delivery::' : 'Application::']));
    if (this.manifest.outputs.WebBucketName) knownBuckets.set(this.manifest.outputs.WebBucketName, 'Application::');
    for (const [bucket, prefix] of knownBuckets) {
      try { await this.clients.s3.send(new HeadBucketCommand({ Bucket: bucket })); }
      catch (error) { if (isNotFound(error)) continue; throw error; }
      let KeyMarker: string | undefined; let VersionIdMarker: string | undefined;
      do {
        const page = await this.clients.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, VersionIdMarker }));
        for (const version of page.Versions ?? []) if (version.Key && version.VersionId) resources.push({ type: `${prefix}AWS::S3::ObjectVersion`, id: JSON.stringify({ bucket, key: version.Key, versionId: version.VersionId }), owned: true });
        for (const marker of page.DeleteMarkers ?? []) if (marker.Key && marker.VersionId) resources.push({ type: `${prefix}AWS::S3::DeleteMarker`, id: JSON.stringify({ bucket, key: marker.Key, versionId: marker.VersionId }), owned: true });
        KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
      } while (KeyMarker);
      resources.push({ type: `${prefix}AWS::S3::Bucket`, id: bucket, owned: true });
    }
    let ec2Token: string | undefined;
    do {
      const page = await this.clients.ec2.send(new DescribeVpcEndpointsCommand({ NextToken: ec2Token, Filters: [{ Name: 'tag:Project', Values: [PROJECT_TAG] }] }));
      for (const endpoint of page.VpcEndpoints ?? []) if (endpoint.VpcEndpointId &&
        (ownedId('AWS::EC2::VPCEndpoint', endpoint.VpcEndpointId) || endpoint.VpcId === this.manifest.outputs.VpcId)) resources.push({ type: 'Application::AWS::EC2::VPCEndpoint', id: endpoint.VpcEndpointId, owned: true });
      ec2Token = page.NextToken;
    } while (ec2Token);
    ec2Token = undefined;
    do {
      const page: DescribeNetworkInterfacesCommandOutput = await this.clients.ec2.send(new DescribeNetworkInterfacesCommand({ NextToken: ec2Token, Filters: [{ Name: 'vpc-id', Values: [this.manifest.outputs.VpcId ?? 'vpc-none'] }] }));
      for (const networkInterface of page.NetworkInterfaces ?? []) if (networkInterface.NetworkInterfaceId) resources.push({
        type: 'Application::AWS::EC2::NetworkInterface', id: networkInterface.NetworkInterfaceId, owned: true,
      });
      ec2Token = page.NextToken;
    } while (ec2Token);
    let ecrToken: string | undefined;
    const knownRepositories = new Set(this.manifest.resources.filter((item) => item.type.endsWith('AWS::ECR::Repository') && item.owned).map((item) => item.id));
    do {
      const page = await this.clients.ecr.send(new DescribeRepositoriesCommand({ nextToken: ecrToken }));
      for (const repository of page.repositories ?? []) if (repository.repositoryName && knownRepositories.has(repository.repositoryName)) resources.push({
        type: 'Bootstrap::AWS::ECR::Repository', id: repository.repositoryName, arn: repository.repositoryArn, owned: true,
      });
      ecrToken = page.nextToken;
    } while (ecrToken);
    const bootstrapParameter = `/cdk-bootstrap/${this.manifest.qualifier}/version`;
    try {
      const parameter = (await this.clients.ssm.send(new GetParameterCommand({ Name: bootstrapParameter }))).Parameter;
      if (parameter?.Name && ownedId('AWS::SSM::Parameter', parameter.Name)) resources.push({ type: 'Bootstrap::AWS::SSM::Parameter', id: parameter.Name, arn: parameter.ARN, owned: true });
    } catch (error) { if (!isParameterMissing(error)) throw error; }
    for (const provider of (await this.clients.iam.send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? []) {
      if (!provider.Arn) continue;
      const details = await this.clients.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: provider.Arn }));
      if (details.Url === 'token.actions.githubusercontent.com') resources.push({
        type: this.manifest.resources.some((item) => item.owned && item.id === provider.Arn) ? 'Delivery::AWS::IAM::OIDCProvider' : 'AWS::IAM::OIDCProvider', id: details.Url, arn: provider.Arn,
        owned: this.manifest.resources.some((item) => item.owned && item.id === provider.Arn),
      });
    }
    return deduplicateResources(resources);
  }
}
