import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand, ListStackResourcesCommand, waitUntilStackDeleteComplete } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, CreateInvalidationCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { DeleteVpcEndpointsCommand, DescribeNetworkInterfacesCommand, DescribeVpcEndpointsCommand, EC2Client, type DescribeNetworkInterfacesCommandOutput } from '@aws-sdk/client-ec2';
import { DeleteRepositoryCommand, DescribeRepositoriesCommand, ECRClient, ListTagsForResourceCommand as EcrListTagsForResourceCommand } from '@aws-sdk/client-ecr';
import { GetOpenIDConnectProviderCommand, IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { GetAccountSettingsCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteParameterCommand, DescribeParametersCommand, ListTagsForResourceCommand as SsmListTagsForResourceCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DeleteDBInstanceAutomatedBackupCommand, DeleteDBInstanceCommand, DeleteDBProxyCommand, DeleteDBSnapshotCommand, DescribeDBEngineVersionsCommand, DescribeDBInstanceAutomatedBackupsCommand, DescribeDBInstancesCommand, DescribeDBProxiesCommand, DescribeDBProxyTargetsCommand, DescribeDBSnapshotsCommand, DescribeOrderableDBInstanceOptionsCommand, ListTagsForResourceCommand as RdsListTagsForResourceCommand, RDSClient, type DescribeDBInstanceAutomatedBackupsCommandOutput, type DescribeDBInstancesCommandOutput, type DescribeDBProxiesCommandOutput } from '@aws-sdk/client-rds';
import { ChecksumMode, DeleteBucketCommand, DeleteObjectsCommand, GetBucketTaggingCommand, HeadBucketCommand, HeadObjectCommand, ListBucketsCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteSecretCommand, ListSecretsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DeleteLogGroupCommand, DescribeLogGroupsCommand, ListTagsForResourceCommand as LogsListTagsForResourceCommand, CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider';
import { z } from 'zod';
import { invokeMigration } from './invoke-migration.js';
import { provisionUsers, RuntimeCredentialStore, type ControlledAccount } from './provision.js';
import { runPreflight, runProcess, toPreflightInput, type PreflightProbe, type ProcessRunner } from './preflight.js';
import { publishFrontend, type PublishFile } from './publish.js';
import { APP_STACK, DELIVERY_STACK, PROJECT_TAG, QUALIFIER, TOOLKIT_STACK, deduplicateResources, saveDeploymentManifest, type DeploymentManifest, type InventoryAdapter, type InventoryPage, type ResourceRecord } from './lifecycle-types.js';
import type { DemoConfig, DemoDependencies, StackInspection } from './deploy.js';
import { readPrivateFile, writePrivateJson } from './private-file.js';
import { playwrightVerificationAdapter, verifyAws } from './verify-aws.js';
import { cloudWatchCorrelationAdapter } from './cloudwatch-correlation.js';
import { loadManualRegistration, type ManualRegistrationEvidence } from './manual-registration.js';

const configSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  postgresVersion: z.string().regex(/^17\.[1-9]\d*$/), durationHours: z.number().positive().max(6), maxCostUsd: z.number().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  expiresAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  createdAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')),
  accountsFile: z.string().min(1), priceReport: z.string().min(1),
  oidcProviderArn: z.string().startsWith('arn:aws:iam::').optional(),
}).superRefine((value, context) => {
  const delta = new Date(value.expiresAt).getTime() - new Date(value.createdAt).getTime();
  if (!Number.isFinite(delta) || delta <= 0 || delta > value.durationHours * 60 * 60_000 || delta > 6 * 60 * 60_000) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Maximum lifetime must not exceed the configured duration or six hours.' });
  }
});
export type AwsDemoInput = z.infer<typeof configSchema>;
const CONFIG_CLOCK_SKEW_MS = 5 * 60_000;

const priceSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }), region: z.string(), currency: z.literal('USD'),
  sources: z.array(z.url()).min(2), assumptions: z.string().min(20),
  rates: z.strictObject({
    databaseHourly: z.number().nonnegative(), proxyVcpuHourly: z.number().nonnegative(), databaseVcpus: z.number().int().positive(),
    interfaceEndpointAzHourly: z.number().nonnegative(), azCount: z.number().int().min(2).max(3),
    cognito: z.number().nonnegative(), logging: z.number().nonnegative(), storage: z.number().nonnegative(), transfer: z.number().nonnegative(),
  }),
});
const accountAlias = z.enum(['patient-a', 'patient-b', 'clinician-a', 'clinician-b']);
const controlledAccountsSchema = z.array(z.strictObject({
  alias: accountAlias, email: z.email(), displayName: z.string().min(1).max(100), role: z.enum(['patient', 'clinician']),
})).length(4).refine((accounts) => new Set(accounts.map((account) => account.alias)).size === 4)
  .refine((accounts) => accounts.every((account) => account.role === (account.alias.startsWith('patient') ? 'patient' : 'clinician')));

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

export const parseAwsDemoInput = (raw: unknown, now = new Date()): AwsDemoInput => {
  const input = configSchema.parse(raw);
  const current = now.getTime(); const created = new Date(input.createdAt).getTime(); const expires = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(current) || Math.abs(current - created) > CONFIG_CLOCK_SKEW_MS) {
    throw new Error('Demo configuration createdAt must match the current execution time within five minutes.');
  }
  const maximumLifetime = Math.min(input.durationHours, 6) * 60 * 60_000;
  if (expires <= current || expires > current + maximumLifetime) {
    throw new Error('Demo maximum lifetime must end after the current time and within the configured duration or six hours.');
  }
  return input;
};

