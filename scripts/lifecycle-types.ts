import { resolve } from 'node:path';
import { z } from 'zod';
import { readPrivateFile, writePrivateJson } from './private-file.js';

export const PROJECT_TAG = 'appointment-portal';
export const APP_STACK = 'AppointmentPortal';
export const DELIVERY_STACK = 'AppointmentPortalDelivery';
export const TOOLKIT_STACK = 'AppointmentPortalToolkit';
export const QUALIFIER = 'apptdemo';
export const DEPLOYMENT_PATH = resolve('.runtime/deployment.json');

const resourceSchema = z.strictObject({
  type: z.string().min(1).max(160),
  id: z.string().min(1).max(2048),
  arn: z.string().min(1).max(2048).optional(),
  owned: z.boolean(),
  state: z.enum(['active', 'scheduled', 'unverified']).optional(),
});
const publicOutputNames = new Set([
  'FrontendUrl', 'ApiUrl', 'DistributionId', 'WebBucketName', 'UserPoolId', 'ClientId', 'Issuer',
  'CognitoDomain', 'ProxyName', 'DatabaseId', 'MigrationFunctionName', 'VpcId', 'AdminSecretArn',
  'ApplicationSecretArn',
  'ProfilesFunctionName', 'ExpiresAt', 'SafeguardScheduleName',
]);
const outputsSchema = z.record(z.string(), z.string().max(4096)).refine(
  (outputs) => Object.keys(outputs).every((name) => publicOutputNames.has(name) && !/(?:password|token|secretvalue|accesskey)/i.test(name)),
  'Manifest outputs must be from the credential-free application allowlist.',
);

export type ResourceRecord = z.infer<typeof resourceSchema>;

const manifestSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  projectTag: z.literal(PROJECT_TAG),
  appStack: z.literal(APP_STACK),
  deliveryStack: z.literal(DELIVERY_STACK).optional(),
  toolkitStack: z.literal(TOOLKIT_STACK),
  qualifier: z.literal(QUALIFIER),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
  repositoryOwnerId: z.string().regex(/^[1-9]\d{0,19}$/).optional(),
  repositoryId: z.string().regex(/^[1-9]\d{0,19}$/).optional(),
  branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).optional(),
  expiresAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith('Z')).optional(),
  phase: z.enum(['bootstrap', 'ready']),
  outputs: outputsSchema,
  resources: z.array(resourceSchema).max(10_000),
});

export type DeploymentManifest = z.infer<typeof manifestSchema>;
export type InventoryPage = { items: ResourceRecord[]; nextCursor?: string };
export type InventoryAdapter = {
  account(): Promise<string>;
  page(cursor?: string): Promise<InventoryPage>;
  deleteStack(name: string): Promise<void>;
  waitStackDeleted(name: string): Promise<void>;
  stackStatus(name: string): Promise<string | undefined>;
  deleteResource(resource: ResourceRecord): Promise<void>;
  archive(manifest: DeploymentManifest): Promise<void>;
  persist(manifest: DeploymentManifest): Promise<void>;
  canDeleteResource?(resource: ResourceRecord): boolean;
};

export const parseDeploymentManifest = (input: unknown): DeploymentManifest => manifestSchema.parse(input);

export const loadDeploymentManifest = async (path = DEPLOYMENT_PATH): Promise<DeploymentManifest | undefined> => {
  try {
    return parseDeploymentManifest(JSON.parse(await readPrivateFile(path, 4_000_000)));
  }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new Error('Deployment manifest is missing or invalid.', { cause: error });
  }
};

export const saveDeploymentManifest = async (input: DeploymentManifest, path = DEPLOYMENT_PATH): Promise<void> => {
  const manifest = parseDeploymentManifest(input);
  await writePrivateJson(path, manifest);
};

export const collectInventory = async (inventory: Pick<InventoryAdapter, 'page'>): Promise<ResourceRecord[]> => {
  const result: ResourceRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined && seen.has(cursor)) throw new Error('Inventory pagination cursor repeated.');
    if (cursor !== undefined) seen.add(cursor);
    const page = await inventory.page(cursor);
    result.push(...page.items.map((item) => resourceSchema.parse(item)));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return deduplicateResources(result);
};

export const deduplicateResources = (resources: ResourceRecord[]): ResourceRecord[] => {
  type Group = { resource: ResourceRecord; aliases: Set<string> };
  const groups = new Set<Group>();
  const byAlias = new Map<string, Group>();
  const normalizedType = (type: string) => type.replace(/^(?:Application|Bootstrap|Delivery)::/, '');
  const aliases = (resource: ResourceRecord) => [resource.id, ...(resource.arn ? [resource.arn] : [])]
    .map((value) => `${normalizedType(resource.type)}\0${value}`);
  const merge = (left: ResourceRecord, right: ResourceRecord): ResourceRecord => {
    if (left.arn && right.arn && left.arn !== right.arn) throw new Error(`Conflicting ARN for ${left.type}:${left.id}.`);
    const state = left.state === 'unverified' || right.state === 'unverified' ? 'unverified' as const :
      left.state === 'scheduled' || right.state === 'scheduled' ? 'scheduled' as const : undefined;
    const scopedType = /^(?:Application|Bootstrap|Delivery)::/.test(left.type) ? left.type : right.type;
    const arn = left.arn ?? right.arn;
    return { type: scopedType, id: left.id, ...(arn ? { arn } : {}),
      owned: left.owned && right.owned, ...(state ? { state } : {}) };
  };
  for (const resource of resources) {
    const keys = aliases(resource);
    const matches = [...new Set(keys.flatMap((key) => byAlias.get(key) ? [byAlias.get(key)!] : []))];
    if (matches.length === 0) {
      const group = { resource, aliases: new Set(keys) };
      groups.add(group);
      for (const alias of keys) byAlias.set(alias, group);
      continue;
    }
    const group = matches.shift()!;
    for (const match of matches) {
      group.resource = merge(group.resource, match.resource);
      for (const alias of match.aliases) { group.aliases.add(alias); byAlias.set(alias, group); }
      groups.delete(match);
    }
    group.resource = merge(group.resource, resource);
    for (const alias of keys) { group.aliases.add(alias); byAlias.set(alias, group); }
  }
  return [...groups].map((group) => group.resource);
};

const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
