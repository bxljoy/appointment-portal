import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const productionDirectories = ['apps/web/dist', 'apps/api/dist/lambda', 'packages/database/dist/lambda', 'infra/cdk.out/bootstrap', 'infra/cdk.out/ready'];

export async function checkArtifacts(root: string, trackedFiles?: string[], additionalFiles: string[] = []) {
  const checkout = await realpath(root);
  if (!(await lstat(checkout)).isDirectory()) throw new Error('Artifact inspection requires a checkout directory.');
  const checkedInfo = async (path: string) => {
    const child = relative(checkout, path);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Artifact path escapes the checkout.');
    let current = checkout;
    for (const component of child.split(sep)) {
      current = join(current, component);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Production artifacts must not contain symlinks.');
    }
    if (await realpath(path) !== path) throw new Error('Artifact path resolves outside its checked location.');
    return lstat(path);
  };
  const findings: string[] = [];
  const inspect = async (path: string): Promise<void> => {
    const info = await checkedInfo(path);
    if (info.isDirectory()) { for (const name of await readdir(path)) await inspect(join(path, name)); return; }
    if (!info.isFile()) throw new Error('Production artifacts must contain only regular files.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const checked = await checkedInfo(path);
      if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) throw new Error('Artifact changed during inspection.');
      const contents = await handle.readFile('utf8');
      if (forbiddenArtifact(relative(checkout, path), contents)) findings.push(relative(checkout, path));
    } finally { await handle.close(); }
  };
  for (const directory of productionDirectories) {
    await inspect(join(checkout, directory));
  }
  for (const file of additionalFiles) await inspect(resolve(checkout, file));
  const tracked = trackedFiles ?? execFileSync('git', ['ls-files', '-z'], { cwd: checkout, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of tracked) if (sensitiveFile(path)) findings.push(path);
  if (findings.length) throw new Error(`Unsafe artifacts or tracked runtime files: ${[...new Set(findings)].join(', ')}`);
}

const localOrTestSentinel = /X-Local-Actor|LOCAL_AUTH_DEVELOPMENT_ONLY|local-session|dev-toolbar|patient-a|patient-b|clinician-a|clinician-b|E2E_PASSWORD_DO_NOT_DEPLOY|PORTAL_E2E_PASSWORD_SENTINEL|(?:Only-in-memory-password|Stored-password|Runtime-secret)!234|test-only-bootstrap-password|test-only-before-rollback|fixture-memory-only|fixture-memory-token/i;
function forbiddenArtifact(path: string, contents: string): boolean {
  if (localOrTestSentinel.test(path) || localOrTestSentinel.test(contents)) return true;
  if (!path.endsWith('.json')) return false;
  const secretLiteral = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
      (/^(password|access_token|refresh_token|id_token|clientSecret|secretAccessKey)$/i.test(key) && typeof child === 'string' && child.length > 0) || secretLiteral(child));
  };
  try { return secretLiteral(JSON.parse(contents)); } catch { throw new Error('Invalid generated JSON artifact.'); }
}
function sensitiveFile(path: string): boolean {
  if (path === '.env.example' || path === 'infra/assets/rds-global-bundle.pem') return false;
  return /^reports(?:\/|$)|(?:^|\/)(?:\.runtime|\.auth|playwright-reports?|playwright-results|blob-report|test-results|traces?|storage(?:-state)?|error-context)(?:\/|$)|(?:^|\/)error-context\.md$|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem)$/.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkArtifacts(fileURLToPath(new URL('../', import.meta.url)), undefined, process.argv.slice(2)); process.stdout.write('Production artifacts and tracked runtime files passed inspection.\n'); }
  catch { process.stderr.write('Artifact inspection failed. Run the focused guard tests and inspect generated output locally. No file contents were printed.\n'); process.exitCode = 1; }
}
