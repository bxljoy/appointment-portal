import { expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest } from './fakes.js';
import { confirmManualRegistration, manualRegistrationCheck, recordManualRegistration } from '../manual-registration.js';

const now = new Date('2026-09-07T12:00:00Z');

it('keeps the manual gate incomplete until a human explicitly confirms every inbox step', () => {
  expect(manualRegistrationCheck(manifest, undefined, now)).toMatchObject({ status: 'failed', detail: expect.stringMatching(/incomplete/i) });
  expect(() => confirmManualRegistration(manifest, { signupAlias: 'signup-check', confirmed: false }, () => now)).toThrow(/confirm/i);
  expect(() => confirmManualRegistration(manifest, { signupAlias: 'person@example.com', confirmed: true }, () => now)).toThrow(/alias/i);
});

it('records only an alias after the separate CLI contract receives the explicit all-steps flag', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-manual-registration-'));
  const manifestPath = join(root, 'deployment.json');
  const evidencePath = join(root, 'manual.json');
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await expect(recordManualRegistration({ args: ['--signup-alias', 'signup-check'], manifestPath, evidencePath })).rejects.toThrow(/usage/i);
    await recordManualRegistration({ args: ['--signup-alias', 'signup-check', '--confirm-all'], manifestPath, evidencePath, now: () => now });
    expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toEqual({ commit: manifest.sourceCommit, checkedAt: now.toISOString(),
      signupAlias: 'signup-check', status: 'manual-passed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('binds explicit confirmation to the ready commit and rejects stale or mismatched evidence', () => {
  const evidence = confirmManualRegistration(manifest, { signupAlias: 'signup-check', confirmed: true }, () => now);
  expect(evidence).toEqual({ commit: manifest.sourceCommit, checkedAt: now.toISOString(), signupAlias: 'signup-check', status: 'manual-passed' });
  expect(manualRegistrationCheck(manifest, evidence, new Date('2026-09-07T13:00:00Z'))).toMatchObject({ status: 'manual-passed' });
  expect(manualRegistrationCheck({ ...manifest, sourceCommit: 'b'.repeat(40) }, evidence, now)).toMatchObject({ status: 'failed' });
  expect(manualRegistrationCheck(manifest, evidence, new Date('2026-09-08T00:00:01Z'))).toMatchObject({ status: 'failed', detail: expect.stringMatching(/stale/i) });
  expect(() => confirmManualRegistration({ ...manifest, phase: 'bootstrap' }, { signupAlias: 'signup-check', confirmed: true }, () => now)).toThrow(/ready/i);
});
