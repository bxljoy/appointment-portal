import { expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest } from './fakes.js';
import { confirmManualRegistration, manualRegistrationCheck, recordManualRegistration } from '../manual-registration.js';

const now = new Date('2026-09-07T12:00:00Z');
const answers = (values: string[]) => ({ ask: async () => values.shift() ?? 'no' });

it('keeps the gate incomplete and requires every injected human checklist answer', async () => {
  expect(manualRegistrationCheck(manifest, undefined, now)).toMatchObject({ status: 'failed' });
  await expect(confirmManualRegistration(manifest, answers(['yes', 'yes', 'no']), () => now)).rejects.toThrow(/every checklist/i);
});

it('rejects flags, pipes, and CI, then records only an interactive attestation', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-manual-registration-'));
  const manifestPath = join(root, 'deployment.json'); const evidencePath = join(root, 'manual.json');
  const good = () => answers(Array(6).fill('yes'));
  try {
    await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    for (const rejected of [
      { args: ['--confirm-all'], stdinIsTTY: true, stdoutIsTTY: true, prompter: good() },
      { args: [], stdinIsTTY: false, stdoutIsTTY: true, prompter: good() },
      { args: [], stdinIsTTY: true, stdoutIsTTY: true, ci: '1', prompter: good() },
    ]) await expect(recordManualRegistration({ ...rejected, manifestPath, evidencePath })).rejects.toThrow(/interactive TTY/i);
    await recordManualRegistration({ args: [], stdinIsTTY: true, stdoutIsTTY: true, prompter: good(), manifestPath, evidencePath, now: () => now });
    const stored = JSON.parse(await readFile(evidencePath, 'utf8'));
    expect(stored).toMatchObject({ account: manifest.account, region: manifest.region, commit: manifest.sourceCommit,
      frontendUrl: manifest.outputs.FrontendUrl, distributionId: manifest.outputs.DistributionId, issuer: manifest.outputs.Issuer,
      clientId: manifest.outputs.ClientId, userPoolId: manifest.outputs.UserPoolId, cognitoDomain: manifest.outputs.CognitoDomain, status: 'manual-passed' });
    expect(stored.expiresAt).toBe('2026-09-07T18:00:00.000Z');
    expect(JSON.stringify(stored)).not.toContain('@');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects stale, altered, and same-commit evidence from a different deployment identity', async () => {
  const evidence = await confirmManualRegistration(manifest, answers(Array(6).fill('yes')), () => now);
  expect(manualRegistrationCheck(manifest, evidence, new Date('2026-09-07T13:00:00Z'))).toMatchObject({ status: 'manual-passed' });
  expect(manualRegistrationCheck({ ...manifest, outputs: { ...manifest.outputs, DistributionId: 'ENEW' } }, evidence, now)).toMatchObject({ status: 'failed' });
  expect(manualRegistrationCheck({ ...manifest, outputs: { ...manifest.outputs, FrontendUrl: 'https://new.cloudfront.net' } }, evidence, now)).toMatchObject({ status: 'failed' });
  for (const [name, value] of [['UserPoolId', 'eu-north-1_replaced'], ['ClientId', 'replacedclient'],
    ['Issuer', 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_replaced'],
    ['CognitoDomain', 'https://replacement.auth.eu-north-1.amazoncognito.com']] as const) {
    expect(manualRegistrationCheck({ ...manifest, outputs: { ...manifest.outputs, [name]: value } }, evidence, now)).toMatchObject({ status: 'failed' });
  }
  expect(manualRegistrationCheck(manifest, { ...evidence, expiresAt: '2026-09-08T12:00:00.000Z' }, now)).toMatchObject({ status: 'failed' });
  expect(manualRegistrationCheck(manifest, evidence, new Date('2026-09-07T18:00:01Z'))).toMatchObject({ status: 'failed' });
});
