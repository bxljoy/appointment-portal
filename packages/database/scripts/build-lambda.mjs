/* global URL */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'packages/database/dist/lambda');
await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'certs'), { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ['packages/database/src/lambda.ts'],
  outfile: join(output, 'index.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true,
  banner: { js: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);" },
});
const metadata = result.metafile;
if (Object.keys(metadata.outputs).length !== 1) throw new Error('Expected one migration bundle.');
metadata.outputs = { 'index.mjs': Object.values(metadata.outputs)[0] };
await writeFile(join(output, 'index.meta.json'), JSON.stringify(metadata));
await cp(join(root, 'packages/database/migrations'), join(output, 'migrations'), { recursive: true });
await cp(join(root, 'infra/assets/rds-global-bundle.pem'), join(output, 'certs/rds-global-bundle.pem'));