export const readAwsDemoInput = async (path: string, options: {
  now?: Date; requireCurrentCreation?: boolean; requireUnexpired?: boolean;
} = {}): Promise<AwsDemoInput> => {
  const raw = JSON.parse(await readPrivateFile(path));
  if (options.requireCurrentCreation ?? true) return parseAwsDemoInput(raw, options.now);
  const input = configSchema.parse(raw);
  if ((options.requireUnexpired ?? true) && new Date(input.expiresAt).getTime() <= (options.now ?? new Date()).getTime()) {
    throw new Error('Demo maximum lifetime has already expired; prepare a fresh configuration.');
  }
  return input;
};

export const makeAwsPreflightProbe = (input: AwsDemoInput, clients: AwsClients = clientsFor(input.region), runner: ProcessRunner = runProcess): PreflightProbe => ({
  async identity() { return z.string().regex(/^\d{12}$/).parse((await clients.sts.send(new GetCallerIdentityCommand({}))).Account); },
  async regionalCapabilities({ postgresVersion }) {
    const engine = await clients.rds.send(new DescribeDBEngineVersionsCommand({ Engine: 'postgres', EngineVersion: postgresVersion }));
    const options = await clients.rds.send(new DescribeOrderableDBInstanceOptionsCommand({ Engine: 'postgres', EngineVersion: postgresVersion, DBInstanceClass: 'db.t4g.small', Vpc: true }));
    await clients.rds.send(new DescribeDBProxiesCommand({ MaxRecords: 20 }));
    return { postgres: Boolean(engine.DBEngineVersions?.length), instanceClass: Boolean(options.OrderableDBInstanceOptions?.length), proxyApiReachable: true };
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
    const report = priceSchema.parse(JSON.parse(await readPrivateFile(input.priceReport)));
    if (report.region !== input.region) throw new Error('Price report region does not match the deployment.');
    const age = Date.now() - new Date(report.checkedAt).getTime();
    if (age < -5 * 60_000) throw new Error('Price report timestamp is meaningfully in the future.');
    if (age > 7 * 86_400_000) throw new Error('Price report is older than seven days.');
    return report.rates;
  },
});

const contextArgs = (input: AwsDemoInput, phase: 'bootstrap' | 'ready', frontendUrl?: string) => [
  '-c', `account=${input.account}`, '-c', `region=${input.region}`, '-c', `postgresVersion=${input.postgresVersion}`,
  '-c', `phase=${phase}`, '-c', `qualifier=${QUALIFIER}`, ...(input.sourceCommit ? ['-c', `sourceCommit=${input.sourceCommit}`] : []),
  ...(frontendUrl ? ['-c', `frontendUrl=${frontendUrl}`] : []),
  '-c', `expiresAt=${input.expiresAt}`,
];

