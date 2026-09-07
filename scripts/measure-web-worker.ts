import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { authorityFromManifest, validatePublicCognitoConfig } from './aws-authority.js';
import { loadDeploymentManifest } from './lifecycle-types.js';
import { assertLighthousePrivacy, authenticatedUserFlowAdapter, createAuthenticatedLighthouseSession, measureWeb } from './measure-web.js';
import { readPrivateFile } from './private-file.js';

export async function runAuthenticatedWorker(url: string, environment = process.env): Promise<unknown> {
  assertLighthousePrivacy(environment);
  const manifest = await loadDeploymentManifest(); if (!manifest) throw new Error('A ready deployment manifest is required.');
  const supplied = { account: environment.APPT_MEASURE_ACCOUNT ?? '', region: environment.APPT_MEASURE_REGION ?? '',
    issuer: environment.APPT_MEASURE_ISSUER ?? '', clientId: environment.APPT_MEASURE_CLIENT_ID ?? '', userPoolId: environment.APPT_MEASURE_USER_POOL_ID ?? '',
    cognitoDomain: environment.APPT_MEASURE_COGNITO_DOMAIN ?? '', frontendUrl: environment.APPT_MEASURE_FRONTEND_URL ?? '' };
  const authority = authorityFromManifest(manifest);
  if (Object.entries(authority).some(([key, value]) => supplied[key as keyof typeof supplied] !== value)) {
    throw new Error('Authenticated measurement authority does not match the ready manifest.');
  }
  const response = await fetch(new URL('/config.json', authority.frontendUrl));
  if (!response.ok || response.url !== new URL('/config.json', authority.frontendUrl).href) throw new Error('Deployed public configuration is unavailable at the exact frontend authority.');
  validatePublicCognitoConfig(await response.json(), authority);
  const credentialPath = environment.APPT_MEASURE_CREDENTIAL_FILE;
  if (!credentialPath) throw new Error('Authenticated measurement credential file is missing.');
  const loadCredential = async () => z.object({ email: z.email(), password: z.string().min(12), role: z.literal('patient') })
    .parse(JSON.parse(await readPrivateFile(credentialPath, 16_384)));
  return measureWeb({ url, mode: 'authenticated', runs: 3 }, authenticatedUserFlowAdapter(() => createAuthenticatedLighthouseSession(authority, loadCredential)), { manifest });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const url = process.argv[2]; if (!url) throw new Error('Authenticated measurement URL is required.');
    process.stdout.write(`${JSON.stringify(await runAuthenticatedWorker(url))}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Authenticated measurement failed.'}\n`); process.exitCode = 1; }
}
