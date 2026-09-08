import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { manifest } from './fakes.js';

const processMock = vi.hoisted(() => vi.fn(async (...input: [string, readonly string[], { env?: NodeJS.ProcessEnv }?]) => {
  void input;
  return { stdout: 'PORTAL_REQUEST_ID:request_fixture-123\n', stderr: '' };
}));
vi.mock('../preflight.js', () => ({ runProcess: processMock }));
import { verifyDeployment } from '../verify-deployment.js';

let root: string;
let configPath: string;
let accountsPath: string;
let deploymentPath: string;
let verificationPath: string;
let manualRegistrationPath: string;
const correlation = { observe: async () => ({ requestCount: 1, coldCount: 1, warmCount: 0, maxDurationMs: 1 }) };

beforeEach(async () => {
  const preparedAt = new Date(Date.now() - 60 * 60_000);
  const expiry = { createdAt: preparedAt.toISOString(), expiresAt: new Date(preparedAt.getTime() + 2 * 60 * 60_000).toISOString() };
  root = await mkdtemp(join(await realpath(tmpdir()), 'portal-verify-deployment-'));
  configPath = join(root, 'demo-config.json'); accountsPath = join(root, 'accounts.json');
  deploymentPath = join(root, 'deployment.json'); verificationPath = join(root, 'verification.json');
  manualRegistrationPath = join(root, 'manual-registration.json');
  const accounts = [
    { alias: 'patient-a', email: 'patient-a@example.com', displayName: 'Patient A', role: 'patient' },
    { alias: 'patient-b', email: 'patient-b@example.com', displayName: 'Patient B', role: 'patient' },
    { alias: 'clinician-a', email: 'clinician-a@example.com', displayName: 'Clinician A', role: 'clinician' },
    { alias: 'clinician-b', email: 'clinician-b@example.com', displayName: 'Clinician B', role: 'clinician' },
  ];
  await writeFile(accountsPath, JSON.stringify(accounts), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 2,
    maxCostUsd: 5, repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main', sourceCommit: 'a'.repeat(40), ...expiry,
    accountsFile: accountsPath, priceReport: accountsPath }), { mode: 0o600 });
  await writeFile(deploymentPath, JSON.stringify({ ...manifest, outputs: { ...manifest.outputs, UserPoolId: 'eu-north-1_fixture',
    ApiUrl: 'https://api.example.com', WebBucketName: 'fixture-bucket' } }), { mode: 0o600 });
  const checkedAt = new Date();
  await writeFile(manualRegistrationPath, JSON.stringify({ account: manifest.account, region: manifest.region, commit: manifest.sourceCommit,
    frontendUrl: manifest.outputs.FrontendUrl, distributionId: manifest.outputs.DistributionId, checkedAt: checkedAt.toISOString(),
    issuer: manifest.outputs.Issuer, clientId: manifest.outputs.ClientId, userPoolId: manifest.outputs.UserPoolId, cognitoDomain: manifest.outputs.CognitoDomain,
    expiresAt: new Date(checkedAt.getTime() + 6 * 60 * 60_000).toISOString(), status: 'manual-passed' }), { mode: 0o600 });
  processMock.mockClear();
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('standalone verification maps all four aliases to deterministic private files without exposing credentials', async () => {
  const hostile = {
    AWS_ACCESS_KEY_ID: 'aws-access-sentinel', AWS_SECRET_ACCESS_KEY: 'aws-secret-sentinel', AWS_SESSION_TOKEN: 'aws-session-sentinel',
    AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/oidc-sentinel', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/sentinel',
    DEMO_CLINICIAN_A_EMAIL: 'controlled-email-sentinel', PORTAL_E2E_PATIENT_A_PASSWORD: 'legacy-password-sentinel',
    PORTAL_E2E_OLD_FILE: '/tmp/old-file-sentinel', GH_TOKEN: 'github-token-sentinel',
  };
  for (const [name, value] of Object.entries(hostile)) vi.stubEnv(name, value);
  try {
    const summary = await verifyDeployment({ deployment: deploymentPath, config: configPath, verification: verificationPath, manualRegistration: manualRegistrationPath }, { correlation });
    expect(processMock).toHaveBeenCalledTimes(3);
    expect(processMock.mock.calls.map(([, args]) => args)).toEqual([
      ['exec', 'playwright', 'test', 'tests/e2e/aws-auth.spec.ts', '--project=aws', '--project=aws-mobile'],
      ['exec', 'playwright', 'test', 'tests/e2e/aws-api.spec.ts', '--project=aws'],
      ['exec', 'playwright', 'test', 'tests/e2e/aws-races.spec.ts', '--project=aws'],
    ]);
    const [, , options] = processMock.mock.calls[0]!;
    const env = options!.env!;
    const keys = ['PORTAL_E2E_PATIENT_A_FILE', 'PORTAL_E2E_PATIENT_B_FILE', 'PORTAL_E2E_CLINICIAN_A_FILE', 'PORTAL_E2E_CLINICIAN_B_FILE'];
    expect(keys.map((key) => env[key])).toHaveLength(4);
    expect(new Set(keys.map((key) => env[key])).size).toBe(4);
    for (const key of keys) expect(env[key]).toMatch(/\.runtime\/credentials\/[a-zA-Z0-9_-]+-[a-f0-9]{64}\.json$/);
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NODE_ENV', 'PORTAL_E2E_AWS',
      'PORTAL_E2E_AWS_URL', 'PORTAL_E2E_AWS_API_URL', 'PORTAL_E2E_AWS_BUCKET', 'PORTAL_E2E_AWS_REGION', 'PORTAL_E2E_AWS_ACCOUNT',
      'PORTAL_E2E_AWS_ISSUER', 'PORTAL_E2E_AWS_CLIENT_ID', 'PORTAL_E2E_AWS_USER_POOL_ID', 'PORTAL_E2E_AWS_COGNITO_DOMAIN', ...keys]);
    expect(Object.keys(env).every((name) => allowed.has(name))).toBe(true);
    expect(JSON.stringify(processMock.mock.calls)).not.toMatch(/password|patient-a@example\.com|sentinel/i);
    expect(JSON.parse(await readFile(verificationPath, 'utf8'))).toEqual(summary);
  } finally { vi.unstubAllEnvs(); }
});

it('refuses an output-empty recovery manifest before starting standalone verification', async () => {
  await writeFile(deploymentPath, JSON.stringify({ ...manifest, phase: 'bootstrap', outputs: {}, resources: [] }), { mode: 0o600 });
  await expect(verifyDeployment({ deployment: deploymentPath, config: configPath, verification: verificationPath })).rejects.toThrow(/ready deployment manifest/i);
  expect(processMock).not.toHaveBeenCalled();
});

it('does not report standalone verification success while the human registration gate is incomplete', async () => {
  await expect(verifyDeployment({ deployment: deploymentPath, config: configPath, verification: verificationPath,
    manualRegistration: join(root, 'missing-manual.json') }, { correlation })).rejects.toThrow(/verification failed/i);
  const persisted = JSON.parse(await readFile(verificationPath, 'utf8')) as { checks: Array<{ name: string; status: string }> };
  expect(persisted.checks.at(-1)).toEqual({ name: 'controlled-inbox registration and recovery', status: 'failed',
    detail: 'Manual controlled-inbox registration and recovery is incomplete.' });
});
