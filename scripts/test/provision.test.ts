import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdminCreateUserCommand, AdminGetUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { expect, test, vi } from 'vitest';
import { invokeMigration } from '../invoke-migration.js';
import { provisionUsers, RuntimeCredentialStore, setupAwsDatabase, type Credential, type ControlledAccount } from '../provision.js';

const userPoolId = 'eu-north-1_Controlled';
const now = '2030-06-01T09:00:00Z';
const accounts: ControlledAccount[] = [{ email: 'clinician@example.com', displayName: 'Demo Clinician', role: 'clinician' },
  { email: 'patient@example.com', displayName: 'Demo Patient', role: 'patient' }];
const sub = (email: string) => email.startsWith('clinician') ? 'd4000000-0000-4000-8000-000000000001' : 'd4000000-0000-4000-8000-000000000002';
const setup = () => {
  const saved = new Map<string, Credential>();
  const users = new Map<string, { Username: string; UserAttributes: { Name: string; Value: string }[] }>();
  const order: string[] = [];
  const credentials = { get: vi.fn(async (_pool: string, email: string) => saved.get(email)),
    put: vi.fn(async (entry: Credential) => { order.push('persist'); saved.set(entry.email, { ...entry }); }) };
  const cognito = { send: vi.fn(async (command: AdminCreateUserCommand | AdminGetUserCommand | AdminSetUserPasswordCommand) => {
    const email = command.input.Username!;
    if (command instanceof AdminCreateUserCommand) {
      order.push('create');
      if (users.has(email)) throw Object.assign(new Error('already exists'), { name: 'UsernameExistsException' });
      users.set(email, { Username: `generated-username-${users.size}`, UserAttributes: [
        { Name: 'sub', Value: sub(email) }, { Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' },
      ] });
      return { User: { Username: 'do-not-use-this-as-sub' } };
    }
    if (command instanceof AdminGetUserCommand) { order.push('get'); return users.get(email); }
    order.push('password'); return {};
  }) };
  return { credentials, cognito, generatePassword: vi.fn(() => 'Only-in-memory-password!234'), saved, users, order };
};

test('creates pre-confirmed controlled accounts without messages and seeds the retrieved sub only', async () => {
  const deps = setup();
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')];
  try {
    await expect(provisionUsers(userPoolId, accounts, deps)).resolves.toEqual(accounts.map((account) => ({ sub: sub(account.email), displayName: account.displayName, role: account.role })));
    expect(deps.order).toEqual(['persist', 'create', 'get', 'password', 'persist', 'persist', 'create', 'get', 'password', 'persist']);
    const commands = deps.cognito.send.mock.calls.map(([command]) => command);
    for (let index = 0; index < accounts.length; index++) {
      expect(commands[index * 3]).toBeInstanceOf(AdminCreateUserCommand);
      expect(commands[index * 3]!.input).toEqual({ UserPoolId: userPoolId, Username: accounts[index]!.email,
        MessageAction: 'SUPPRESS', ForceAliasCreation: false,
        UserAttributes: [{ Name: 'email', Value: accounts[index]!.email }, { Name: 'email_verified', Value: 'true' }] });
      expect(commands[index * 3 + 1]).toBeInstanceOf(AdminGetUserCommand);
      expect(commands[index * 3 + 2]).toBeInstanceOf(AdminSetUserPasswordCommand);
      expect(commands[index * 3 + 2]!.input).toEqual({ UserPoolId: userPoolId, Username: `generated-username-${index}`,
        Password: 'Only-in-memory-password!234', Permanent: true });
    }
    expect(deps.saved.get(accounts[0]!.email)).toMatchObject({ sub: sub(accounts[0]!.email), userPoolId });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally { logs.forEach((log) => log.mockRestore()); }
});

test('recovers after an uncertain password failure using the stored password and the same existing identity', async () => {
  const deps = setup();
  const send = deps.cognito.send.getMockImplementation()!;
  let failed = false;
  deps.cognito.send.mockImplementation(async (command) => {
    if (command instanceof AdminSetUserPasswordCommand && !failed) { failed = true; throw new Error('raw password sentinel'); }
    return send(command);
  });
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).rejects.toThrow('Controlled account provisioning failed.');
  expect(deps.saved.get(accounts[0]!.email)?.password).toBe('Only-in-memory-password!234');
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).resolves.toEqual([{ sub: sub(accounts[0]!.email), displayName: accounts[0]!.displayName, role: 'clinician' }]);
  expect(deps.users.size).toBe(1); expect(deps.generatePassword).toHaveBeenCalledOnce();
  await expect(provisionUsers(userPoolId, [{ ...accounts[0]!, role: 'patient' }], deps)).resolves.toMatchObject([{ role: 'clinician' }]);
});

