import { readFileSync } from 'node:fs';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

type InitializablePool = {
  connect(): Promise<{ release(destroy?: boolean): void }>;
  end(): Promise<void>;
  on?(event: 'error', listener: () => void): unknown;
};

type PoolProviderOptions<TPool extends InitializablePool> = {
  env: Record<string, string | undefined>;
  readSecret: (secretArn: string) => Promise<string>;
  readCaBundle: (path: string) => string;
  createPool: (config: PoolConfig) => TPool;
};

type DatabaseSecret = {
  host?: string;
  port?: number;
  dbname?: string;
  username: string;
  password: string;
};

const secretsManager = new SecretsManagerClient({});

export const createApplicationPoolProvider = <TPool extends InitializablePool>(
  options: PoolProviderOptions<TPool>,
) => {
  let cached: Promise<TPool> | undefined;

  return (): Promise<TPool> => {
    if (!cached) {
      cached = initializePool(options).catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
};

export const getApplicationPool = createApplicationPoolProvider({
  env: process.env,
  readSecret: async (secretArn) => {
    // AWS SDK v3 GetSecretValue shape:
    // https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_secrets-manager_code_examples.html
    const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (result.SecretString === undefined) {
      throw new Error('The application database secret must contain a SecretString.');
    }
    return result.SecretString;
  },
  readCaBundle: (path) => readFileSync(path, 'utf8'),
  createPool: (config) => new Pool(config),
});

const initializePool = async <TPool extends InitializablePool>(
  { env, readSecret, readCaBundle, createPool }: PoolProviderOptions<TPool>,
): Promise<TPool> => {
  const secretArn = requiredEnv(env, 'APPLICATION_DATABASE_SECRET_ARN');
  const secret = parseDatabaseSecret(await readSecret(secretArn));
  const proxyHost = optionalEnv(env, 'DATABASE_HOST');
  const host = proxyHost ?? requiredSecretString(secret.host);
  const database = optionalEnv(env, 'DATABASE_NAME') ?? requiredSecretString(secret.dbname);
  const configuredPort = optionalEnv(env, 'DATABASE_PORT');
  const port = configuredPort === undefined ? requiredSecretPort(secret.port) : parsePort(configuredPort);
  const ssl = proxyHost
    // RDS Proxy uses an ACM-issued chain trusted by Node's standard trust store:
    // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html#rds-proxy-security.tls
    ? { rejectUnauthorized: true }
    // Direct RDS certificate verification needs the bundled RDS root CAs:
    // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
    : {
        rejectUnauthorized: true,
        ca: readCaBundle(requiredEnv(env, 'DATABASE_CA_BUNDLE_PATH')),
      };

  const pool = createPool({
    host,
    port,
    database,
    user: secret.username,
    password: secret.password,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    ssl,
  });
  pool.on?.('error', () => undefined);

  try {
    const client = await pool.connect();
    try {
      return pool;
    } finally {
      client.release();
    }
  } catch (error) {
    try {
      await pool.end();
    } catch {
      // Preserve the initialization failure and discard this pool.
    }
    throw error;
  }
};

const parseDatabaseSecret = (raw: string): DatabaseSecret => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('The application database secret is invalid.');
  }
  if (!isRecord(value)) throw new Error('The application database secret is invalid.');

  const secret = {
    host: value.host,
    port: value.port,
    dbname: value.dbname,
    username: value.username,
    password: value.password,
  };
  if (
    (secret.host !== undefined && !nonEmptyString(secret.host)) ||
    (secret.port !== undefined && !validPort(secret.port)) ||
    (secret.dbname !== undefined && !nonEmptyString(secret.dbname)) ||
    secret.username !== 'portal_app' ||
    !nonEmptyString(secret.password)
  ) {
    throw new Error('The application database secret is invalid.');
  }
  return secret as DatabaseSecret;
};

const requiredEnv = (env: Record<string, string | undefined>, name: string): string => {
  const value = optionalEnv(env, name);
  if (!value) throw new Error(`Missing required environment variable: ${name}.`);
  return value;
};

const optionalEnv = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const value = env[name];
  return value && value.trim().length > 0 ? value : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const validPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;

const requiredSecretString = (value: string | undefined): string => {
  if (!nonEmptyString(value)) throw new Error('The application database secret is invalid.');
  return value;
};

const requiredSecretPort = (value: number | undefined): number => {
  if (!validPort(value)) throw new Error('The application database secret is invalid.');
  return value;
};

const parsePort = (raw: string): number => {
  if (!/^\d+$/.test(raw)) throw new Error('DATABASE_PORT must be a valid TCP port.');
  const port = Number(raw);
  if (!validPort(port)) throw new Error('DATABASE_PORT must be a valid TCP port.');
  return port;
};

export const inTransaction = async <T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
};
