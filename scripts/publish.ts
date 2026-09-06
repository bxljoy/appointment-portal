import { z } from 'zod';

const noCache = 'no-cache, max-age=0, must-revalidate';
const immutable = 'public, max-age=31536000, immutable';
const hashedAsset = /^assets\/(?:[^/]+-)?[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9]+$/;

const publicConfigSchema = z.strictObject({
  mode: z.literal('cognito'),
  issuer: z.url().refine((value) => value.startsWith('https://cognito-idp.')),
  clientId: z.string().min(1).max(128),
  cognitoDomain: z.url().refine((value) => value.startsWith('https://') && !value.includes('@')),
  apiBaseUrl: z.literal('/api'),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;
export type PublishFile = { key: string; body: Uint8Array; contentType: string };
export type PublishInput = {
  frontendUrl: string;
  callbackUrl: string;
  publicConfig: PublicConfig;
  files: PublishFile[];
};
export type PublishAdapter = {
  upload(entry: PublishFile & { cacheControl: string }): Promise<void>;
  invalidate(paths: string[]): Promise<string>;
  waitInvalidation(id: string): Promise<void>;
};

export const publishFrontend = async (input: PublishInput, adapter: PublishAdapter): Promise<void> => {
  const origin = new URL(input.frontendUrl);
  if (origin.origin !== input.frontendUrl || origin.protocol !== 'https:') throw new Error('Invalid CloudFront frontend origin.');
  if (input.callbackUrl !== `${input.frontendUrl}/auth/callback`) throw new Error('Deployed Cognito callback does not match the CloudFront origin.');
  const config = publicConfigSchema.parse(input.publicConfig);
  const configBody = new TextEncoder().encode(`${JSON.stringify(config)}\n`);
  const assets = input.files.filter((file) => file.key.startsWith('assets/'));
  if (assets.some((file) => !hashedAsset.test(file.key))) throw new Error('Frontend assets must use content-hashed names.');
  for (const asset of assets) await adapter.upload({ ...asset, cacheControl: immutable });
  await adapter.upload({ key: 'config.json', body: configBody, contentType: 'application/json', cacheControl: noCache });
  const shell = input.files.find((file) => file.key === 'index.html');
  if (!shell) throw new Error('Frontend index.html is missing.');
  await adapter.upload({ ...shell, cacheControl: noCache });
  for (const file of input.files.filter((file) => !file.key.startsWith('assets/') && file.key !== 'index.html' && file.key !== 'config.json')) {
    await adapter.upload({ ...file, cacheControl: noCache });
  }
  const invalidation = await adapter.invalidate(['/', '/index.html', '/config.json']);
  await adapter.waitInvalidation(invalidation);
};
