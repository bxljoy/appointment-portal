import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateCost, publishFrontend, runDemo, type DemoDependencies } from '../deploy.js';
import { runPreflight } from '../preflight.js';
import { DEPLOYMENT_PATH, loadDeploymentManifest, parseDeploymentManifest } from '../lifecycle-types.js';
import { makeAwsDemoDependencies, makeAwsPreflightProbe } from '../aws-lifecycle.js';
import { fakeAwsClients, manifest } from './fakes.js';

const deps = (saved?: typeof manifest): DemoDependencies & { events: string[] } => {
  const events: string[] = [];
  const next = (name: string) => async () => { events.push(name); };
  return {
    events,
    config: {
      account: manifest.account, region: manifest.region, postgresVersion: '17.6',
      qualifier: 'apptdemo', toolkitStack: manifest.toolkitStack, appStack: manifest.appStack,
      projectTag: manifest.projectTag, durationHours: 2, maxCostUsd: 5, sourceCommit: manifest.sourceCommit,
    },
    loadManifest: async () => saved,
    saveManifest: async (value) => { events.push(`save:${value.phase}`); },
    preflight: next('preflight'),
    inspectApplication: async () => { events.push('inspect-application'); return saved ? {
      exists: true, owned: true, phase: saved.phase, outputs: saved.outputs, sourceCommit: 'a'.repeat(40),
    } as never : { exists: false, owned: false }; },
    inspectBootstrap: async () => { events.push('inspect-bootstrap'); return { exists: false, owned: false }; },
    bootstrap: next('bootstrap'),
    deploy: async (phase) => { events.push(`deploy:${phase}`); return {
      ...manifest, phase, outputs: { ...manifest.outputs, FrontendUrl: 'https://demo.cloudfront.net' },
    }; },
    migrate: next('migrate'), provision: next('provision'), waitForProxy: next('wait-proxy'),
    verifyMigration: next('verify-migration'), publish: next('publish'), verify: next('verify'),
  };
};

