import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve equally from source, compiled infra/dist, tests, and the CDK CLI's cwd.
let directory = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(directory, 'pnpm-lock.yaml'))) {
  const parent = dirname(directory);
  if (parent === directory) throw new Error('The portal workspace lockfile could not be found.');
  directory = parent;
}
export const workspaceRoot = directory;
