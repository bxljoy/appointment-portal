import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('rejects local-auth code in a deliberately contaminated production fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portal-web-guard-'));
  try {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'main.js'), 'const actor = "patient-a"; const header = "X-Local-Actor";');
    const result = spawnSync(process.execPath, ['apps/web/scripts/check-web-artifacts.mjs', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Local authentication');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('rejects missing output rather than claiming a successful scan', () => {
  const result = spawnSync(process.execPath, ['apps/web/scripts/check-web-artifacts.mjs', '/nonexistent-web-artifacts'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
});