export const makeAwsDemoDependencies = (input: AwsDemoInput, clients = clientsFor(input.region), runner: ProcessRunner = runProcess,
  manifestStore: { load?: () => Promise<DeploymentManifest | undefined>; save?: (manifest: DeploymentManifest) => Promise<void>;
    saveVerification?: (summary: Awaited<ReturnType<typeof verifyAws>>) => Promise<void>;
    correlation?: ReturnType<typeof cloudWatchCorrelationAdapter>; loadManualRegistration?: () => Promise<ManualRegistrationEvidence | undefined> } = {}): DemoDependencies => {
  const config: DemoConfig = { ...input, qualifier: QUALIFIER, toolkitStack: TOOLKIT_STACK, appStack: APP_STACK, deliveryStack: DELIVERY_STACK, projectTag: PROJECT_TAG };
  const credentials = new RuntimeCredentialStore(resolve('.runtime/credentials'));
  let activeManifest: DeploymentManifest | undefined;
  return {
    config,
    loadManifest: async () => {
      activeManifest = await (manifestStore.load ?? (async () => (await import('./lifecycle-types.js')).loadDeploymentManifest()))();
      return activeManifest;
    },
    saveManifest: async (manifest) => {
      activeManifest = manifest;
      await (manifestStore.save ?? (async (value) => (await import('./lifecycle-types.js')).saveDeploymentManifest(value)))(manifest);
    },
    preflight: async () => { await runPreflight(toPreflightInput(input), makeAwsPreflightProbe(input, clients, runner)); },
    inspectApplication: async () => inspectStackOwnership(clients.cloudformation, APP_STACK),
    inspectBootstrap: async () => inspectStackOwnership(clients.cloudformation, TOOLKIT_STACK),
    bootstrap: async () => {
      await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'bootstrap', `aws://${input.account}/${input.region}`,
        '--stack-name', TOOLKIT_STACK, '--qualifier', QUALIFIER, '--tags', `Project=${PROJECT_TAG}`]);
    },
    deploy: async (phase, frontendUrl) => {
      const outputPath = resolve('.runtime/cdk-outputs.json');
      await writePrivateJson(outputPath, {});
      try {
        await runner('pnpm', ['--filter', '@portal/infra', 'exec', 'cdk', 'deploy', APP_STACK, '--exclusively', '--require-approval', 'never',
          '--outputs-file', outputPath, '--parameters', `${APP_STACK}:DeploymentPhase=${phase}`, ...contextArgs(input, phase, frontendUrl)]);
      } catch (error) {
        const live = await inspectStackOwnership(clients.cloudformation, APP_STACK);
        if (live.exists && live.owned && live.phase) await persistRecovery(live.phase, live.outputs ?? {}, []);
        else await persistRecovery('bootstrap', {}, []);
        throw error;
      }
      const live = await inspectStackOwnership(clients.cloudformation, APP_STACK);
      if (!live.exists || !live.owned) {
        await persistRecovery('bootstrap', {}, []);
        throw new Error('Deployed application stack does not have established ownership.');
      }
      if (live.phase !== phase) {
        await persistRecovery('bootstrap', {}, []);
        throw new Error(`Live deployment phase does not match requested ${phase} phase.`);
      }
      await persistRecovery(live.phase, live.outputs ?? {}, []);
      const outputsFile = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(await readPrivateFile(outputPath)));
      const outputs = outputsFile[APP_STACK];
      if (!outputs) throw new Error('CDK outputs did not contain the application stack.');
      if (outputs.ExpiresAt !== input.expiresAt) throw new Error('Deployed expiry safeguard does not match the configured maximum lifetime.');
      await persistRecovery(live.phase, outputs, []);
      const application = await listStackResources(clients.cloudformation, APP_STACK, 'Application::');
      const toolkit = await listStackResources(clients.cloudformation, TOOLKIT_STACK, 'Bootstrap::');
      const delivery = await maybeListStackResources(clients.cloudformation, DELIVERY_STACK, 'Delivery::');
      activeManifest = {
        account: input.account, region: input.region, projectTag: PROJECT_TAG, appStack: APP_STACK,
        deliveryStack: DELIVERY_STACK, toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER, phase: live.phase, outputs,
        resources: deduplicateResources([...application, ...toolkit, ...delivery]),
        ...(input.sourceCommit ? { sourceCommit: input.sourceCommit } : {}), expiresAt: input.expiresAt,
        repository: input.repository, branch: input.branch,
      };
      return activeManifest;
    },
    migrate: async () => { await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'migrate' }, clients.lambda); },
    provision: async () => {
      const accounts = await readControlledAccounts(input.accountsFile);
      const users = await provisionUsers(requiredManifestOutput(activeManifest, 'UserPoolId'), accounts.map(({ email, displayName, role }) => ({ email, displayName, role })) as ControlledAccount[], { cognito: clients.cognito, credentials });
      await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'seed', users, now: new Date().toISOString() }, clients.lambda);
    },
    waitForProxy: async () => waitForProxy(clients.rds, requiredManifestOutput(activeManifest, 'ProxyName')),
    verifyMigration: async () => { await invokeMigration(requiredManifestOutput(activeManifest, 'MigrationFunctionName'), { action: 'migrate' }, clients.lambda); },
    probeApplication: async (manifest) => {
      const accounts = await readControlledAccounts(input.accountsFile);
      const patient = accounts.find((account) => account.alias === 'patient-a');
      if (!patient) throw new Error('Application database probe fixture is unavailable.');
      const credential = await credentials.get(requiredManifestOutput(manifest, 'UserPoolId'), patient.email);
      if (!credential?.sub) throw new Error('Application database probe fixture is unavailable.');
      await probeApplicationDatabase(requiredManifestOutput(manifest, 'ProfilesFunctionName'), credential.sub, clients.lambda);
    },
    publish: async (manifest) => publishBuiltFrontend(manifest, clients),
    verify: async (manifest) => {
      const frontendUrl = requiredManifestOutput(manifest, 'FrontendUrl');
      const fileEnvironment = await awsPlaywrightFileEnvironment(input, manifest, credentials);
      const environment = awsPlaywrightEnvironment(frontendUrl, fileEnvironment, process.env, {
        apiUrl: requiredManifestOutput(manifest, 'ApiUrl'), bucket: requiredManifestOutput(manifest, 'WebBucketName'), region: manifest.region,
        account: manifest.account, issuer: requiredManifestOutput(manifest, 'Issuer'), clientId: requiredManifestOutput(manifest, 'ClientId'),
        userPoolId: requiredManifestOutput(manifest, 'UserPoolId'), cognitoDomain: requiredManifestOutput(manifest, 'CognitoDomain'),
      });
      const correlation = manifestStore.correlation ?? cloudWatchCorrelationAdapter(clients.logs,
        ['profiles', 'availability', 'appointments'].map((name) => `/appointment-portal/${APP_STACK}/api/${name}`));
      const manualRegistration = await (manifestStore.loadManualRegistration ?? loadManualRegistration)();
      const summary = await verifyAws(manifest, { environment, adapter: playwrightVerificationAdapter(environment, runner), correlation, manualRegistration });
      await (manifestStore.saveVerification ?? ((value) => writePrivateJson(resolve('.runtime/verification.json'), value)))(summary);
      if (summary.checks.some((check) => check.status === 'failed' && check.name !== 'controlled-inbox registration and recovery')) {
        throw new Error('Deployed AWS verification failed.');
      }
    },
  };

  async function persistRecovery(phase: 'bootstrap' | 'ready', outputs: Record<string, string>, resources: ResourceRecord[]) {
    activeManifest = {
      account: input.account, region: input.region, projectTag: PROJECT_TAG, appStack: APP_STACK, deliveryStack: DELIVERY_STACK,
      toolkitStack: TOOLKIT_STACK, qualifier: QUALIFIER, phase, outputs, resources,
      ...(input.sourceCommit ? { sourceCommit: input.sourceCommit } : {}), expiresAt: input.expiresAt,
      repository: input.repository, branch: input.branch,
    };
    await (manifestStore.save ?? saveDeploymentManifest)(activeManifest);
  }
};

