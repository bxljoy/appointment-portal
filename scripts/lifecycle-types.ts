import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

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
  state: z.enum(['active', 'scheduled']).optional(),
});
const publicOutputNames = new Set([
  'FrontendUrl', 'ApiUrl', 'DistributionId', 'WebBucketName', 'UserPoolId', 'ClientId', 'Issuer',
  'CognitoDomain', 'ProxyName', 'DatabaseId', 'MigrationFunctionName', 'VpcId', 'AdminSecretArn',
  'ApplicationSecretArn',
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
  deleteResource(resource: ResourceRecord): Promise<void>;
  archive(manifest: DeploymentManifest): Promise<void>;
};

export const parseDeploymentManifest = (input: unknown): DeploymentManifest => manifestSchema.parse(input);

export const loadDeploymentManifest = async (path = DEPLOYMENT_PATH): Promise<DeploymentManifest | undefined> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > 4_000_000) throw new Error('Unsafe deployment manifest.');
    return parseDeploymentManifest(JSON.parse(await handle.readFile('utf8')));
  }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new Error('Deployment manifest is missing or invalid.', { cause: error });
  } finally { await handle?.close(); }
};

export const saveDeploymentManifest = async (input: DeploymentManifest, path = DEPLOYMENT_PATH): Promise<void> => {
  const manifest = parseDeploymentManifest(input);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || dirInfo.uid !== process.getuid?.()) throw new Error('Unsafe runtime directory.');
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
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
  const byIdentity = new Map<string, ResourceRecord>();
  for (const resource of resources) {
    const key = `${resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '')}\0${resource.arn ?? resource.id}`;
    const prior = byIdentity.get(key);
    if (prior && prior.owned !== resource.owned) throw new Error(`Conflicting ownership for ${resource.type}:${resource.id}.`);
    byIdentity.set(key, resource);
  }
  return [...byIdentity.values()];
};

const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
