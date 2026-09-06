import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEPLOYMENT_PATH } from '../lifecycle-types.js';
import { manifest } from './fakes.js';

const processMock = vi.hoisted(() => vi.fn(async (...input: [string, readonly string[], { env?: NodeJS.ProcessEnv }?]) => {
  void input;
  return { stdout: '', stderr: '' };
}));
vi.mock('../preflight.js', () => ({ runProcess: processMock }));
import { verifyDeployment } from '../verify-deployment.js';

const configPath = resolve('.runtime/demo-config.json');
const accountsPath = resolve('.runtime/verify-accounts.json');
const prior = new Map<string, string | undefined>();

beforeEach(async () => {
  await mkdir(resolve('.runtime'), { recursive: true, mode: 0o700 });
  for (const path of [DEPLOYMENT_PATH, configPath, accountsPath]) {
    try { prior.set(path, await readFile(path, 'utf8')); } catch { prior.set(path, undefined); }
  }
  const accounts = [
    { alias: 'patient-a', email: 'patient-a@example.com', displayName: 'Patient A', role: 'patient' },
    { alias: 'patient-b', email: 'patient-b@example.com', displayName: 'Patient B', role: 'patient' },
    { alias: 'clinician-a', email: 'clinician-a@example.com', displayName: 'Clinician A', role: 'clinician' },
    { alias: 'clinician-b', email: 'clinician-b@example.com', displayName: 'Clinician B', role: 'clinician' },
  ];
  await writeFile(accountsPath, JSON.stringify(accounts), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
    maxCostUsd: 5, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: accountsPath, priceReport: accountsPath }), { mode: 0o600 });
  await writeFile(DEPLOYMENT_PATH, JSON.stringify({ ...manifest, outputs: { ...manifest.outputs, UserPoolId: 'eu-north-1_fixture' } }), { mode: 0o600 });
  processMock.mockClear();
});

afterEach(async () => {
  for (const [path, contents] of prior) {
    if (contents === undefined) await rm(path, { force: true });
    else await writeFile(path, contents, { mode: 0o600 });
  }
  prior.clear();
});

it('standalone verification maps all four aliases to deterministic private files without exposing credentials', async () => {
  const hostile = {
    AWS_ACCESS_KEY_ID: 'aws-access-sentinel', AWS_SECRET_ACCESS_KEY: 'aws-secret-sentinel', AWS_SESSION_TOKEN: 'aws-session-sentinel',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/oidc-sentinel', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/sentinel',
    DEMO_CLINICIAN_A_EMAIL: 'controlled-email-sentinel', PORTAL_E2E_PATIENT_A_PASSWORD: 'legacy-password-sentinel',
    PORTAL_E2E_OLD_FILE: '/tmp/old-file-sentinel', GH_TOKEN: 'github-token-sentinel',
  };
  for (const [name, value] of Object.entries(hostile)) vi.stubEnv(name, value);
  try {
    await verifyDeployment();
    expect(processMock).toHaveBeenCalledTimes(1);
    const [, args, options] = processMock.mock.calls[0]!;
    expect(args).toEqual(['exec', 'playwright', 'test', '--project=aws']);
    const env = options!.env!;
    const keys = ['PORTAL_E2E_PATIENT_A_FILE', 'PORTAL_E2E_PATIENT_B_FILE', 'PORTAL_E2E_CLINICIAN_A_FILE', 'PORTAL_E2E_CLINICIAN_B_FILE'];
    expect(keys.map((key) => env[key])).toHaveLength(4);
    expect(new Set(keys.map((key) => env[key])).size).toBe(4);
    for (const key of keys) expect(env[key]).toMatch(/\.runtime\/credentials\/[a-zA-Z0-9_-]+-[a-f0-9]{64}\.json$/);
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NODE_ENV', 'PORTAL_E2E_AWS',
      'PORTAL_E2E_AWS_URL', ...keys]);
    expect(Object.keys(env).every((name) => allowed.has(name))).toBe(true);
    expect(JSON.stringify(processMock.mock.calls)).not.toMatch(/password|patient-a@example\.com|sentinel/i);
  } finally { vi.unstubAllEnvs(); }
});

it('refuses an output-empty recovery manifest before starting standalone verification', async () => {
  await writeFile(DEPLOYMENT_PATH, JSON.stringify({ ...manifest, phase: 'bootstrap', outputs: {}, resources: [] }), { mode: 0o600 });
  await expect(verifyDeployment()).rejects.toThrow(/ready deployment manifest/i);
  expect(processMock).not.toHaveBeenCalled();
});
