import { z } from 'zod';

const frontendOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(url.hostname);
}, 'frontendUrl must be a public HTTPS origin without a path, credentials, query, or fragment');

const portalConfigSchema = z.strictObject({
  account: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/),
  postgresVersion: z.string().regex(/^17\.[1-9]\d*$/),
  phase: z.enum(['bootstrap', 'ready']),
  frontendUrl: frontendOrigin.optional(),
  qualifier: z.string().regex(/^[a-z0-9]{1,10}$/),
}).refine((config) => config.phase !== 'ready' || config.frontendUrl !== undefined, {
  path: ['frontendUrl'], message: 'ready phase requires frontendUrl',
});

export type PortalConfig = z.infer<typeof portalConfigSchema>;

export const parsePortalConfig = (input: unknown): PortalConfig => portalConfigSchema.parse(input);
