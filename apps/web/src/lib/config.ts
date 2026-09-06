import { z } from 'zod';

const httpsUrl = z.url({ protocol: /^https$/ });
export const PublicConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('local'), apiBaseUrl: z.literal('/api') }),
  z.strictObject({
    mode: z.literal('cognito'),
    apiBaseUrl: z.literal('/api'),
    issuer: httpsUrl,
    clientId: z.string().trim().min(1),
    cognitoDomain: httpsUrl.refine((value) => new URL(value).origin === value.replace(/\/$/, ''), 'Expected a domain origin'),
    redirectUri: z.url(),
    logoutUri: z.url(),
  }),
]);
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export type CognitoConfig = Extract<PublicConfig, { mode: 'cognito' }>;

export function parsePublicConfig(raw: unknown, production: boolean, origin: string): PublicConfig {
  const config = PublicConfigSchema.parse(raw);
  if (production && config.mode !== 'cognito') throw new Error('Production requires Cognito authentication.');
  if (config.mode === 'cognito') {
    for (const [value, path] of [[config.redirectUri, '/auth/callback'], [config.logoutUri, '/signed-out']]) {
      const url = new URL(value);
      if (url.origin !== origin || url.pathname !== path || url.search || url.hash || url.username || url.password) {
        throw new Error('Authentication callback URLs must match this application.');
      }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
        throw new Error('Authentication callback URLs require HTTPS outside localhost.');
      }
    }
    const issuer = new URL(config.issuer);
    if (issuer.search || issuer.hash || issuer.username || issuer.password) throw new Error('Invalid authentication issuer.');
  }
  return config;
}

export async function loadPublicConfig(): Promise<PublicConfig> {
  const response = await fetch('/config.json', { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('Application configuration is unavailable.');
  return parsePublicConfig(await response.json(), import.meta.env.PROD, window.location.origin);
}