export async function probeApplicationDatabase(functionName: string, sub: string, lambda: Pick<LambdaClient, 'send'>): Promise<void> {
  const event = { version: '2.0', routeKey: 'GET /api/me', rawPath: '/api/me', rawQueryString: '', headers: {},
    requestContext: { requestId: 'deployment-application-probe', authorizer: { jwt: { claims: { sub: z.uuid().parse(sub) } } }, http: { method: 'GET' } } };
  const result = await lambda.send(new InvokeCommand({ FunctionName: z.string().regex(/^AppointmentPortal-profiles$/).parse(functionName),
    InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(event)) }));
  if (result.StatusCode !== 200 || result.FunctionError || !result.Payload) throw new Error('Application database probe failed.');
  try {
    const response = z.object({ statusCode: z.literal(200), body: z.string() }).parse(JSON.parse(Buffer.from(result.Payload).toString('utf8')));
    z.object({ id: z.uuid(), role: z.literal('patient') }).parse(JSON.parse(response.body));
  } catch { throw new Error('Application database probe failed.'); }
}

const inspectStackOwnership = async (client: CloudFormationClient, name: string): Promise<StackInspection> => {
  try {
    const stack = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    const tag = (key: string) => stack?.Tags?.find((item) => item.Key === key)?.Value;
    const phase = tag('DeploymentPhase') ?? stack?.Parameters?.find((parameter) => parameter.ParameterKey === 'DeploymentPhase')?.ParameterValue;
    const outputs = Object.fromEntries((stack?.Outputs ?? []).flatMap((output) => output.OutputKey && output.OutputValue ? [[output.OutputKey, output.OutputValue]] : []));
    return { exists: Boolean(stack), owned: tag('Project') === PROJECT_TAG,
      ...(phase === 'bootstrap' || phase === 'ready' ? { phase } : {}), ...(Object.keys(outputs).length ? { outputs } : {}),
      ...(tag('SourceCommit') ? { sourceCommit: tag('SourceCommit') } : {}), ...(stack?.StackStatus ? { status: stack.StackStatus } : {}) };
  } catch (error) {
    if (isValidationError(error)) return { exists: false, owned: false };
    throw error;
  }
};

export const listStackResources = async (client: Pick<CloudFormationClient, 'send'>, name: string, prefix: string): Promise<ResourceRecord[]> => {
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

const maybeListStackResources = async (client: Pick<CloudFormationClient, 'send'>, name: string, prefix: string): Promise<ResourceRecord[]> => {
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

const readControlledAccounts = async (path: string) => controlledAccountsSchema.parse(JSON.parse(await readPrivateFile(path)));

export const awsPlaywrightFileEnvironment = async (input: Pick<AwsDemoInput, 'accountsFile'>, manifest: DeploymentManifest,
  credentials = new RuntimeCredentialStore(resolve('.runtime/credentials'))): Promise<Record<string, string>> => {
  const accounts = await readControlledAccounts(input.accountsFile);
  const userPoolId = requiredManifestOutput(manifest, 'UserPoolId');
  return Object.fromEntries(accounts.map((account) => [
    `PORTAL_E2E_${account.alias.replace('-', '_').toUpperCase()}_FILE`, credentials.filePath(userPoolId, account.email),
  ]));
};

const PLAYWRIGHT_RUNTIME_ENVIRONMENT = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NODE_ENV'] as const;
const PLAYWRIGHT_CREDENTIAL_FILES = ['PORTAL_E2E_PATIENT_A_FILE', 'PORTAL_E2E_PATIENT_B_FILE',
  'PORTAL_E2E_CLINICIAN_A_FILE', 'PORTAL_E2E_CLINICIAN_B_FILE'] as const;
export const awsPlaywrightEnvironment = (frontendUrl: string, fileEnvironment: Record<string, string>, environment = process.env,
  deployed?: { apiUrl: string; bucket: string; region: string; account: string; issuer: string; clientId: string; userPoolId: string; cognitoDomain: string }): NodeJS.ProcessEnv => {
  const keys = Object.keys(fileEnvironment).sort();
  if (keys.length !== PLAYWRIGHT_CREDENTIAL_FILES.length || PLAYWRIGHT_CREDENTIAL_FILES.some((key) => !fileEnvironment[key]) ||
      keys.some((key) => !(PLAYWRIGHT_CREDENTIAL_FILES as readonly string[]).includes(key))) {
    throw new Error('AWS browser verification requires exactly four private credential files.');
  }
  const frontend = new URL(frontendUrl);
  if (frontend.protocol !== 'https:' || frontend.origin !== frontend.href.replace(/\/$/, '') || frontend.username || frontend.password) {
    throw new Error('AWS browser verification requires a deployed HTTPS frontend origin.');
  }
  if (deployed) {
    const api = new URL(deployed.apiUrl);
    if (api.protocol !== 'https:' || api.origin !== api.href.replace(/\/$/, '') || api.username || api.password ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(deployed.bucket) ||
        !/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/.test(deployed.region) || !/^\d{12}$/.test(deployed.account) || !deployed.clientId ||
        deployed.issuer !== `https://cognito-idp.${deployed.region}.amazonaws.com/${deployed.userPoolId}` ||
        !new RegExp(`^https://[a-z0-9-]+\\.auth\\.${deployed.region.replaceAll('-', '\\-')}\\.amazoncognito\\.com$`).test(deployed.cognitoDomain)) {
      throw new Error('AWS browser verification received invalid deployed coordinates.');
    }
  }
  return {
    ...Object.fromEntries(PLAYWRIGHT_RUNTIME_ENVIRONMENT.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]])),
    ...fileEnvironment, PORTAL_E2E_AWS: '1', PORTAL_E2E_AWS_URL: frontendUrl,
    ...(deployed ? { PORTAL_E2E_AWS_API_URL: deployed.apiUrl, PORTAL_E2E_AWS_BUCKET: deployed.bucket, PORTAL_E2E_AWS_REGION: deployed.region,
      PORTAL_E2E_AWS_ACCOUNT: deployed.account, PORTAL_E2E_AWS_ISSUER: deployed.issuer, PORTAL_E2E_AWS_CLIENT_ID: deployed.clientId,
      PORTAL_E2E_AWS_USER_POOL_ID: deployed.userPoolId, PORTAL_E2E_AWS_COGNITO_DOMAIN: deployed.cognitoDomain } : {}),
  };
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
          const prior = await clients.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: entry.key, ChecksumMode: ChecksumMode.ENABLED }));
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
const isNoSuchTagSet = (error: unknown) => typeof error === 'object' && error !== null && 'name' in error && error.name === 'NoSuchTagSet';

