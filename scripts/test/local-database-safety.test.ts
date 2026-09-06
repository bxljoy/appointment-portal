import { Client, type PoolConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLocalPortal } from '../../tests/e2e/local-auth.setup.js';

const captured = vi.hoisted(() => [] as PoolConfig[]);
type InspectedClient = Client & {
  binary: boolean;
  connectionParameters: {
    client_encoding: string; replication: string; options: string; application_name: string; fallback_application_name: string;
    statement_timeout: false | number; lock_timeout: false | number; idle_in_transaction_session_timeout: false | number; query_timeout: false | number;
    connect_timeout: number;
  };
  getStartupConf(): Record<string, unknown>;
};
vi.mock('pg', async (original) => ({
  ...await original<typeof import('pg')>(),
  Pool: class {
    private readonly index: number;
    constructor(options: PoolConfig) { this.index = captured.push(options) - 1; }
    async query() {
      if (this.index !== 0) throw new Error('Stopped before migration; no network connection was made.');
      return { rows: [], rowCount: 0 };
    }
    async connect() { throw new Error('Stopped before migration; no network connection was made.'); }
    async end() { /* no sockets were opened */ }
  },
}));

beforeEach(() => { captured.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('local E2E PostgreSQL authority validation', () => {
  it.each([
    '?host=remote.example', '?%68ost=remote.example', '?host=%2Fvar%2Frun%2Fpostgresql',
    '?host=%3A%3A2', '?host=127.0.0.1&port=6543', '?port=6543', '?user=override',
    '?database=override', '?sslmode=require', '?options=-csearch_path%3Dpublic',
  ])('rejects connection-string overrides before constructing any pool: %s', async (query) => {
    vi.stubEnv('DATABASE_URL', `postgres://portal@127.0.0.1:54329/portal${query}`);
    await expect(startLocalPortal()).rejects.toThrow(/loopback PostgreSQL/);
    expect(captured).toHaveLength(0);
  });
  it.each([
    'postgres://portal@remote.example:54329/portal', 'postgres://portal@%31%32%37.0.0.1:54329/portal',
    'postgres://portal@%2Fvar%2Frun%2Fpostgresql/portal', 'postgres://portal@[::2]:54329/portal',
    'postgres://portal@127.0.0.1:0/portal', 'postgres://portal@127.0.0.1:65536/portal',
    'https://portal@127.0.0.1:54329/portal', 'postgres://portal@127.0.0.1:54329/portal#host=remote.example',
  ])('rejects unsafe URL fields without networking: %s', async (url) => {
    vi.stubEnv('DATABASE_URL', url);
    await expect(startLocalPortal()).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
  it.each([
    ['postgres://portal@127.0.0.1:54329/portal', '127.0.0.1', 54329],
    ['postgresql://portal@localhost/portal', 'localhost', 5432],
    ['postgres://portal@[::1]:54329/portal', '::1', 54329],
  ] as const)('constructs both pools solely from the validated URL fields: %s', async (url, host, port) => {
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('PGHOST', 'remote.example'); vi.stubEnv('PGPORT', '6543'); vi.stubEnv('PGDATABASE', 'override');
    vi.stubEnv('PGUSER', 'override'); vi.stubEnv('PGPASSWORD', 'unrelated-environment-value'); vi.stubEnv('PGSSLMODE', 'require');
    const startupOverrides = {
      PGOPTIONS: '-c search_path=untrusted -c statement_timeout=1', PGREPLICATION: 'database', PGCLIENT_ENCODING: 'LATIN1',
      PGAPPNAME: 'untrusted-process', PGBINARY: '1', PGCONNECT_TIMEOUT: '1',
      // Installed pg explicitly ignores env fallbacks for these timeout/fallback-name fields; retain that guarantee.
      PGFALLBACK_APPLICATION_NAME: 'untrusted-fallback', PGSTATEMENT_TIMEOUT: '1', PGLOCK_TIMEOUT: '1',
      PGIDLE_IN_TRANSACTION_SESSION_TIMEOUT: '1', PGQUERY_TIMEOUT: '1',
    };
    for (const [name, value] of Object.entries(startupOverrides)) vi.stubEnv(name, value);
    await expect(startLocalPortal()).rejects.toThrow('Stopped before migration');
    expect(captured).toHaveLength(2);
    for (const options of captured) {
      expect(options).not.toHaveProperty('connectionString');
      const client = new Client(options) as InspectedClient; // Constructor-only check of pg's actual normalization; never connect.
      expect(client.host).toBe(host); expect(client.port).toBe(port); expect(client.user).toBe('portal');
      expect(client.ssl).toBe(false);
      const password = client.password as PoolConfig['password'];
      expect(typeof password === 'function' ? await password() : password).toBe('');
      expect(client.binary).toBe(false);
      expect(client.connectionParameters).toMatchObject({
        options: '-c search_path=public', replication: 'false', client_encoding: 'utf8', application_name: 'portal-e2e', fallback_application_name: 'portal-e2e',
        statement_timeout: false, lock_timeout: false, idle_in_transaction_session_timeout: false, query_timeout: false, connect_timeout: 5,
      });
      expect(client.getStartupConf()).toEqual({ user: 'portal', database: options.database, application_name: 'portal-e2e', replication: 'false', options: '-c search_path=public' });
    }
    for (const [name, value] of Object.entries(startupOverrides)) expect(process.env[name]).toBe(value);
    expect(captured[0]!.database).toBe('portal');
    expect(captured[1]!.database).toMatch(/^portal_e2e_[a-f0-9]{32}$/);
  });
});
