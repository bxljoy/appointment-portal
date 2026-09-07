import { z } from 'zod';
import type { DeploymentManifest } from './lifecycle-types.js';

const authoritySchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  issuer: z.url().startsWith('https://'),
  clientId: z.string().regex(/^[A-Za-z0-9]+$/),
  userPoolId: z.string().min(1),
  cognitoDomain: z.url().startsWith('https://'),
  frontendUrl: z.url().startsWith('https://'),
});

export type AwsAuthority = z.infer<typeof authoritySchema>;
export type PublicCognitoConfig = {
  mode: 'cognito'; apiBaseUrl: '/api'; issuer: string; clientId: string; cognitoDomain: string;
  redirectUri: string; logoutUri: string;
};

const exactOrigin = (value: string, label: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/' && url.href !== url.origin || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an exact HTTPS origin.`);
  }
  return url.origin;
};

export function authorityFromManifest(manifest: DeploymentManifest): AwsAuthority {
  if (manifest.phase !== 'ready' || !manifest.sourceCommit) throw new Error('A ready deployment manifest is required.');
  const read = (name: string) => manifest.outputs[name] ?? (() => { throw new Error(`Deployment output ${name} is unavailable.`); })();
  const authority = authoritySchema.parse({ account: manifest.account, region: manifest.region, issuer: read('Issuer'),
    clientId: read('ClientId'), userPoolId: read('UserPoolId'), cognitoDomain: read('CognitoDomain'), frontendUrl: read('FrontendUrl') });
  const frontend = exactOrigin(authority.frontendUrl, 'Frontend URL');
  const domain = exactOrigin(authority.cognitoDomain, 'Cognito domain');
  if (!new RegExp(`^${authority.region.replaceAll('-', '\\-')}_[A-Za-z0-9]+$`).test(authority.userPoolId) ||
      authority.issuer !== `https://cognito-idp.${authority.region}.amazonaws.com/${authority.userPoolId}` ||
      !new RegExp(`^https://[a-z0-9-]+\\.auth\\.${authority.region.replaceAll('-', '\\-')}\\.amazoncognito\\.com$`).test(domain)) {
    throw new Error('Deployment Cognito authority is inconsistent with its AWS region.');
  }
  return { ...authority, frontendUrl: frontend, cognitoDomain: domain };
}

export function validatePublicCognitoConfig(raw: unknown, expected: AwsAuthority): PublicCognitoConfig {
  const config = z.strictObject({ mode: z.literal('cognito'), apiBaseUrl: z.literal('/api'), issuer: z.string(), clientId: z.string(),
    cognitoDomain: z.string(), redirectUri: z.string(), logoutUri: z.string() }).parse(raw);
  const exact = {
    issuer: expected.issuer, clientId: expected.clientId, cognitoDomain: expected.cognitoDomain,
    redirectUri: `${expected.frontendUrl}/auth/callback`, logoutUri: `${expected.frontendUrl}/signed-out`,
  };
  if (Object.entries(exact).some(([key, value]) => config[key as keyof typeof exact] !== value)) {
    throw new Error('Deployed public Cognito configuration does not match the ready manifest authority.');
  }
  return config;
}

export function assertManagedLoginOrigin(currentUrl: string, authority: AwsAuthority): void {
  let origin: string;
  try { origin = new URL(currentUrl).origin; } catch { throw new Error('Managed login left the expected Cognito authority.'); }
  if (origin !== authority.cognitoDomain) throw new Error('Managed login left the expected Cognito authority.');
}
