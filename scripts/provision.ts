import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { z } from 'zod';
import type { SeedUser } from '../packages/database/src/seed.js';
import { SeedUserSchema, type MigrationPayload } from '../packages/database/src/lambda.js';
import { invokeMigration } from './invoke-migration.js';
import { ensurePrivateDirectory, readPrivateFile, writePrivateJson } from './private-file.js';

const poolIdSchema = z.string().regex(/^[\w-]+_[0-9a-zA-Z]+$/).max(55);
const accountSchema = z.strictObject({
  email: z.email().max(254).refine((value) => value === value.toLowerCase()),
  displayName: SeedUserSchema.shape.displayName, role: SeedUserSchema.shape.role,
});
const accountsSchema = z.array(accountSchema).min(1).max(20).refine((accounts) => new Set(accounts.map((account) => account.email)).size === accounts.length);
const credentialSchema = accountSchema.extend({ userPoolId: poolIdSchema,
  password: z.string().min(12).max(256).regex(/^\S+$/), sub: z.uuid().optional() });
export type ControlledAccount = z.infer<typeof accountSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type CredentialStore = { get(poolId: string, email: string): Promise<Credential | undefined>; put(credential: Credential): Promise<void> };
export type CognitoSender = { send(command: AdminCreateUserCommand | AdminGetUserCommand | AdminSetUserPasswordCommand): Promise<unknown> };
export type ProvisionDependencies = { cognito: CognitoSender; credentials: CredentialStore; generatePassword?: () => string };
export class RuntimeCredentialStore implements CredentialStore {
  constructor(readonly directory: string) {}

  filePath(poolId: string, email: string): string {
    poolIdSchema.parse(poolId); accountSchema.shape.email.parse(email);
    return join(this.directory, `${poolId}-${createHash('sha256').update(email).digest('hex')}.json`);
  }

  private async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
  }

  async get(poolId: string, email: string): Promise<Credential | undefined> {
    await this.prepare();
    try {
      const record = credentialSchema.parse(JSON.parse(await readPrivateFile(this.filePath(poolId, email), 16_384)));
      if (record.userPoolId !== poolId || record.email !== email) throw new Error('Credential identity mismatch.');
      return record;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      if (error instanceof Error && /Unsafe private/.test(error.message)) throw new Error('Unsafe credential file.', { cause: error });
      throw error;
    }
  }

  async put(input: Credential): Promise<void> {
    const credential = credentialSchema.parse(input);
    await this.prepare();
    const target = this.filePath(credential.userPoolId, credential.email);
    // Validate an existing file before replacing it; never follow a symlink.
    await this.get(credential.userPoolId, credential.email);
    await writePrivateJson(target, credential);
  }
}
export const provisionUsers = async (userPoolId: string, accounts: ControlledAccount[], deps?: ProvisionDependencies): Promise<SeedUser[]> => {
  const pool = poolIdSchema.safeParse(userPoolId);
  const parsed = accountsSchema.safeParse(accounts);
  if (!pool.success || !parsed.success) throw new Error('Invalid controlled accounts.');
  const runtime = deps ?? defaultDependencies();
  const seeded: SeedUser[] = [];
  try {
    for (const account of parsed.data) {
      const prior = await runtime.credentials.get(userPoolId, account.email);
      if (prior) {
        credentialSchema.parse(prior);
        if (prior.userPoolId !== userPoolId || prior.email !== account.email) throw new Error('Credential identity mismatch.');
      }
      const credential: Credential = {
        ...account, userPoolId, role: prior?.role === 'clinician' ? 'clinician' : account.role,
        password: prior?.password ?? (runtime.generatePassword ?? generatePassword)(), ...(prior?.sub ? { sub: prior.sub } : {}),
      };
      credentialSchema.parse(credential);
      // Persist before a remote mutation: an uncertain AWS response can safely reuse it.
      if (!prior) await runtime.credentials.put(credential);
      try {
        await runtime.cognito.send(new AdminCreateUserCommand({ UserPoolId: userPoolId, Username: account.email,
          MessageAction: 'SUPPRESS', ForceAliasCreation: false,
          UserAttributes: [{ Name: 'email', Value: account.email }, { Name: 'email_verified', Value: 'true' }],
        }));
      } catch (error) {
        if (!hasName(error, 'UsernameExistsException')) throw error;
      }
      const user = z.object({ Username: z.string().min(1), UserAttributes: z.array(z.object({ Name: z.string(), Value: z.string() })) })
        .parse(await runtime.cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: account.email })));
      const attribute = (name: string): string => {
        const matches = user.UserAttributes.filter((attribute) => attribute.Name === name);
        if (matches.length !== 1) throw new Error('Invalid controlled identity attributes.');
        return matches[0]!.Value;
      };
      const sub = z.uuid().parse(attribute('sub'));
      if (attribute('email') !== account.email || attribute('email_verified') !== 'true' ||
        (prior?.sub && prior.sub !== sub) || seeded.some((user) => user.sub === sub)) throw new Error('Controlled identity mismatch.');
      await runtime.cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: user.Username,
        Password: credential.password, Permanent: true }));
      await runtime.credentials.put({ ...credential, sub });
      seeded.push({ sub, displayName: account.displayName, role: credential.role });
    }
    return seeded;
  } catch { throw new Error('Controlled account provisioning failed.'); }
};

const setupConfigSchema = z.strictObject({ userPoolId: poolIdSchema, migrationFunctionName: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  accounts: accountsSchema, now: z.iso.datetime({ offset: true }) });
export type SetupConfig = z.infer<typeof setupConfigSchema>;
export const setupAwsDatabase = async (config: SetupConfig, deps?: ProvisionDependencies & { invoke: (name: string, payload: MigrationPayload) => Promise<unknown> }): Promise<void> => {
  const parsed = setupConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error('Invalid setup configuration.');
  const runtime = deps ?? { ...defaultDependencies(), invoke: invokeMigration };
  await runtime.invoke(parsed.data.migrationFunctionName, { action: 'migrate' });
  const users = await provisionUsers(parsed.data.userPoolId, parsed.data.accounts, runtime);
  await runtime.invoke(parsed.data.migrationFunctionName, { action: 'seed', users, now: parsed.data.now });
};

const generatePassword = () => `Aa1!${randomBytes(24).toString('base64url')}`;
const defaultDependencies = (): ProvisionDependencies => ({ cognito: new CognitoIdentityProviderClient({}),
  credentials: new RuntimeCredentialStore(fileURLToPath(new URL('../.runtime/', import.meta.url))) });
const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const hasName = (error: unknown, name: string): boolean => typeof error === 'object' && error !== null && 'name' in error && error.name === name;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one setup configuration path.');
    await setupAwsDatabase(JSON.parse(await readPrivateFile(process.argv[2]!)) as SetupConfig);
    process.stdout.write('Private schema and pre-confirmed demo account setup completed. Credentials are in .runtime/.\n');
  } catch {
    process.stderr.write('Private setup failed. Check the controlled configuration and retry; credentials remain in .runtime/.\n');
    process.exitCode = 1;
  }
}
