import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInventory, deduplicateResources, loadDeploymentManifest, type DeploymentManifest, type InventoryAdapter, type ResourceRecord } from './lifecycle-types.js';

export type CleanupResult = { targets: ResourceRecord[]; deleted: ResourceRecord[]; scheduled: ResourceRecord[]; shared: ResourceRecord[]; unverified: ResourceRecord[] };

export const cleanup = async (manifest: DeploymentManifest, inventory: InventoryAdapter, options: { dryRun?: boolean; includeInfrastructure?: boolean } = {}): Promise<CleanupResult> => {
  const account = await inventory.account();
  if (account !== manifest.account) throw new Error(`AWS account mismatch: expected ${manifest.account}.`);
  const live = await collectInventory(inventory);
  const resources = deduplicateResources([...manifest.resources, ...live]);
  const inScope = (resource: ResourceRecord) => options.includeInfrastructure || !/^(?:Bootstrap|Delivery)::/.test(resource.type);
  const targets = resources.filter((resource) => resource.owned && resource.state !== 'scheduled' && inScope(resource));
  const scheduled = resources.filter((resource) => resource.owned && resource.state === 'scheduled');
  const shared = resources.filter((resource) => !resource.owned && resource.state !== 'unverified');
  const unverified = resources.filter((resource) => resource.state === 'unverified');
  if (options.dryRun) return { targets, deleted: [], scheduled, shared, unverified };

  // Preserve the last application inventory outside the roles that will be removed.
  const refreshed = { ...manifest, resources };
  await inventory.archive(refreshed);
  await inventory.persist(refreshed);
  await deleteStackWithRecovery(manifest.appStack, inventory, (resource) => !/^(?:Bootstrap|Delivery)::/.test(resource.type));
  const residual = ordered((await collectInventory(inventory)).filter((resource) => resource.owned && resource.state !== 'scheduled' && !/^(?:Bootstrap|Delivery)::/.test(resource.type)));
  const deleted: ResourceRecord[] = [];
  for (const resource of residual) {
    // Stack deletion owns CloudFormation resources; explicit deletion is for retained,
    // partially-created or service-discovered residuals.
    await inventory.deleteResource(resource);
    deleted.push(resource);
  }
  if (options.includeInfrastructure) {
    if (manifest.deliveryStack) {
      await deleteStackWithRecovery(manifest.deliveryStack, inventory, (resource) => resource.type.startsWith('Delivery::'));
    }
    await deleteStackWithRecovery(manifest.toolkitStack, inventory, (resource) => resource.type.startsWith('Bootstrap::'));
    const infrastructureResidual = ordered((await collectInventory(inventory)).filter((resource) => resource.owned && resource.state !== 'scheduled'));
    for (const resource of infrastructureResidual) {
      await inventory.deleteResource(resource);
      deleted.push(resource);
    }
  }
  return { targets, deleted, scheduled, shared, unverified };
};

const deleteStackWithRecovery = async (name: string, inventory: InventoryAdapter, inScope: (resource: ResourceRecord) => boolean): Promise<void> => {
  await inventory.deleteStack(name);
  try { await inventory.waitStackDeleted(name); return; }
  catch (error) {
    const status = await inventory.stackStatus(name);
    if (status !== 'DELETE_FAILED') throw error;
    const blockers = ordered((await collectInventory(inventory)).filter((resource) => resource.owned && resource.state !== 'scheduled' && inScope(resource) &&
      (inventory.canDeleteResource?.(resource) ?? true)));
    for (const blocker of blockers) await inventory.deleteResource(blocker);
    await inventory.deleteStack(name);
    await inventory.waitStackDeleted(name);
  }
};

const ordered = (resources: ResourceRecord[]) => [...resources].sort((left, right) => deletionPriority(left) - deletionPriority(right));
const deletionPriority = (resource: ResourceRecord): number => {
  const type = resource.type.replace(/^(?:Application|Bootstrap|Delivery)::/, '');
  if (type === 'AWS::S3::ObjectVersion' || type === 'AWS::S3::DeleteMarker') return 0;
  if (type === 'AWS::RDS::DBProxy') return 10;
  if (type === 'AWS::RDS::DBInstance') return 20;
  if (type === 'AWS::S3::Bucket') return 100;
  if (type === 'AWS::IAM::OIDCProvider') return 110;
  return 50;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await loadDeploymentManifest();
    if (!manifest) throw new Error('No deployment manifest exists.');
    const { AwsInventoryAdapter } = await import('./aws-lifecycle.js');
    const dryRun = process.argv.includes('--dry-run');
    const includeInfrastructure = process.argv.includes('--all');
    const result = await cleanup(manifest, new AwsInventoryAdapter(manifest, undefined, { forceDeleteSecrets: process.argv.includes('--force-disposable-secrets') }), { dryRun, includeInfrastructure });
    process.stdout.write(`${JSON.stringify({ targets: result.targets.map(({ type, id }) => ({ type, id })), scheduled: result.scheduled,
      shared: result.shared, unverified: result.unverified }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cleanup failed.'}\n`);
    process.exitCode = 1;
  }
}
