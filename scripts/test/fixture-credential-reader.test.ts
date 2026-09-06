import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { awsCredential } from '../../tests/e2e/fixtures.js';

it('rejects a symlinked credential-directory ancestor without touching its target', async () => {
  const root = resolve('.runtime', `fixture-reader-${randomUUID()}`);
  const target = resolve(root, 'target');
  const alias = resolve(root, 'credentials');
  const file = resolve(target, 'patient.json');
  const contents = JSON.stringify({ email: 'patient@example.com', password: 'long-private-password', role: 'patient', sub: randomUUID() });
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
  await symlink(target, alias);
  vi.stubEnv('PORTAL_E2E_PATIENT_A_FILE', resolve(alias, 'patient.json'));
  try {
    await expect(awsCredential('patient-a')).rejects.toThrow(/unsafe|symlink/i);
    expect(await readFile(file, 'utf8')).toBe(contents);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
