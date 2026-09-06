import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Pool, type PoolConfig } from 'pg';
import { startLocalServer } from '../../apps/api/src/local/server.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { seedDemo } from '../../packages/database/src/seed.js';

export const accounts = ['patient-a', 'patient-b', 'clinician-a', 'clinician-b'] as const;
export type Account = typeof accounts[number];
export const names: Record<Account, string> = { 'patient-a': 'Alice Patient', 'patient-b': 'Bea Patient', 'clinician-a': 'Casey Clinician', 'clinician-b': 'Devon Clinician' };
const root = fileURLToPath(new URL('../../', import.meta.url));

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(force); }
}

async function startWeb(apiUrl: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PORTAL_LOCAL_API_URL: apiUrl };
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Output is only used to discover Vite's actual ephemeral port. Never print inherited environment or raw logs.
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Local Vite startup timed out.')), 30_000);
      const onError = () => finish(new Error('Local Vite failed to start.'));
      let output = '';
      const onData = (data: Buffer) => {
        output = stripVTControlCharacters(output + data.toString()).slice(-8_192);
        const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(output)?.[0]; if (url) finish(undefined, url);
      };
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timeout); child.off('error', onError); child.off('exit', onError); child.stdout?.off('data', onData);
        if (error) reject(error); else resolve(url!);
      };
      child.on('error', onError); child.on('exit', onError); child.stdout?.on('data', onData);
      child.stderr?.resume();
    });
    const response = await fetch(new URL('config.json', baseUrl));
    if (!response.ok || (await response.json() as { mode?: string }).mode !== 'local') throw new Error('Local Vite configuration is unavailable.');
    return { baseUrl, close: () => stopChild(child) };
  } catch (error) { await stopChild(child); throw error; }
}

function localDatabaseOptions(value: string): PoolConfig {
  try {
    const url = new URL(value);
    const port = url.port ? Number(url.port) : 5432;
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.search || url.hash || !Number.isInteger(port) || port < 1 || port > 65535 || !user || user.includes('\0') ||
        !database || database.includes('/') || database.includes('\0') || password.includes('\0')) throw new Error();
    // Never forward connectionString: pg reparses query parameters and lets them override the validated authority.
    // The callback also prevents an empty local password from falling back to an unrelated PGPASSWORD.
    // pg's `config[key] || env || default` also requires truthy startup settings: ''/false would inherit PGOPTIONS/PGREPLICATION.
    const startup = {
      options: '-c search_path=public', replication: 'false', client_encoding: 'utf8',
      application_name: 'portal-e2e', fallback_application_name: 'portal-e2e', binary: false,
      statement_timeout: 0, lock_timeout: 0, idle_in_transaction_session_timeout: 0, query_timeout: 0,
      keepAlive: false, keepAliveInitialDelayMillis: 0,
    } as const;
    return { ...startup, host: url.hostname === '[::1]' ? '::1' : url.hostname, port, user, password: () => password, database, ssl: false, connectionTimeoutMillis: 5_000 };
  } catch { throw new Error('E2E requires a loopback PostgreSQL administrator connection without URL overrides.'); }
}

export async function startLocalPortal() {
  const connection = localDatabaseOptions(process.env.DATABASE_URL ?? 'postgres://portal:portal@127.0.0.1:54329/portal');
  const database = `portal_e2e_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool(connection);
  let created = false;
  let pool: Pool | undefined;
  let api: Awaited<ReturnType<typeof startLocalServer>> | undefined;
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  const close = async () => {
    try { await web?.close(); } finally {
      try { if (api) await api.close(); else await pool?.end(); } finally {
        try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
      }
    }
  };
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    pool = new Pool({ ...connection, database });
    await migrate(pool, fileURLToPath(new URL('../../packages/database/migrations', import.meta.url)));
    process.env.PORTAL_LOCAL_AUTH = '1';
    process.env.NODE_ENV = 'development';
    api = await startLocalServer({ pool, port: 0 });
    web = await startWeb(api.baseUrl);
    // Next week's fixed UTC hour is stable throughout a run and always in the future; no fake browser/server clock.
    const seedTime = new Date(); seedTime.setUTCDate(seedTime.getUTCDate() + 6); seedTime.setUTCHours(9, 0, 0, 0);
    const day = new Date(seedTime.getTime() + 86_400_000).toISOString().slice(0, 10);
    const reset = async () => {
      await pool!.query('TRUNCATE appointments, availability_slots, clinician_profiles, users CASCADE');
      await seedDemo(pool!, accounts.map((sub) => ({ sub, displayName: names[sub], role: sub.startsWith('patient') ? 'patient' as const : 'clinician' as const })), seedTime);
    };
    return { baseUrl: web.baseUrl, apiUrl: api.baseUrl, pool, day, reset, close };
  } catch (error) { await close(); throw error; }
}