test('recovers an uncertain creation response and never creates before the password is safely stored', async () => {
  const deps = setup();
  deps.credentials.put.mockRejectedValueOnce(new Error('disk full raw secret'));
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).rejects.toThrow('Controlled account provisioning failed.');
  expect(deps.cognito.send).not.toHaveBeenCalled();
  const send = deps.cognito.send.getMockImplementation()!;
  let uncertain = true;
  deps.cognito.send.mockImplementation(async (command) => {
    const response = await send(command);
    if (command instanceof AdminCreateUserCommand && uncertain) { uncertain = false; throw new Error('timeout after create'); }
    return response;
  });
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).rejects.toThrow('Controlled account provisioning failed.');
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).resolves.toMatchObject([{ sub: sub(accounts[0]!.email) }]);
  expect(deps.users.size).toBe(1);
});

test.each([
  [{ ...accounts[0], email: 'not-email' }], [{ ...accounts[0], email: ' clinician@example.com' }],
  [{ ...accounts[0], displayName: ' ' }], [{ ...accounts[0], displayName: 'bad\nname' }],
  [{ ...accounts[0], role: 'admin' }], [{ ...accounts[0], sub: 'forged-sub' }],
  [{ ...accounts[0], password: 'forged-password' }], [accounts[0], accounts[0]], [],
].map((input) => ({ input })))('validates the entire exact controlled account list before side effects: %j', async ({ input }) => {
  const deps = setup();
  await expect(provisionUsers(userPoolId, input as ControlledAccount[], deps)).rejects.toThrow('Invalid controlled accounts.');
  expect(deps.cognito.send).not.toHaveBeenCalled(); expect(deps.credentials.put).not.toHaveBeenCalled();
});

test.each(['missing-sub', 'mismatched-sub', 'wrong-email', 'unverified', 'duplicate-sub'])('refuses Cognito identity mismatch %s before assigning a password or returning seed users', async (failure) => {
  const deps = setup();
  const send = deps.cognito.send.getMockImplementation()!;
  if (failure === 'mismatched-sub') deps.saved.set(accounts[0]!.email, { ...accounts[0]!, userPoolId, password: 'Stored-password!234', sub: sub(accounts[1]!.email) });
  deps.cognito.send.mockImplementation(async (command) => {
    const result = await send(command);
    if (command instanceof AdminGetUserCommand && result && 'UserAttributes' in result) {
      const attrs = result.UserAttributes;
      if (failure === 'missing-sub') result.UserAttributes = attrs.filter((attr) => attr.Name !== 'sub');
      if (failure === 'wrong-email') attrs.find((attr) => attr.Name === 'email')!.Value = 'other@example.com';
      if (failure === 'unverified') attrs.find((attr) => attr.Name === 'email_verified')!.Value = 'false';
      if (failure === 'duplicate-sub') attrs.push({ Name: 'sub', Value: sub(accounts[1]!.email) });
    }
    return result;
  });
  await expect(provisionUsers(userPoolId, [accounts[0]!], deps)).rejects.toThrow('Controlled account provisioning failed.');
  expect(deps.cognito.send.mock.calls.some(([command]) => command instanceof AdminSetUserPasswordCommand)).toBe(false);
});

