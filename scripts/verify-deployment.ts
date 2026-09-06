import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentManifest } from './lifecycle-types.js';
import { runProcess } from './preflight.js';

export const verifyDeployment = async () => {
  const manifest = await loadDeploymentManifest();
  if (!manifest || manifest.phase !== 'ready') throw new Error('A ready deployment manifest is required.');
  const frontendUrl = manifest.outputs.FrontendUrl;
  if (!frontendUrl) throw new Error('FrontendUrl is missing from the manifest.');
  await runProcess('pnpm', ['exec', 'playwright', 'test', '--project=aws'], { env: {
    ...process.env, PORTAL_E2E_AWS: '1', PORTAL_E2E_AWS_URL: frontendUrl,
  } });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyDeployment(); process.stdout.write('Deployed browser and API verification passed.\n'); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Deployment verification failed.'}\n`); process.exitCode = 1; }
}
