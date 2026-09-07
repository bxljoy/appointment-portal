import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentManifest } from './lifecycle-types.js';
import { awsPlaywrightEnvironment, awsPlaywrightFileEnvironment, readAwsDemoInput } from './aws-lifecycle.js';
import { verifyAws, type VerificationSummary } from './verify-aws.js';
import { writePrivateJson } from './private-file.js';

export const verifyDeployment = async (paths: { deployment?: string; config?: string; verification?: string } = {}): Promise<VerificationSummary> => {
  const manifest = await loadDeploymentManifest(paths.deployment);
  if (!manifest || manifest.phase !== 'ready') throw new Error('A ready deployment manifest is required.');
  const config = await readAwsDemoInput(paths.config ?? resolve('.runtime/demo-config.json'));
  if (config.account !== manifest.account || config.region !== manifest.region || config.sourceCommit !== manifest.sourceCommit) {
    throw new Error('Private demo configuration does not match the ready deployment manifest.');
  }
  const frontendUrl = manifest.outputs.FrontendUrl;
  if (!frontendUrl) throw new Error('FrontendUrl is missing from the manifest.');
  const apiUrl = manifest.outputs.ApiUrl;
  const bucket = manifest.outputs.WebBucketName;
  if (!apiUrl || !bucket) throw new Error('Deployed API and bucket outputs are required.');
  const fileEnvironment = await awsPlaywrightFileEnvironment(config, manifest);
  const summary = await verifyAws(manifest, { environment: awsPlaywrightEnvironment(frontendUrl, fileEnvironment, process.env,
    { apiUrl, bucket, region: manifest.region }) });
  await writePrivateJson(paths.verification ?? resolve('.runtime/verification.json'), summary);
  if (summary.checks.some((check) => check.status === 'failed')) throw new Error('Deployed AWS verification failed.');
  return summary;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyDeployment(); process.stdout.write('Deployed browser and API verification passed.\n'); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Deployment verification failed.'}\n`); process.exitCode = 1; }
}