export class AwsInventoryAdapter implements InventoryAdapter {
  private resources?: ResourceRecord[];
  private readonly verifiedOwned = new Set<string>();
  constructor(readonly manifest: DeploymentManifest, readonly clients: AwsClients = clientsFor(manifest.region), readonly options: { forceDeleteSecrets?: boolean; archivePath?: string; sleep?: (milliseconds: number) => Promise<void> } = {}) {}

  async account() { return z.string().regex(/^\d{12}$/).parse((await this.clients.sts.send(new GetCallerIdentityCommand({}))).Account); }
  async page(cursor?: string): Promise<InventoryPage> {
    this.resources ??= await this.inventory();
    const start = cursor ? z.coerce.number().int().nonnegative().parse(cursor) : 0;
    const items = this.resources.slice(start, start + 100);
    return { items, ...(start + 100 < this.resources.length ? { nextCursor: String(start + 100) } : {}) };
  }
  async archive(manifest: DeploymentManifest) { await writePrivateJson(this.options.archivePath ?? resolve('.runtime/pre-destroy-inventory.json'), manifest); }
  async persist(manifest: DeploymentManifest) { await saveDeploymentManifest(manifest); }
  async deleteStack(name: string) {
    const stack = await inspectStackOwnership(this.clients.cloudformation, name);
    if (!stack.exists) return;
    if (!stack.owned) throw new Error(`Refusing to delete stack ${name} without established project ownership.`);
    await this.clients.cloudformation.send(new DeleteStackCommand({ StackName: name }));
    this.resources = undefined;
  }
  async waitStackDeleted(name: string) { const result = await waitUntilStackDeleteComplete({ client: this.clients.cloudformation, maxWaitTime: 1800 }, { StackName: name }); if (result.state !== 'SUCCESS') throw new Error(`Stack ${name} deletion did not complete.`); this.resources = undefined; }
  async stackStatus(name: string) {
    const stack = await inspectStackOwnership(this.clients.cloudformation, name);
    if (!stack.exists) return undefined;
    if (!stack.owned) throw new Error(`Refusing to inspect stack ${name} without established project ownership.`);
    return stack.status;
  }
  async deleteResource(resource: ResourceRecord) {
    const type = resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '');
    if (!resource.owned) throw new Error(`Refusing to delete unowned resource ${type}:${resource.id}.`);
    if (!this.verifiedOwned.has(this.resourceKey(resource))) throw new Error(`Refusing to delete ${type}:${resource.id} without verified ownership.`);
    if (type === 'AWS::RDS::DBSnapshot') await this.clients.rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: resource.id }));
    else if (type === 'AWS::RDS::DBInstanceAutomatedBackup') await this.clients.rds.send(new DeleteDBInstanceAutomatedBackupCommand({ DbiResourceId: resource.id }));
    else if (type === 'AWS::RDS::DBInstance') {
      await this.clients.rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: resource.id, SkipFinalSnapshot: true, DeleteAutomatedBackups: true }));
      await this.waitUntilMissing(async () => (await this.clients.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: resource.id }))).DBInstances?.length === 0);
    } else if (type === 'AWS::RDS::DBProxy') {
      await this.clients.rds.send(new DeleteDBProxyCommand({ DBProxyName: resource.id }));
      await this.waitUntilMissing(async () => (await this.clients.rds.send(new DescribeDBProxiesCommand({ DBProxyName: resource.id }))).DBProxies?.length === 0);
    }
    else if (type === 'AWS::SecretsManager::Secret') {
      if (!this.options.forceDeleteSecrets) throw new Error(`Secret ${resource.id} requires explicit immediate-cleanup mode.`);
      await this.clients.secrets.send(new DeleteSecretCommand({ SecretId: resource.arn ?? resource.id, ForceDeleteWithoutRecovery: true }));
    } else if (type === 'AWS::Logs::LogGroup') await this.clients.logs.send(new DeleteLogGroupCommand({ logGroupName: resource.id }));
    else if (type === 'AWS::EC2::VPCEndpoint') {
      const result = await this.clients.ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [resource.id] }));
      if (result.Unsuccessful?.length) throw new Error(`Delete failed for VPC endpoint ${resource.id}.`);
    }
    else if (type === 'AWS::ECR::Repository') await this.clients.ecr.send(new DeleteRepositoryCommand({ repositoryName: resource.id, force: true }));
    else if (type === 'AWS::SSM::Parameter') await this.clients.ssm.send(new DeleteParameterCommand({ Name: resource.id }));
    else if (type === 'AWS::IAM::OIDCProvider') throw new Error('Shared OIDC providers cannot be deleted by project cleanup.');
    else if (type === 'AWS::S3::ObjectVersion' || type === 'AWS::S3::DeleteMarker') {
      const parsed = z.strictObject({ bucket: z.string(), key: z.string(), versionId: z.string() }).parse(JSON.parse(resource.id));
      const result = await this.clients.s3.send(new DeleteObjectsCommand({ Bucket: parsed.bucket, Delete: { Objects: [{ Key: parsed.key, VersionId: parsed.versionId }], Quiet: true } }));
      if (result.Errors?.length) throw new Error(`Delete failed for S3 version in ${parsed.bucket}.`);
    } else if (type === 'AWS::S3::Bucket') await this.clients.s3.send(new DeleteBucketCommand({ Bucket: resource.id }));
    else throw new Error(`No safe explicit cleanup operation exists for ${resource.type}:${resource.id}.`);
    this.resources = undefined;
  }

  canDeleteResource(resource: ResourceRecord) {
    return new Set(['AWS::RDS::DBSnapshot', 'AWS::RDS::DBInstanceAutomatedBackup', 'AWS::RDS::DBInstance', 'AWS::RDS::DBProxy',
      'AWS::SecretsManager::Secret', 'AWS::Logs::LogGroup', 'AWS::EC2::VPCEndpoint', 'AWS::ECR::Repository', 'AWS::SSM::Parameter',
      'AWS::S3::ObjectVersion', 'AWS::S3::DeleteMarker', 'AWS::S3::Bucket'])
      .has(resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, ''));
  }

  private async waitUntilMissing(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if (await check()) return; }
      catch (error) { if (isNotFound(error)) return; throw error; }
      await (this.options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))))(5_000);
    }
    throw new Error('Owned resource did not reach a deleted state.');
  }

  private resourceKey(resource: Pick<ResourceRecord, 'type' | 'id' | 'arn'>) {
    return `${resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '')}\0${resource.arn ?? resource.id}`;
  }

  private async inventory(): Promise<ResourceRecord[]> {
    const normalizedType = (type: string) => type.replace(/^(?:Application|Bootstrap|Delivery)::/, '');
    const identityKeys = (type: string, id: string, arn?: string) => [id, ...(arn ? [arn] : [])].map((value) => `${normalizedType(type)}\0${value}`);
    const knownOwned = new Set<string>();
    const claimedOwned = new Set(this.manifest.resources.filter((item) => item.owned).flatMap((item) => identityKeys(item.type, item.id, item.arn)));
    const knownShared = new Set(this.manifest.resources.filter((item) => !item.owned).flatMap((item) => identityKeys(item.type, item.id, item.arn)));
    const hasProjectTag = (tags?: readonly { Key?: string; Value?: string }[]) => tags?.some((tag) => tag.Key === 'Project' && tag.Value === PROJECT_TAG) ?? false;
    const ownership = (type: string, id: string, arn?: string, tags?: readonly { Key?: string; Value?: string }[]) => {
      const keys = identityKeys(type, id, arn);
      if (keys.some((key) => knownShared.has(key))) return false;
      return keys.some((key) => knownOwned.has(key)) || hasProjectTag(tags);
    };
    const explicitlyShared = (type: string, id: string, arn?: string) => identityKeys(type, id, arn).some((key) => knownShared.has(key));
    const discovered = (type: string, id: string, arn: string | undefined, tags: readonly { Key?: string; Value?: string }[] | undefined,
      outputMatch = false): ResourceRecord | undefined => {
      const keys = identityKeys(type, id, arn);
      const owned = ownership(type, id, arn, tags);
      if (owned) return { type: `Application::${type}`, id, arn, owned: true };
      if (outputMatch || keys.some((key) => claimedOwned.has(key))) return { type: `Application::${type}`, id, arn, owned: false, state: 'unverified' };
      if (explicitlyShared(type, id, arn)) return { type, id, arn, owned: false };
      return undefined;
    };
    const resources: ResourceRecord[] = [];
    const tagVerifiedBuckets = new Set<string>();
    const stackNames: string[] = [this.manifest.appStack, ...(this.manifest.deliveryStack ? [this.manifest.deliveryStack] : []), this.manifest.toolkitStack];
    for (const name of stackNames) {
      const prefix = name === this.manifest.appStack ? 'Application::' : name === this.manifest.deliveryStack ? 'Delivery::' : 'Bootstrap::';
      const stack = await inspectStackOwnership(this.clients.cloudformation, name);
      if (stack.exists && !stack.owned) { resources.push({ type: `${prefix}AWS::CloudFormation::Stack`, id: name, owned: false }); continue; }
      if (stack.owned) {
        const members = await listStackResources(this.clients.cloudformation, name, prefix);
        resources.push(...members);
        for (const member of members) for (const key of identityKeys(member.type, member.id, member.arn)) knownOwned.add(key);
      }
    }
    let Marker: string | undefined;
    do {
      const page = await this.clients.rds.send(new DescribeDBSnapshotsCommand({ Marker }));
      for (const snapshot of page.DBSnapshots ?? []) if (snapshot.DBSnapshotIdentifier) {
        const record = discovered('AWS::RDS::DBSnapshot', snapshot.DBSnapshotIdentifier, snapshot.DBSnapshotArn, snapshot.TagList,
          snapshot.DBInstanceIdentifier === this.manifest.outputs.DatabaseId);
        if (record) resources.push(record);
      }
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBInstancesCommandOutput = await this.clients.rds.send(new DescribeDBInstancesCommand({ Marker }));
      for (const database of page.DBInstances ?? []) if (database.DBInstanceIdentifier) {
        const record = discovered('AWS::RDS::DBInstance', database.DBInstanceIdentifier, database.DBInstanceArn, database.TagList,
          database.DBInstanceIdentifier === this.manifest.outputs.DatabaseId);
        if (record) resources.push(record);
      }
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBProxiesCommandOutput = await this.clients.rds.send(new DescribeDBProxiesCommand({ Marker }));
      for (const proxy of page.DBProxies ?? []) if (proxy.DBProxyName) {
        if (!proxy.DBProxyName.startsWith('appointment-portal-') && proxy.DBProxyName !== this.manifest.outputs.ProxyName &&
          !explicitlyShared('AWS::RDS::DBProxy', proxy.DBProxyName, proxy.DBProxyArn)) continue;
        const tags = proxy.DBProxyArn ? (await this.clients.rds.send(new RdsListTagsForResourceCommand({ ResourceName: proxy.DBProxyArn }))).TagList : undefined;
        const record = discovered('AWS::RDS::DBProxy', proxy.DBProxyName, proxy.DBProxyArn, tags,
          proxy.DBProxyName === this.manifest.outputs.ProxyName);
        if (record) resources.push(record);
      }
      Marker = page.Marker;
    } while (Marker);
    Marker = undefined;
    do {
      const page: DescribeDBInstanceAutomatedBackupsCommandOutput = await this.clients.rds.send(new DescribeDBInstanceAutomatedBackupsCommand({ Marker }));
      for (const backup of page.DBInstanceAutomatedBackups ?? []) if (backup.DbiResourceId) {
        if (!backup.DBInstanceIdentifier?.startsWith('appointmentportal-') && backup.DBInstanceIdentifier !== this.manifest.outputs.DatabaseId &&
          !explicitlyShared('AWS::RDS::DBInstanceAutomatedBackup', backup.DbiResourceId, backup.DBInstanceAutomatedBackupsArn)) continue;
        const tags = backup.DBInstanceAutomatedBackupsArn ? (await this.clients.rds.send(new RdsListTagsForResourceCommand({ ResourceName: backup.DBInstanceAutomatedBackupsArn }))).TagList : undefined;
        const record = discovered('AWS::RDS::DBInstanceAutomatedBackup', backup.DbiResourceId, backup.DBInstanceAutomatedBackupsArn, tags,
          backup.DBInstanceIdentifier === this.manifest.outputs.DatabaseId);
        if (record) resources.push(record);
      }
      Marker = page.Marker;
    } while (Marker);
    let secretToken: string | undefined;
    do {
      const page = await this.clients.secrets.send(new ListSecretsCommand({ NextToken: secretToken, IncludePlannedDeletion: true }));
      for (const secret of page.SecretList ?? []) if (secret.Name && secret.ARN) {
        const record = discovered('AWS::SecretsManager::Secret', secret.Name, secret.ARN, secret.Tags,
          secret.ARN === this.manifest.outputs.AdminSecretArn || secret.ARN === this.manifest.outputs.ApplicationSecretArn);
        if (record) resources.push({ ...record, ...(secret.DeletedDate && record.owned ? { state: 'scheduled' as const } : {}) });
      }
      secretToken = page.NextToken;
    } while (secretToken);
    for (const logGroupNamePrefix of ['/appointment-portal/', '/aws/rds/proxy/appointment-portal-']) {
      let logToken: string | undefined;
      do {
        const page = await this.clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix, nextToken: logToken }));
        for (const group of page.logGroups ?? []) if (group.logGroupName && group.logGroupArn) {
          const tagResponse = await this.clients.logs.send(new LogsListTagsForResourceCommand({ resourceArn: group.logGroupArn }));
          const tags = Object.entries(tagResponse.tags ?? {}).map(([Key, Value]) => ({ Key, Value }));
          const record = discovered('AWS::Logs::LogGroup', group.logGroupName, group.logGroupArn, tags);
          if (record) resources.push(record);
        }
        logToken = page.nextToken;
      } while (logToken);
    }
    let bucketToken: string | undefined;
    do {
      const page = await this.clients.s3.send(new ListBucketsCommand({ ContinuationToken: bucketToken, BucketRegion: this.manifest.region }));
      for (const bucket of page.Buckets ?? []) if (bucket.Name) {
        if (!bucket.Name.startsWith('appointmentportal-') && bucket.Name !== `cdk-${this.manifest.qualifier}-assets-${this.manifest.account}-${this.manifest.region}`) continue;
        let tags: { Key?: string; Value?: string }[] | undefined;
        try { tags = (await this.clients.s3.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }))).TagSet; }
        catch (error) { if (!isNoSuchTagSet(error) && !isNotFound(error)) throw error; }
        if (hasProjectTag(tags)) tagVerifiedBuckets.add(bucket.Name);
        const record = discovered('AWS::S3::Bucket', bucket.Name, undefined, tags);
        if (record) resources.push({ ...record,
          type: bucket.Name.startsWith(`cdk-${this.manifest.qualifier}-`) ? 'Bootstrap::AWS::S3::Bucket' : record.type });
      }
      bucketToken = page.ContinuationToken;
    } while (bucketToken);
    const knownBuckets = new Map(resources.filter((item) => item.type.endsWith('AWS::S3::Bucket') && item.owned && tagVerifiedBuckets.has(item.id))
      .map((item) => [item.id, item.type.startsWith('Bootstrap::') ? 'Bootstrap::' : item.type.startsWith('Delivery::') ? 'Delivery::' : 'Application::']));
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
      for (const endpoint of page.VpcEndpoints ?? []) if (endpoint.VpcEndpointId) {
        const record = discovered('AWS::EC2::VPCEndpoint', endpoint.VpcEndpointId, undefined, endpoint.Tags,
          endpoint.VpcId === this.manifest.outputs.VpcId);
        if (record) resources.push(record);
      }
      ec2Token = page.NextToken;
    } while (ec2Token);
    ec2Token = undefined;
    do {
      const page: DescribeNetworkInterfacesCommandOutput = await this.clients.ec2.send(new DescribeNetworkInterfacesCommand({ NextToken: ec2Token, Filters: [{ Name: 'vpc-id', Values: [this.manifest.outputs.VpcId ?? 'vpc-none'] }] }));
      for (const networkInterface of page.NetworkInterfaces ?? []) if (networkInterface.NetworkInterfaceId) {
        const owned = ownership('AWS::EC2::NetworkInterface', networkInterface.NetworkInterfaceId, undefined, networkInterface.TagSet);
        resources.push({ type: 'Application::AWS::EC2::NetworkInterface', id: networkInterface.NetworkInterfaceId, owned,
          ...(!owned ? { state: 'unverified' as const } : {}) });
      }
      ec2Token = page.NextToken;
    } while (ec2Token);
    let ecrToken: string | undefined;
    const knownRepositories = new Set(resources.filter((item) => item.type.endsWith('AWS::ECR::Repository') && item.owned).map((item) => item.id));
    do {
      const page = await this.clients.ecr.send(new DescribeRepositoriesCommand({ nextToken: ecrToken }));
      for (const repository of page.repositories ?? []) if (repository.repositoryName && repository.repositoryArn) {
        if (repository.repositoryName !== `cdk-${this.manifest.qualifier}-container-assets-${this.manifest.account}-${this.manifest.region}`) continue;
        const tags = (await this.clients.ecr.send(new EcrListTagsForResourceCommand({ resourceArn: repository.repositoryArn }))).tags;
        const owned = knownRepositories.has(repository.repositoryName) || ownership('AWS::ECR::Repository', repository.repositoryName, repository.repositoryArn, tags);
        if (owned) resources.push({ type: 'Bootstrap::AWS::ECR::Repository', id: repository.repositoryName, arn: repository.repositoryArn, owned: true });
      }
      ecrToken = page.nextToken;
    } while (ecrToken);
    let parameterToken: string | undefined;
    do {
      const page = await this.clients.ssm.send(new DescribeParametersCommand({ NextToken: parameterToken }));
      for (const parameter of page.Parameters ?? []) if (parameter.Name) {
        if (!parameter.Name.startsWith(`/cdk-bootstrap/${this.manifest.qualifier}/`)) continue;
        const tagResponse = await this.clients.ssm.send(new SsmListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: parameter.Name }));
        if (ownership('AWS::SSM::Parameter', parameter.Name, undefined, tagResponse.TagList)) resources.push({ type: 'Bootstrap::AWS::SSM::Parameter', id: parameter.Name, owned: true });
      }
      parameterToken = page.NextToken;
    } while (parameterToken);
    for (const provider of (await this.clients.iam.send(new ListOpenIDConnectProvidersCommand({}))).OpenIDConnectProviderList ?? []) {
      if (!provider.Arn) continue;
      const details = await this.clients.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: provider.Arn }));
      if (details.Url === 'token.actions.githubusercontent.com') {
        const claimed = identityKeys('AWS::IAM::OIDCProvider', details.Url, provider.Arn).some((key) => claimedOwned.has(key));
        resources.push({ type: 'AWS::IAM::OIDCProvider', id: details.Url, arn: provider.Arn, owned: false,
          ...(claimed ? { state: 'unverified' as const } : {}) });
      }
    }
    const result = deduplicateResources(resources);
    for (const resource of result) if (resource.owned) this.verifiedOwned.add(this.resourceKey(resource));
    return result;
  }
}
