import type { Pool, PoolClient } from 'pg';
import { expect, test, vi } from 'vitest';
import { createMigrationHandler } from '../src/lambda.js';

const env = { ADMIN_DATABASE_SECRET_ARN: 'admin-arn', APPLICATION_DATABASE_SECRET_ARN: 'app-arn',
  DATABASE_HOST: 'direct.rds.example', DATABASE_NAME: 'portal', DATABASE_PORT: '5432',
  DATABASE_CA_BUNDLE_PATH: '/var/task/certs/rds-global-bundle.pem', MIGRATIONS_PATH: '/var/task/migrations' };
const setup = () => {
  const client = { query: vi.fn() } as unknown as PoolClient;
  const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
  const deps = { env: { ...env }, readSecret: vi.fn(async (arn: string) => JSON.stringify({ username: arn === 'admin-arn' ? 'portal_admin' : 'portal_app',
    password: arn === 'admin-arn' ? 'admin-sentinel' : 'app-sentinel', host: 'untrusted-secret-host' })),
    readCaBundle: vi.fn(() => 'public-rds-ca'), createPool: vi.fn(() => pool),
    migrate: vi.fn(async (_pool: Pool, _directory: string, after?: (client: PoolClient) => Promise<void>) => {
      await after?.(client); return ['001_initial.sql'];
    }), seed: vi.fn().mockResolvedValue(undefined), provisionRole: vi.fn().mockResolvedValue(undefined) };
  return { deps, pool, client, handler: createMigrationHandler(deps) };
};

test('migrates using only admin/direct RDS TLS and uses the app password on the migration connection', async () => {
  const { deps, handler, pool, client } = setup();
  await expect(handler({ action: 'migrate' })).resolves.toEqual({ ok: true, appliedMigrations: ['001_initial.sql'] });
  expect(deps.readSecret.mock.calls).toEqual([['admin-arn'], ['app-arn']]);
  expect(deps.createPool).toHaveBeenCalledWith(expect.objectContaining({ host: 'direct.rds.example', database: 'portal', port: 5432,
    user: 'portal_admin', password: 'admin-sentinel', max: 1, ssl: { ca: 'public-rds-ca', rejectUnauthorized: true } }));
  expect(deps.migrate).toHaveBeenCalledWith(pool, '/var/task/migrations', expect.any(Function));
  expect(deps.provisionRole).toHaveBeenCalledWith(client, 'app-sentinel');
  expect(deps.seed).not.toHaveBeenCalled(); expect(pool.end).toHaveBeenCalledOnce();
});

test.each(['wrong-admin', 'wrong-app', 'invalid-json', 'invalid-port', 'empty-ca'])('fails closed for misconfigured credentials or TLS: %s', async (failure) => {
  const { deps, handler } = setup();
  const read = deps.readSecret.getMockImplementation()!;
  if (failure === 'wrong-admin' || failure === 'wrong-app') deps.readSecret.mockImplementation(async (arn) => {
    const value = JSON.parse(await read(arn));
    if (arn === (failure === 'wrong-admin' ? 'admin-arn' : 'app-arn')) value.username = 'unexpected-user';
    return JSON.stringify(value);
  });
  if (failure === 'invalid-json') deps.readSecret.mockResolvedValue('raw secret that is not JSON');
  if (failure === 'invalid-port') deps.env.DATABASE_PORT = '5432suffix';
  if (failure === 'empty-ca') deps.readCaBundle.mockReturnValue('');
  await expect(handler({ action: 'migrate' })).resolves.toEqual({ ok: false, error: 'SETUP_FAILED' });
  expect(deps.createPool).not.toHaveBeenCalled(); expect(deps.provisionRole).not.toHaveBeenCalled();
});

test('seeds only supplied sub identities and never reads application credentials for seeding', async () => {
  const { deps, handler, pool } = setup();
  const users = [{ sub: 'd4000000-0000-4000-8000-000000000001', displayName: 'Controlled Clinician', role: 'clinician' }];
  await expect(handler({ action: 'seed', users, now: '2030-06-01T09:00:00Z' })).resolves.toEqual({ ok: true, appliedMigrations: [] });
  expect(deps.readSecret.mock.calls).toEqual([['admin-arn']]);
  expect(deps.seed).toHaveBeenCalledWith(pool, users, new Date('2030-06-01T09:00:00Z'));
  expect(deps.migrate).not.toHaveBeenCalled(); expect(pool.end).toHaveBeenCalledOnce();
});

test.each([
  null, { action: 'drop' }, { action: 'migrate', password: 'sentinel' },
  { action: 'seed', users: [], now: 'yesterday' }, { action: 'seed', users: [], now: '2030-06-01T00:00:00Z' },
  { action: 'seed', users: [{ sub: 'email@example.com', role: 'clinician', displayName: 'Name' }], now: '2030-06-01T00:00:00Z' },
  { action: 'seed', users: [{ sub: 'd4000000-0000-4000-8000-000000000001', role: 'admin', displayName: 'Name' }], now: '2030-06-01T00:00:00Z' },
  { action: 'seed', users: [{ sub: 'd4000000-0000-4000-8000-000000000001', role: 'patient', displayName: 'Name', email: 'extra@example.com' }], now: '2030-06-01T00:00:00Z' },
])('rejects malformed strict payload %j before any secret or database access', async (payload) => {
  const { deps, handler } = setup();
  await expect(handler(payload)).resolves.toEqual({ ok: false, error: 'INVALID_INPUT' });
  expect(deps.readSecret).not.toHaveBeenCalled(); expect(deps.createPool).not.toHaveBeenCalled();
});

test.each(['secret', 'migration', 'grant', 'seed', 'close'])('returns a safe failure for %s errors without logs or credential disclosure', async (where) => {
  const { deps, handler, pool } = setup();
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')];
  const failure = new Error('raw-error admin-sentinel app-sentinel patient@example.com');
  try {
    if (where === 'secret') deps.readSecret.mockRejectedValue(failure);
    if (where === 'migration') deps.migrate.mockRejectedValue(failure);
    if (where === 'grant') deps.provisionRole.mockRejectedValue(failure);
    if (where === 'seed') deps.seed.mockRejectedValue(failure);
    if (where === 'close') vi.mocked(pool.end).mockRejectedValue(failure);
    const payload = where === 'seed' ? { action: 'seed', users: [{ sub: 'd4000000-0000-4000-8000-000000000001', displayName: 'Name', role: 'patient' }], now: '2030-06-01T00:00:00Z' } : { action: 'migrate' };
    await expect(handler(payload)).resolves.toEqual({ ok: false, error: 'SETUP_FAILED' });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { logs.forEach((log) => log.mockRestore()); }
});
