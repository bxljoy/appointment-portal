import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { checkMigrationBundle } from '../check-bundles.js';

const fixture = async (run: (root: string, artifact: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'portal-migration-artifact-'));
  const artifact = join(root, 'artifact');
  try {
    await mkdir(join(root, 'infra/assets'), { recursive: true });
    await mkdir(join(root, 'packages/database/migrations'), { recursive: true });
    await mkdir(join(artifact, 'certs'), { recursive: true }); await mkdir(join(artifact, 'migrations'));
    const ca = await readFile(new URL('../../infra/assets/rds-global-bundle.pem', import.meta.url));
    await writeFile(join(root, 'infra/assets/rds-global-bundle.pem'), ca);
    await writeFile(join(artifact, 'certs/rds-global-bundle.pem'), ca);
    await writeFile(join(root, 'packages/database/migrations/001_initial.sql'), 'CREATE TABLE test_table(id int);');
    await cp(join(root, 'packages/database/migrations/001_initial.sql'), join(artifact, 'migrations/001_initial.sql'));
    await writeFile(join(artifact, 'index.mjs'), 'export const handler = async () => ({ok:true,appliedMigrations:[]});');
    await writeFile(join(artifact, 'index.meta.json'), JSON.stringify({ inputs: {
      'packages/database/src/lambda.ts': {}, 'node_modules/@aws-sdk/client-secrets-manager/index.js': {},
      'node_modules/pg-format/lib/index.js': {}, 'node_modules/pg-format/lib/reserved.js': {},
    }, outputs: { 'index.mjs': { entryPoint: 'packages/database/src/lambda.ts', imports: [], exports: ['handler'] } } }));
    await run(root, artifact);
  } finally { await rm(root, { recursive: true, force: true }); }
};

test('accepts a complete importable migration artifact', () => fixture((root, artifact) => expect(checkMigrationBundle(artifact, root)).resolves.toBeUndefined()));
test.each(['missing-sql', 'changed-sql', 'missing-ca', 'local-code', 'local-input', 'external-sdk', 'missing-handler', 'missing-format-map'])('rejects a migration bundle with %s', (issue) => fixture(async (root, artifact) => {
  if (issue === 'missing-sql') await rm(join(artifact, 'migrations/001_initial.sql'));
  if (issue === 'changed-sql') await writeFile(join(artifact, 'migrations/001_initial.sql'), 'SELECT 1');
  if (issue === 'missing-ca') await rm(join(artifact, 'certs/rds-global-bundle.pem'));
  if (issue === 'local-code') await writeFile(join(artifact, 'index.mjs'), 'export const handler = () => "X-Local-Actor";');
  const path = join(artifact, 'index.meta.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  if (issue === 'local-input') metadata.inputs['packages/database/src/seed-cli.ts'] = {};
  if (issue === 'external-sdk') metadata.outputs['index.mjs'].imports.push({ path: '@aws-sdk/client-secrets-manager', external: true });
  if (issue === 'missing-handler') metadata.outputs['index.mjs'].exports = [];
  if (issue === 'missing-format-map') delete metadata.inputs['node_modules/pg-format/lib/reserved.js'];
  await writeFile(path, JSON.stringify(metadata));
  await expect(checkMigrationBundle(artifact, root)).rejects.toThrow();
}));
