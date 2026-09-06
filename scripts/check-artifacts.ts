import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const productionDirectories = ['apps/web/dist', 'apps/api/dist/lambda', 'packages/database/dist/lambda', 'infra/cdk.out/bootstrap', 'infra/cdk.out/ready'];

export async function checkArtifacts(root: string, trackedFiles?: string[]) {
  const findings: string[] = [];
  for (const directory of productionDirectories) {
    const inspect = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Production artifacts must not contain symlinks.');
      if (info.isDirectory()) { for (const name of await readdir(path)) await inspect(join(path, name)); return; }
      if (!info.isFile()) throw new Error('Production artifacts must contain only regular files.');
      const contents = await readFile(path, 'utf8');
      if (forbiddenArtifact(relative(root, path), contents)) findings.push(relative(root, path));
    };
    await inspect(join(root, directory));
  }
  const tracked = trackedFiles ?? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
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
  return /(?:^|\/)(?:\.runtime|\.auth|playwright-report|test-results|traces|storage-state)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:key|pem)$/.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkArtifacts(fileURLToPath(new URL('../', import.meta.url))); process.stdout.write('Production artifacts and tracked runtime files passed inspection.\n'); }
  catch { process.stderr.write('Artifact inspection failed. Run the focused guard tests and inspect generated output locally. No file contents were printed.\n'); process.exitCode = 1; }
}
