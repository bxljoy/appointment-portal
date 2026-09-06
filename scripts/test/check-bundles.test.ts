import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBundles } from '../check-bundles.js';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-bundle-guard-'));
  const metadata = (feature: string) => ({ inputs: {
    [`src/modules/${feature}/handler.ts`]: {}, 'node_modules/@aws-sdk/client-secrets-manager/dist-es/index.js': {},
  }, outputs: { [`dist/lambda/${feature}/index.mjs`]: {
    entryPoint: `src/modules/${feature}/handler.ts`, imports: [{ path: 'node:fs', external: true }], exports: ['handler'],
  } } });
  for (const feature of ['profiles', 'availability', 'appointments']) {
    await mkdir(join(root, 'apps/api/dist/lambda', feature), { recursive: true });
    await writeFile(join(root, 'apps/api/dist/lambda', feature, 'index.mjs'), 'export const handler = () => {};');
    await writeFile(join(root, 'apps/api/dist/lambda', `${feature}.meta.json`), JSON.stringify(metadata(feature)));
  }
  await mkdir(join(root, 'apps/web/dist/assets'), { recursive: true });
  await writeFile(join(root, 'apps/web/dist/index.html'), '<script src="/assets/app-Ab123456.js"></script>');
  await writeFile(join(root, 'apps/web/dist/assets/app-Ab123456.js'), 'export const mode = "cognito";');
  return { root, metadata };
};

describe('production bundle guard', () => {
  it('accepts all three analyzed SDK-bundled handlers and a clean frontend', async () => {
    const { root } = await fixture();
    try { await expect(checkBundles(root)).resolves.toBeUndefined(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['local input', 'test input', 'external SDK', 'missing SDK', 'missing handler export', 'local Lambda code', 'local frontend code', 'local frontend filename', 'missing bundle', 'missing metadata'])(
    'rejects deliberate %s contamination or missing evidence', async (kind) => {
      const { root, metadata } = await fixture();
      try {
        const meta = metadata('profiles');
        const output = meta.outputs['dist/lambda/profiles/index.mjs']!;
        if (kind === 'local input') Object.assign(meta.inputs, { 'src/local/identity.ts': {} });
        if (kind === 'test input') Object.assign(meta.inputs, { 'test/events.ts': {} });
        if (kind === 'external SDK') output.imports.push({ path: '@aws-sdk/client-secrets-manager', external: true });
        if (kind === 'missing SDK') Reflect.deleteProperty(meta.inputs, 'node_modules/@aws-sdk/client-secrets-manager/dist-es/index.js');
        if (kind === 'missing handler export') output.exports = [];
        await writeFile(join(root, 'apps/api/dist/lambda/profiles.meta.json'), JSON.stringify(meta));
        if (kind === 'local Lambda code') await writeFile(join(root, 'apps/api/dist/lambda/profiles/index.mjs'), 'const header = "X-Local-Actor";');
        if (kind === 'local frontend code') await writeFile(join(root, 'apps/web/dist/assets/app-Ab123456.js'), 'const marker = "LOCAL_AUTH_DEVELOPMENT_ONLY";');
        if (kind === 'local frontend filename') await writeFile(join(root, 'apps/web/dist/assets/local-session.css'), 'body{}');
        if (kind === 'missing bundle') await rm(join(root, 'apps/api/dist/lambda/profiles/index.mjs'));
        if (kind === 'missing metadata') await rm(join(root, 'apps/api/dist/lambda/profiles.meta.json'));
        await expect(checkBundles(root)).rejects.toThrow();
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
});
