import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInventory, loadDeploymentManifest, type DeploymentManifest, type InventoryAdapter, type ResourceRecord } from './lifecycle-types.js';

export type CleanupVerification = { remaining: ResourceRecord[]; scheduled: ResourceRecord[]; shared: ResourceRecord[] };

export const verifyCleanup = async (manifest: DeploymentManifest, inventory: Pick<InventoryAdapter, 'account' | 'page'>, options: { includeInfrastructure?: boolean } = {}): Promise<CleanupVerification> => {
  if (await inventory.account() !== manifest.account) throw new Error(`AWS account mismatch: expected ${manifest.account}.`);
  const resources = await collectInventory(inventory);
  const relevant = options.includeInfrastructure ? resources : resources.filter((resource) => !/^(?:Bootstrap|Delivery)::/.test(resource.type));
  return {
    remaining: relevant.filter((resource) => resource.state === 'unverified' || resource.owned && resource.state !== 'scheduled'),
    scheduled: relevant.filter((resource) => resource.owned && resource.state === 'scheduled'),
    shared: resources.filter((resource) => !resource.owned && resource.state !== 'unverified'),
  };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await loadDeploymentManifest();
    if (!manifest) throw new Error('No deployment manifest exists.');
    const { AwsInventoryAdapter } = await import('./aws-lifecycle.js');
    const result = await verifyCleanup(manifest, new AwsInventoryAdapter(manifest), { includeInfrastructure: process.argv.includes('--all') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.remaining.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Cleanup verification failed.'}\n`);
    process.exitCode = 1;
  }
}
