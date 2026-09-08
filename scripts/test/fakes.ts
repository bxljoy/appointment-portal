import type {
  DeploymentManifest,
  InventoryAdapter,
  InventoryPage,
  ResourceRecord,
} from '../lifecycle-types.js';
import type { AwsClients } from '../aws-lifecycle.js';

export const manifest: DeploymentManifest = {
  account: '111111111111',
  region: 'eu-north-1',
  projectTag: 'appointment-portal',
  appStack: 'AppointmentPortal',
  deliveryStack: 'AppointmentPortalDelivery',
  toolkitStack: 'AppointmentPortalToolkit',
  qualifier: 'apptdemo',
  sourceCommit: 'a'.repeat(40),
  repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main',
  expiresAt: '2030-06-01T01:00:00.000Z',
  phase: 'ready',
  outputs: { FrontendUrl: 'https://demo.cloudfront.net', DistributionId: 'EDISTFIXTURE',
    Issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_fixture', UserPoolId: 'eu-north-1_fixture',
    ClientId: 'fixtureclient', CognitoDomain: 'https://appointment-portal.auth.eu-north-1.amazoncognito.com',
    ProfilesFunctionName: 'AppointmentPortal-profiles', ExpiresAt: '2030-06-01T01:00:00.000Z',
    SafeguardScheduleName: 'appointment-portal-expiry' },
  resources: [],
};

type InventoryFixture = Record<string, ResourceRecord[]>;

export const fakeInventory = (fixture: InventoryFixture, pageSize = 1): InventoryAdapter & {
  deleted: string[];
  archived: DeploymentManifest[];
  persisted: DeploymentManifest[];
  stackDeletes: string[];
  events: string[];
} => {
  const resources = Object.values(fixture).flat();
  const deleted: string[] = [];
  const archived: DeploymentManifest[] = [];
  const persisted: DeploymentManifest[] = [];
  const stackDeletes: string[] = [];
  const events: string[] = [];
  return {
    deleted, archived, persisted, stackDeletes, events,
    async account() { return manifest.account; },
    async page(cursor): Promise<InventoryPage> {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = resources.slice(start, start + pageSize);
      const nextCursor = start + pageSize < resources.length ? String(start + pageSize) : undefined;
      return { items, nextCursor };
    },
    async deleteStack(name) { events.push(`delete-stack:${name}`); stackDeletes.push(name); },
    async waitStackDeleted(name) { events.push(`wait-stack:${name}`); },
    async stackStatus() { return 'DELETE_FAILED'; },
    async deleteResource(resource) { events.push(`delete-resource:${resource.type}:${resource.id}`); deleted.push(`${resource.type}:${resource.id}`); },
    async archive(input) { events.push('archive'); archived.push(structuredClone(input)); },
    async persist(input) { events.push('persist'); persisted.push(structuredClone(input)); },
  };
};

export const fakeAwsClients = (pages: Record<string, unknown[]> = {}): AwsClients & { commands: object[] } => {
  const positions = new Map<string, number>();
  const commands: object[] = [];
  const send = async (command: object) => {
    commands.push(command);
    const name = command.constructor.name;
    const candidates = pages[name];
    if (candidates) {
      const position = positions.get(name) ?? 0;
      positions.set(name, position + 1);
      return candidates[position] ?? candidates.at(-1) ?? {};
    }
    if (name === 'ListStackResourcesCommand') throw Object.assign(new Error('stack absent'), { name: 'ValidationError' });
    if (name === 'GetParameterCommand') throw Object.assign(new Error('parameter absent'), { name: 'ParameterNotFound' });
    const defaults: Record<string, unknown> = {
      DescribeDBSnapshotsCommand: { DBSnapshots: [] }, DescribeDBInstancesCommand: { DBInstances: [] },
      DescribeDBProxiesCommand: { DBProxies: [] }, DescribeDBInstanceAutomatedBackupsCommand: { DBInstanceAutomatedBackups: [] },
      ListSecretsCommand: { SecretList: [] }, DescribeLogGroupsCommand: { logGroups: [] },
      DescribeVpcEndpointsCommand: { VpcEndpoints: [] }, DescribeNetworkInterfacesCommand: { NetworkInterfaces: [] },
      DescribeRepositoriesCommand: { repositories: [] }, ListOpenIDConnectProvidersCommand: { OpenIDConnectProviderList: [] },
      GetCallerIdentityCommand: { Account: manifest.account },
    };
    return defaults[name] ?? {};
  };
  const client = { send };
  return {
    cloudformation: client, cloudfront: client, ec2: client, ecr: client, iam: client, lambda: client,
    rds: client, s3: client, secrets: client, ssm: client, sts: client, logs: client, cognito: client,
    commands,
  } as unknown as AwsClients & { commands: object[] };
};
