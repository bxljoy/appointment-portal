/* global process, URL */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenMarkers = ['X-Local-Actor', 'src/local/', 'local/identity'];

export const assertLambdaArtifactsClean = async (directory) => {
  const bundles = await findBundles(directory);
  for (const bundle of bundles) {
    const content = await readFile(bundle, 'utf8');
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) {
        throw new Error(`Local-only marker ${marker} found in Lambda bundle ${bundle}.`);
      }
    }
  }
};

const findBundles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findBundles(path);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [path] : [];
  }));
  return nested.flat();
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../dist/lambda', import.meta.url));
  await assertLambdaArtifactsClean(directory);
}