test('persists credentials atomically with mode 0600 under the ignored runtime directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-credentials-'));
  try {
    const store = new RuntimeCredentialStore(directory);
    const record = { ...accounts[0]!, userPoolId, password: 'Runtime-secret!234' };
    await store.put(record); await store.put({ ...record, sub: sub(record.email) });
    const files = await readdir(directory); expect(files).toHaveLength(1);
    const file = join(directory, files[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(store.get(userPoolId, record.email)).resolves.toEqual({ ...record, sub: sub(record.email) });
    expect(await readFile(new URL('../../.gitignore', import.meta.url), 'utf8')).toContain('.runtime/');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses symlinked credential directories and never overwrites the external target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-credential-symlink-'));
  try {
    const target = join(root, 'target'); await writeFile(target, 'unchanged');
    const alias = join(root, 'alias'); await symlink(target, alias);
    await expect(new RuntimeCredentialStore(alias).put({ ...accounts[0]!, userPoolId, password: 'Runtime-secret!234' })).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses symlinked and permissive existing credential files on reads and writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portal-credential-file-'));
  try {
    const store = new RuntimeCredentialStore(directory);
    const record = { ...accounts[0]!, userPoolId, password: 'Runtime-secret!234' };
    await store.put(record);
    const file = join(directory, (await readdir(directory))[0]!);
    await chmod(file, 0o644);
    await expect(store.get(userPoolId, record.email)).rejects.toThrow('Unsafe credential file.');
    await expect(store.put(record)).rejects.toThrow('Unsafe credential file.');
    await chmod(file, 0o600);
    const target = join(directory, 'target'); await writeFile(target, 'unchanged');
    await rm(file); await symlink(target, file);
    await expect(store.get(userPoolId, record.email)).rejects.toThrow();
    await expect(store.put(record)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('setup invokes migrate before Cognito and seeds only after every controlled identity is ready', async () => {
  const deps = setup();
  const invoke = vi.fn(async (_name: string, payload: { action: string }) => { deps.order.push(payload.action); });
  await setupAwsDatabase({ userPoolId, migrationFunctionName: 'private-migration', accounts, now }, { ...deps, invoke });
  expect(deps.order[0]).toBe('migrate'); expect(deps.order.at(-1)).toBe('seed');
  expect(invoke.mock.calls).toEqual([['private-migration', { action: 'migrate' }], ['private-migration', {
    action: 'seed', users: accounts.map((account) => ({ sub: sub(account.email), displayName: account.displayName, role: account.role })), now,
  }]]);
});

test('a failed migration prevents all identity side effects and a failed seed can be safely retried', async () => {
  const deps = setup();
  const config = { userPoolId, migrationFunctionName: 'private-migration', accounts, now };
  const invoke = vi.fn().mockRejectedValueOnce(new Error('private migration failed'));
  await expect(setupAwsDatabase(config, { ...deps, invoke })).rejects.toThrow();
  expect(deps.cognito.send).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private seed failed'));
  await expect(setupAwsDatabase(config, { ...deps, invoke })).rejects.toThrow();
  expect(deps.users.size).toBe(2);
  invoke.mockResolvedValue(undefined);
  await setupAwsDatabase(config, { ...deps, invoke });
  expect(deps.users.size).toBe(2); expect(deps.generatePassword).toHaveBeenCalledTimes(2);
});

test.each([
  { StatusCode: 200, FunctionError: 'Unhandled', Payload: Buffer.from('{"ok":true,"appliedMigrations":[]}') },
  { StatusCode: 200, Payload: Buffer.from('{"ok":false,"error":"raw password"}') },
  { StatusCode: 202, Payload: Buffer.from('{"ok":true,"appliedMigrations":[]}') },
  { StatusCode: 200, Payload: Buffer.from('not-json raw password') },
  { StatusCode: 200, Payload: Buffer.from('{"ok":true}') },
  { StatusCode: 200, Payload: Buffer.from('{"ok":true,"appliedMigrations":[],"secret":"raw password"}') },
  { StatusCode: 200 },
])('rejects transport/function/payload failures without reflecting the raw result %j', async (response) => {
  await expect(invokeMigration('private-migration', { action: 'migrate' }, { send: vi.fn().mockResolvedValue(response) }))
    .rejects.toThrow('Private setup invocation failed.');
});

test('invokes synchronously without requesting tail logs and parses the exact successful response', async () => {
  const send = vi.fn().mockResolvedValue({ StatusCode: 200, Payload: Buffer.from('{"ok":true,"appliedMigrations":["001_initial.sql"]}') });
  await expect(invokeMigration('private-migration', { action: 'migrate' }, { send })).resolves.toEqual({ ok: true, appliedMigrations: ['001_initial.sql'] });
  expect(send.mock.calls[0]![0].input).toEqual({ FunctionName: 'private-migration', InvocationType: 'RequestResponse',
    Payload: Buffer.from('{"action":"migrate"}') });
});

test('validates invocation payloads before calling AWS and sanitizes SDK rejections', async () => {
  const send = vi.fn().mockRejectedValue(new Error('raw credentials from SDK'));
  await expect(invokeMigration('private-migration', { action: 'migrate', password: 'extra' } as never, { send })).rejects.toThrow('Invalid setup invocation.');
  expect(send).not.toHaveBeenCalled();
  await expect(invokeMigration('private-migration', { action: 'migrate' }, { send })).rejects.toThrow('Private setup invocation failed.');
});
