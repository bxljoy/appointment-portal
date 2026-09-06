import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentManifest } from './lifecycle-types.js';
import { runProcess } from './preflight.js';
import { awsPlaywrightEnvironment, awsPlaywrightFileEnvironment, readAwsDemoInput } from './aws-lifecycle.js';

export const verifyDeployment = async () => {
  const manifest = await loadDeploymentManifest();
  if (!manifest || manifest.phase !== 'ready') throw new Error('A ready deployment manifest is required.');
  const config = await readAwsDemoInput(resolve('.runtime/demo-config.json'));
  if (config.account !== manifest.account || config.region !== manifest.region || config.sourceCommit !== manifest.sourceCommit) {
    throw new Error('Private demo configuration does not match the ready deployment manifest.');
  }
  const frontendUrl = manifest.outputs.FrontendUrl;
  if (!frontendUrl) throw new Error('FrontendUrl is missing from the manifest.');
  const fileEnvironment = await awsPlaywrightFileEnvironment(config, manifest);
  await runProcess('pnpm', ['exec', 'playwright', 'test', '--project=aws'], { env: awsPlaywrightEnvironment(frontendUrl, fileEnvironment) });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyDeployment(); process.stdout.write('Deployed browser and API verification passed.\n'); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Deployment verification failed.'}\n`); process.exitCode = 1; }
}
