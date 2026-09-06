import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInventory, deduplicateResources, loadDeploymentManifest, type DeploymentManifest, type InventoryAdapter, type ResourceRecord } from './lifecycle-types.js';

export type CleanupResult = { targets: ResourceRecord[]; deleted: ResourceRecord[]; scheduled: ResourceRecord[]; shared: ResourceRecord[] };

export const cleanup = async (manifest: DeploymentManifest, inventory: InventoryAdapter, options: { dryRun?: boolean; includeInfrastructure?: boolean } = {}): Promise<CleanupResult> => {
  const account = await inventory.account();
  if (account !== manifest.account) throw new Error(`AWS account mismatch: expected ${manifest.account}.`);
  const live = await collectInventory(inventory);
  const resources = deduplicateResources([...manifest.resources, ...live]);
  const inScope = (resource: ResourceRecord) => options.includeInfrastructure || !/^(?:Bootstrap|Delivery)::/.test(resource.type);
  const targets = resources.filter((resource) => resource.owned && resource.state !== 'scheduled' && inScope(resource));
  const scheduled = resources.filter((resource) => resource.owned && resource.state === 'scheduled');
  const shared = resources.filter((resource) => !resource.owned);
  if (options.dryRun) return { targets, deleted: [], scheduled, shared };

  // Preserve the last application inventory outside the roles that will be removed.
  await inventory.archive({ ...manifest, resources });
  await inventory.deleteStack(manifest.appStack);
  await inventory.waitStackDeleted(manifest.appStack);
  const residual = (await collectInventory(inventory)).filter((resource) => resource.owned && resource.state !== 'scheduled' && !/^(?:Bootstrap|Delivery)::/.test(resource.type));
  const deleted: ResourceRecord[] = [];
  for (const resource of residual) {
    // Stack deletion owns CloudFormation resources; explicit deletion is for retained,
    // partially-created or service-discovered residuals.
    await inventory.deleteResource(resource);
    deleted.push(resource);
  }
  if (options.includeInfrastructure) {
    if (manifest.deliveryStack) {
      await inventory.deleteStack(manifest.deliveryStack);
      await inventory.waitStackDeleted(manifest.deliveryStack);
    }
    await inventory.deleteStack(manifest.toolkitStack);
    await inventory.waitStackDeleted(manifest.toolkitStack);
    const infrastructureResidual = (await collectInventory(inventory)).filter((resource) => resource.owned && resource.state !== 'scheduled');
    for (const resource of infrastructureResidual) {
      await inventory.deleteResource(resource);
      deleted.push(resource);
    }
  }
  return { targets, deleted, scheduled, shared };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await loadDeploymentManifest();
    if (!manifest) throw new Error('No deployment manifest exists.');
    const { AwsInventoryAdapter } = await import('./aws-lifecycle.js');
    const dryRun = process.argv.includes('--dry-run');
    const includeInfrastructure = process.argv.includes('--all');
    const result = await cleanup(manifest, new AwsInventoryAdapter(manifest, undefined, { forceDeleteSecrets: process.argv.includes('--force-disposable-secrets') }), { dryRun, includeInfrastructure });
    process.stdout.write(`${JSON.stringify({ targets: result.targets.map(({ type, id }) => ({ type, id })), scheduled: result.scheduled, shared: result.shared }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cleanup failed.'}\n`);
    process.exitCode = 1;
  }
}
