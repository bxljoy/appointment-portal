import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../dist', import.meta.url));
const forbidden = /X-Local-Actor|LOCAL_AUTH_DEVELOPMENT_ONLY|local-session|dev-toolbar|patient-a|patient-b|clinician-a|clinician-b/i;
async function inspect(directory) {
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files += await inspect(path);
    else if (entry.isFile()) {
      if (forbidden.test(entry.name) || forbidden.test(await readFile(path, 'utf8'))) throw new Error(`Local authentication found in production artifact: ${path}`);
      files++;
    }
  }
  return files;
}
try {
  const count = await inspect(root);
  if (!count) throw new Error('No production artifacts were found.');
  process.stdout.write(`Web artifact check passed: ${count} files contain no local authentication code or identities.\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