describe('disposable deployment lifecycle', () => {
  it('rejects credential-like fields in deployment outputs', () => {
    expect(() => parseDeploymentManifest({ ...manifest, outputs: { ...manifest.outputs, DatabasePassword: 'must-not-persist' } })).toThrow();
  });

  it('performs read-only account, regional capability, runtime, quota and cost checks', async () => {
    const calls: string[] = [];
    const report = await runPreflight({
      account: manifest.account, region: manifest.region, postgresVersion: '17.6',
      durationHours: 2, maxCostUsd: 3,
    }, {
      identity: async () => { calls.push('identity'); return manifest.account; },
      regionalCapabilities: async () => { calls.push('regional'); return { postgres: true, instanceClass: true, proxyApiReachable: true }; },
      unreservedConcurrency: async () => { calls.push('quota'); return 116; },
      runtimeVersions: async () => { calls.push('runtime'); return { node: '24.0.1', pnpm: '11.22.0', docker: '28.0.0' }; },
      gitClean: async () => { calls.push('git'); return true; },
      costRates: async () => { calls.push('prices'); return {
        databaseHourly: 0.1, proxyVcpuHourly: 0.03, databaseVcpus: 2, interfaceEndpointAzHourly: 0.01,
        azCount: 2, cognito: 0.01, logging: 0.01, storage: 0.01, transfer: 0.01,
      }; },
    });
    expect(calls).toEqual(['identity', 'regional', 'quota', 'runtime', 'git', 'prices']);
    expect(report.reservedConcurrencyRequired).toBe(16);
    expect(report.cost.allowed).toBe(true);
  });

  it('rejects a quota that cannot reserve 16 executions while leaving 100 unreserved', async () => {
    await expect(runPreflight({
      account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 2, maxCostUsd: 3,
    }, {
      identity: async () => manifest.account,
      regionalCapabilities: async () => ({ postgres: true, instanceClass: true, proxyApiReachable: true }),
      unreservedConcurrency: async () => 115,
      runtimeVersions: async () => ({ node: '24.0.1', pnpm: '11.22.0', docker: '28.0.0' }),
      gitClean: async () => true,
      costRates: async () => ({ databaseHourly: 0, proxyVcpuHourly: 0, databaseVcpus: 2, interfaceEndpointAzHourly: 0, azCount: 2,
        cognito: 0, logging: 0, storage: 0, transfer: 0 }),
    })).rejects.toThrow(/concurrency/i);
  });

  it('runs a new deployment in two phases and persists both successful phases', async () => {
    const fake = deps();
    await runDemo(fake);
    expect(fake.events).toEqual([
      'preflight', 'inspect-application', 'inspect-bootstrap', 'bootstrap', 'deploy:bootstrap', 'save:bootstrap',
      'migrate', 'provision', 'wait-proxy', 'deploy:ready', 'wait-proxy',
      'verify-migration', 'save:ready', 'publish', 'verify',
    ]);
  });

  it('resumes a ready deployment without restoring bootstrap database authentication', async () => {
    const fake = deps(manifest);
    await runDemo(fake);
    expect(fake.events).toEqual([
      'preflight', 'inspect-application', 'migrate', 'provision', 'wait-proxy', 'deploy:ready', 'wait-proxy',
      'verify-migration', 'save:ready', 'publish', 'verify',
    ]);
    expect(fake.events).not.toContain('deploy:bootstrap');
  });

  it('restores a live ready stack before use when the local manifest is missing', async () => {
    const fake = deps();
    fake.inspectApplication = async () => ({
      exists: true, owned: true, phase: 'ready', sourceCommit: 'a'.repeat(40),
      outputs: { ...manifest.outputs, MigrationFunctionName: 'migration', UserPoolId: 'eu-north-1_fixture' },
    } as never);
    await runDemo(fake);
    expect(fake.events).not.toContain('deploy:bootstrap');
    expect(fake.events.indexOf('save:ready')).toBeLessThan(fake.events.indexOf('migrate'));
  });

  it('refuses a saved ready manifest when the live application stack is absent', async () => {
    const fake = deps(manifest);
    fake.inspectApplication = async () => ({ exists: false, owned: false });
    await expect(runDemo(fake)).rejects.toThrow(/live.*absent|missing.*live/i);
    expect(fake.events).not.toContain('migrate');
  });

  it('resumes a partial bootstrap by redeploying bootstrap mode before migration', async () => {
    const partial = { ...manifest, phase: 'bootstrap' as const, outputs: {} };
    const fake = deps(partial);
    await runDemo(fake);
    expect(fake.events.slice(0, 5)).toEqual(['preflight', 'inspect-application', 'deploy:bootstrap', 'save:bootstrap', 'migrate']);
  });

  it('refuses to adopt an application stack whose ownership is not established', async () => {
    const fake = deps();
    fake.inspectApplication = async () => { fake.events.push('inspect-application'); return { exists: true, owned: false }; };
    await expect(runDemo(fake)).rejects.toThrow(/adopt.*application/i);
    expect(fake.events).toEqual(['preflight', 'inspect-application']);
  });

  it('stops before ready deployment and publication when migration fails', async () => {
    const fake = deps();
    fake.migrate = async () => { fake.events.push('migrate'); throw new Error('migration failed'); };
    await expect(runDemo(fake)).rejects.toThrow('migration failed');
    expect(fake.events).not.toContain('deploy:ready');
    expect(fake.events).not.toContain('publish');
  });

  it('refuses to publish when the deployed callback origin differs from CloudFront', async () => {
    const uploads: string[] = [];
    await expect(publishFrontend({
      frontendUrl: 'https://actual.cloudfront.net',
      callbackUrl: 'https://wrong.cloudfront.net/auth/callback',
      publicConfig: {
        mode: 'cognito', issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_example',
        clientId: 'public-client-id', cognitoDomain: 'https://example.auth.eu-north-1.amazoncognito.com', apiBaseUrl: '/api',
      },
      files: [{ key: 'assets/app-a1b2.js', body: new Uint8Array([1]), contentType: 'text/javascript' }],
    }, {
      upload: async (entry) => { uploads.push(entry.key); },
      invalidate: async () => 'invalidation', waitInvalidation: async () => {},
    })).rejects.toThrow(/callback/i);
    expect(uploads).toEqual([]);
  });

  it('uploads immutable hashed assets before no-cache config and shell, then waits for invalidation', async () => {
    const events: string[] = [];
    await publishFrontend({
      frontendUrl: 'https://demo.cloudfront.net',
      callbackUrl: 'https://demo.cloudfront.net/auth/callback',
      publicConfig: {
        mode: 'cognito', issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_example',
        clientId: 'public-client-id', cognitoDomain: 'https://example.auth.eu-north-1.amazoncognito.com', apiBaseUrl: '/api',
      },
      files: [
        { key: 'index.html', body: new Uint8Array([2]), contentType: 'text/html' },
        { key: 'assets/app-a1b2.js', body: new Uint8Array([1]), contentType: 'text/javascript' },
      ],
    }, {
      upload: async (entry) => { events.push(`upload:${entry.key}:${entry.cacheControl}`); },
      invalidate: async (paths) => { events.push(`invalidate:${paths.join(',')}`); return 'inv-1'; },
      waitInvalidation: async (id) => { events.push(`wait:${id}`); },
    });
    expect(events).toEqual([
      'upload:assets/app-a1b2.js:public, max-age=31536000, immutable',
      'upload:config.json:no-cache, max-age=0, must-revalidate',
      'upload:index.html:no-cache, max-age=0, must-revalidate',
      'invalidate:/,/index.html,/config.json', 'wait:inv-1',
    ]);
  });

  it('checks every estimated charge against the user supplied execution cap', () => {
    const result = estimateCost({ durationHours: 2, capUsd: 3, rates: {
      databaseHourly: 0.10, proxyVcpuHourly: 0.03, databaseVcpus: 2, interfaceEndpointAzHourly: 0.01,
      azCount: 2, cognito: 0.01, logging: 0.02, storage: 0.01, transfer: 0.02,
    } });
    expect(result.components.map((item) => item.name)).toEqual([
      'database', 'rdsProxyMinimum', 'interfaceEndpoints', 'cognito', 'logging', 'storage', 'transfer',
    ]);
    expect(result.components.find((item) => item.name === 'rdsProxyMinimum')?.usd).toBeCloseTo(0.12);
    expect(result.allowed).toBe(true);
    expect(estimateCost({ ...result.input, capUsd: 0.01 }).allowed).toBe(false);
  });

  it('rejects a price report whose timestamp is meaningfully in the future', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portal-future-price-'));
    try {
      const priceReport = join(root, 'prices.json');
      await writeFile(priceReport, JSON.stringify({
        checkedAt: '2099-01-01T00:00:00Z', region: manifest.region, currency: 'USD',
        sources: ['https://aws.amazon.com/rds/pricing/', 'https://aws.amazon.com/rds/proxy/pricing/'],
        assumptions: 'A short disposable verification deployment.',
        rates: { databaseHourly: 0, proxyVcpuHourly: 0, databaseVcpus: 2, interfaceEndpointAzHourly: 0,
          azCount: 2, cognito: 0, logging: 0, storage: 0, transfer: 0 },
      }));
      const probe = makeAwsPreflightProbe({ account: manifest.account, region: manifest.region, postgresVersion: '17.6',
        durationHours: 1, maxCostUsd: 1, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: priceReport, priceReport }, fakeAwsClients());
      await expect(probe.costRates({ region: manifest.region, postgresVersion: '17.6' })).rejects.toThrow(/future/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('maps exactly four controlled aliases to deterministic private credential files for AWS Playwright', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portal-four-accounts-'));
    try {
      const accountsFile = join(root, 'accounts.json');
      await writeFile(accountsFile, JSON.stringify([
        { alias: 'patient-a', email: 'patient-a@example.com', displayName: 'Alice Patient', role: 'patient' },
        { alias: 'patient-b', email: 'patient-b@example.com', displayName: 'Bea Patient', role: 'patient' },
        { alias: 'clinician-a', email: 'clinician-a@example.com', displayName: 'Casey Clinician', role: 'clinician' },
        { alias: 'clinician-b', email: 'clinician-b@example.com', displayName: 'Devon Clinician', role: 'clinician' },
      ]));
      const calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
      const runtime = makeAwsDemoDependencies({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
        maxCostUsd: 1, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile, priceReport: accountsFile }, fakeAwsClients(),
      async (_executable, args, options) => { calls.push({ args, env: options?.env }); return { stdout: '', stderr: '' }; });
      await runtime.verify({ ...manifest, outputs: { ...manifest.outputs, UserPoolId: 'eu-north-1_fixture' } });
      const environment = calls[0]!.env!;
      const keys = ['PORTAL_E2E_PATIENT_A_FILE', 'PORTAL_E2E_PATIENT_B_FILE', 'PORTAL_E2E_CLINICIAN_A_FILE', 'PORTAL_E2E_CLINICIAN_B_FILE'];
      expect(keys.map((key) => environment[key])).toHaveLength(4);
      expect(new Set(keys.map((key) => environment[key])).size).toBe(4);
      for (const key of keys) expect(environment[key]).toMatch(/\.runtime\/credentials\/[a-zA-Z0-9_-]+-[a-f0-9]{64}\.json$/);
      expect(JSON.stringify(calls)).not.toContain('password');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requests S3 checksums and reuses an unchanged immutable frontend asset', async () => {
    const frontend = 'https://demo.cloudfront.net';
    const clients = fakeAwsClients({
      DescribeUserPoolClientCommand: [{ UserPoolClient: { CallbackURLs: [`${frontend}/auth/callback`] } }],
      CreateInvalidationCommand: [{ Invalidation: { Id: 'invalidation-1' } }, { Invalidation: { Id: 'invalidation-2' } }],
      GetInvalidationCommand: [{ Invalidation: { Status: 'Completed' } }, { Invalidation: { Status: 'Completed' } }],
    });
    const stored = new Map<string, string>();
    const s3Send = clients.s3.send.bind(clients.s3);
    clients.s3.send = (async (command: { constructor: { name: string }; input: { Key?: string; ChecksumSHA256?: string; ChecksumMode?: string } }) => {
      if (command.constructor.name === 'HeadObjectCommand') {
        expect(command.input.ChecksumMode).toBe('ENABLED');
        const checksum = stored.get(command.input.Key!);
        if (!checksum) throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
        return { ChecksumSHA256: checksum };
      }
      if (command.constructor.name === 'PutObjectCommand') stored.set(command.input.Key!, command.input.ChecksumSHA256!);
      return s3Send(command as never);
    }) as never;
    const runtime = makeAwsDemoDependencies({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
      maxCostUsd: 1, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: '/unused', priceReport: '/unused' }, clients);
    const deployed = { ...manifest, outputs: { FrontendUrl: frontend, UserPoolId: 'eu-north-1_fixture', ClientId: 'client',
      Issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_fixture', CognitoDomain: 'https://fixture.auth.eu-north-1.amazoncognito.com',
      WebBucketName: 'bucket', DistributionId: 'distribution' } };
    await runtime.publish(deployed);
    const firstImmutablePuts = clients.commands.filter((command) => command.constructor.name === 'PutObjectCommand' &&
      (command as { input: { Key?: string } }).input.Key?.startsWith('assets/'));
    await runtime.publish(deployed);
    const immutablePuts = clients.commands.filter((command) => command.constructor.name === 'PutObjectCommand' &&
      (command as { input: { Key?: string } }).input.Key?.startsWith('assets/'));
    expect(immutablePuts).toHaveLength(firstImmutablePuts.length);
    expect(firstImmutablePuts.length).toBeGreaterThan(0);
  });

  it('persists a minimal recovery manifest before output parsing can fail after deployment', async () => {
    let prior: string | undefined;
    try { prior = await readFile(DEPLOYMENT_PATH, 'utf8'); } catch { prior = undefined; }
    await mkdir(new URL('../../.runtime/', import.meta.url), { recursive: true, mode: 0o700 });
    await rm(DEPLOYMENT_PATH, { force: true });
    await writeFile(new URL('../../.runtime/cdk-outputs.json', import.meta.url), '{broken', { mode: 0o600 });
    try {
      const clients = fakeAwsClients({ DescribeStacksCommand: [{ Stacks: [{ Tags: [
        { Key: 'Project', Value: manifest.projectTag }, { Key: 'SourceCommit', Value: 'a'.repeat(40) },
      ], Parameters: [{ ParameterKey: 'DeploymentPhase', ParameterValue: 'bootstrap' }],
      Outputs: [{ OutputKey: 'FrontendUrl', OutputValue: manifest.outputs.FrontendUrl }] }] }] });
      const runtime = makeAwsDemoDependencies({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
        maxCostUsd: 1, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: '/unused', priceReport: '/unused' }, clients,
      async () => ({ stdout: '', stderr: '' }));
      await expect(runtime.deploy('bootstrap')).rejects.toThrow();
      await expect(loadDeploymentManifest()).resolves.toMatchObject({ phase: 'bootstrap', outputs: { FrontendUrl: manifest.outputs.FrontendUrl } });
    } finally {
      if (prior === undefined) await rm(DEPLOYMENT_PATH, { force: true });
      else await writeFile(DEPLOYMENT_PATH, prior, { mode: 0o600 });
    }
  });

  it('keeps the minimal recovery manifest when later resource inventory fails', async () => {
    let prior: string | undefined;
    try { prior = await readFile(DEPLOYMENT_PATH, 'utf8'); } catch { prior = undefined; }
    await mkdir(new URL('../../.runtime/', import.meta.url), { recursive: true, mode: 0o700 });
    await rm(DEPLOYMENT_PATH, { force: true });
    await writeFile(new URL('../../.runtime/cdk-outputs.json', import.meta.url), JSON.stringify({ [manifest.appStack]: manifest.outputs }), { mode: 0o600 });
    try {
      const clients = fakeAwsClients({ DescribeStacksCommand: [{ Stacks: [{ Tags: [
        { Key: 'Project', Value: manifest.projectTag }, { Key: 'DeploymentPhase', Value: 'bootstrap' }, { Key: 'SourceCommit', Value: 'a'.repeat(40) },
      ], Outputs: [{ OutputKey: 'FrontendUrl', OutputValue: manifest.outputs.FrontendUrl }] }] }] });
      clients.cloudformation.send = async (command: object) => {
        if (command.constructor.name === 'DescribeStacksCommand') return { Stacks: [{ Tags: [
          { Key: 'Project', Value: manifest.projectTag }, { Key: 'DeploymentPhase', Value: 'bootstrap' }, { Key: 'SourceCommit', Value: 'a'.repeat(40) },
        ], Outputs: [{ OutputKey: 'FrontendUrl', OutputValue: manifest.outputs.FrontendUrl }] }] } as never;
        throw new Error('inventory unavailable');
      };
      const runtime = makeAwsDemoDependencies({ account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 1,
        maxCostUsd: 1, repository: 'OWNER/REPOSITORY', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: '/unused', priceReport: '/unused' }, clients,
      async () => ({ stdout: '', stderr: '' }));
      await expect(runtime.deploy('bootstrap')).rejects.toThrow('inventory unavailable');
      await expect(loadDeploymentManifest()).resolves.toMatchObject({ phase: 'bootstrap' });
    } finally {
      if (prior === undefined) await rm(DEPLOYMENT_PATH, { force: true });
      else await writeFile(DEPLOYMENT_PATH, prior, { mode: 0o600 });
    }
  });
});
