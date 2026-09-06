import { describe, expect, it } from 'vitest';
import { estimateCost, publishFrontend, runDemo, type DemoDependencies } from '../deploy.js';
import { runPreflight } from '../preflight.js';
import { parseDeploymentManifest } from '../lifecycle-types.js';
import { manifest } from './fakes.js';

const deps = (saved?: typeof manifest): DemoDependencies & { events: string[] } => {
  const events: string[] = [];
  const next = (name: string) => async () => { events.push(name); };
  return {
    events,
    config: {
      account: manifest.account, region: manifest.region, postgresVersion: '17.6',
      qualifier: 'apptdemo', toolkitStack: manifest.toolkitStack, appStack: manifest.appStack,
      projectTag: manifest.projectTag, durationHours: 2, maxCostUsd: 5,
    },
    loadManifest: async () => saved,
    saveManifest: async (value) => { events.push(`save:${value.phase}`); },
    preflight: next('preflight'),
    inspectApplication: async () => { events.push('inspect-application'); return { exists: false, owned: false }; },
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
      regionalCapabilities: async () => { calls.push('regional'); return { postgres: true, instanceClass: true, proxy: true }; },
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
      regionalCapabilities: async () => ({ postgres: true, instanceClass: true, proxy: true }),
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
});
