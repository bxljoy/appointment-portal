import { readFileSync } from 'node:fs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DirectoryNameSchema, OffsetDateTimeSchema, RoleSchema } from '@portal/contracts';
import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';
import { seedDemo } from './seed.js';
import { migrate } from './migrate.js';
import { provisionAppRole } from './provision-role.js';

export const SeedUserSchema = z.strictObject({
  sub: z.uuid(), displayName: DirectoryNameSchema.refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value)), role: RoleSchema,
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }).optional(),
});
export const MigrationPayloadSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('migrate') }),
  z.strictObject({ action: z.literal('seed'), users: z.array(SeedUserSchema).min(1).max(20)
    .refine((users) => new Set(users.map((user) => user.sub)).size === users.length), now: OffsetDateTimeSchema }),
]);
export const MigrationResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), appliedMigrations: z.array(z.string().regex(/^\d+_[a-z0-9_]+\.sql$/)).max(1_000) }),
  z.strictObject({ ok: z.literal(false), error: z.enum(['INVALID_INPUT', 'SETUP_FAILED']) }),
]);
export type MigrationPayload = z.infer<typeof MigrationPayloadSchema>;
export type MigrationResult = z.infer<typeof MigrationResultSchema>;
export type MigrationDependencies = {
  env: Record<string, string | undefined>;
  readSecret: (arn: string) => Promise<string>;
  readCaBundle: (path: string) => string;
  createPool: (config: PoolConfig) => Pool;
  migrate?: typeof migrate;
  seed?: typeof seedDemo;
  provisionRole?: typeof provisionAppRole;
};
export const createMigrationHandler = (deps: MigrationDependencies) => async (input: unknown): Promise<MigrationResult> => {
  const parsed = MigrationPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'INVALID_INPUT' };
  let pool: Pool | undefined;
  let result: MigrationResult;
  try {
    const required = (key: string) => z.string().min(1).parse(deps.env[key]);
    const admin = z.object({ username: z.literal('portal_admin'), password: z.string().min(1) })
      .parse(JSON.parse(await deps.readSecret(required('ADMIN_DATABASE_SECRET_ARN'))));
    // The application secret is used only to install the fixed login password.
    const application = parsed.data.action === 'migrate' ? z.object({ username: z.literal('portal_app'), password: z.string().min(1) })
      .parse(JSON.parse(await deps.readSecret(required('APPLICATION_DATABASE_SECRET_ARN')))) : undefined;
    pool = deps.createPool({
      host: required('DATABASE_HOST'), database: required('DATABASE_NAME'),
      port: z.coerce.number().int().min(1).max(65_535).parse(required('DATABASE_PORT')),
      user: admin.username, password: admin.password, max: 1,
      connectionTimeoutMillis: 5_000, statement_timeout: 90_000, idle_in_transaction_session_timeout: 90_000,
      ssl: { rejectUnauthorized: true, ca: z.string().min(1).parse(deps.readCaBundle(required('DATABASE_CA_BUNDLE_PATH'))) },
    });
    pool.on?.('error', () => undefined);
    if (parsed.data.action === 'migrate' && application) {
      const appliedMigrations = await (deps.migrate ?? migrate)(pool, required('MIGRATIONS_PATH'),
        (client) => (deps.provisionRole ?? provisionAppRole)(client, application.password));
      result = { ok: true, appliedMigrations };
    } else if (parsed.data.action === 'seed') {
      await (deps.seed ?? seedDemo)(pool, parsed.data.users, new Date(parsed.data.now));
      result = { ok: true, appliedMigrations: [] };
    } else { result = { ok: false, error: 'SETUP_FAILED' }; }
  } catch {
    result = { ok: false, error: 'SETUP_FAILED' };
  } finally {
    try { await pool?.end(); } catch { result = { ok: false, error: 'SETUP_FAILED' }; }
  }
  return result;
};

const secrets = new SecretsManagerClient({});
export const handler = createMigrationHandler({
  env: process.env,
  readSecret: async (arn) => {
    const value = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!value.SecretString) throw new Error('Missing database credential.');
    return value.SecretString;
  },
  readCaBundle: (path) => readFileSync(path, 'utf8'), createPool: (config) => new Pool(config),
});
