import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadDeploymentManifest, saveDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
export { publishFrontend } from './publish.js';

export type DemoConfig = {
  account: string; region: string; postgresVersion: string; qualifier: 'apptdemo';
  toolkitStack: 'AppointmentPortalToolkit'; appStack: 'AppointmentPortal'; projectTag: 'appointment-portal';
  deliveryStack?: 'AppointmentPortalDelivery';
  durationHours: number; maxCostUsd: number;
  lambdaConcurrencyMode?: 'reserved' | 'shared-unreserved';
  sourceCommit?: string;
  expiresAt?: string;
  repository?: string;
  branch?: string;
};
export type StackInspection = { exists: boolean; owned: boolean; phase?: 'bootstrap' | 'ready'; outputs?: Record<string, string>; sourceCommit?: string; status?: string };
export type DemoDependencies = {
  config: DemoConfig;
  loadManifest(): Promise<DeploymentManifest | undefined>;
  saveManifest(manifest: DeploymentManifest): Promise<void>;
  preflight(): Promise<void>;
  inspectApplication(): Promise<StackInspection>;
  inspectBootstrap(): Promise<StackInspection>;
  bootstrap(): Promise<void>;
  deploy(phase: 'bootstrap' | 'ready', frontendUrl?: string): Promise<DeploymentManifest>;
  migrate(): Promise<void>;
  provision(): Promise<void>;
  waitForProxy(): Promise<void>;
  verifyMigration(): Promise<void>;
  probeApplication(manifest: DeploymentManifest): Promise<void>;
  publish(manifest: DeploymentManifest): Promise<void>;
  verify(manifest: DeploymentManifest): Promise<void>;
};

export const runDemo = async (deps: DemoDependencies): Promise<DeploymentManifest> => {
  await deps.preflight();
  const application = await deps.inspectApplication();
  if (application.exists && !application.owned) {
    throw new Error('Refusing to adopt an existing application stack without established ownership.');
  }
  let saved = await deps.loadManifest();
  assertSavedTarget(saved, deps.config);
  if (application.exists && deps.config.sourceCommit && application.sourceCommit !== deps.config.sourceCommit) {
    throw new Error('Live application stack source commit does not match this checkout.');
  }
  if (application.exists && deps.config.expiresAt && application.outputs?.ExpiresAt !== deps.config.expiresAt) {
    throw new Error('Live application stack expiry does not match the configured maximum lifetime.');
  }
  if (saved?.phase === 'ready' && !application.exists) throw new Error('Saved ready deployment is missing from the live account.');
  if (saved?.phase === 'bootstrap' && !application.exists) saved = undefined;
  if (application.exists && saved?.phase === 'ready' && application.phase !== 'ready') throw new Error('Live stack phase conflicts with the saved ready manifest.');
  if (application.exists && (!saved || application.phase === 'ready' && saved.phase !== 'ready')) {
    if (!application.phase || !application.outputs) throw new Error('Live application stack lacks recoverable phase or outputs.');
    const recovered: DeploymentManifest = {
      account: deps.config.account, region: deps.config.region, projectTag: deps.config.projectTag,
      appStack: deps.config.appStack, toolkitStack: deps.config.toolkitStack, qualifier: deps.config.qualifier,
      ...(deps.config.deliveryStack ? { deliveryStack: deps.config.deliveryStack } : {}),
      phase: application.phase, outputs: application.outputs, resources: [],
      ...(deps.config.sourceCommit ? { sourceCommit: deps.config.sourceCommit } : {}),
      ...(deps.config.expiresAt ? { expiresAt: deps.config.expiresAt } : {}),
      ...(deps.config.repository ? { repository: deps.config.repository } : {}), ...(deps.config.branch ? { branch: deps.config.branch } : {}),
    };
    await deps.saveManifest(recovered);
    saved = recovered;
  }
  let bootstrapManifest: DeploymentManifest;
  if (saved?.phase === 'ready') {
    bootstrapManifest = saved;
  } else if (saved?.phase === 'bootstrap') {
    if (saved.outputs.FrontendUrl && saved.outputs.MigrationFunctionName && saved.outputs.UserPoolId) {
      bootstrapManifest = saved;
    } else {
      bootstrapManifest = await deps.deploy('bootstrap');
      await deps.saveManifest(bootstrapManifest);
    }
  } else {
    const toolkit = await deps.inspectBootstrap();
    if (toolkit.exists && !toolkit.owned) throw new Error('Refusing to adopt an existing bootstrap stack without established ownership.');
    if (!toolkit.exists) await deps.bootstrap();
    bootstrapManifest = await deps.deploy('bootstrap');
    await deps.saveManifest(bootstrapManifest);
  }

  await deps.migrate();
  await deps.provision();
  await deps.waitForProxy();
  const ready = await deps.deploy('ready', requiredOutput(bootstrapManifest, 'FrontendUrl'));
  await deps.waitForProxy();
  await deps.verifyMigration();
  await deps.saveManifest(ready);
  await deps.probeApplication(ready);
  await deps.publish(ready);
  await deps.verify(ready);
  return ready;
};

const assertSavedTarget = (manifest: DeploymentManifest | undefined, config: DemoConfig): void => {
  if (!manifest) return;
  if (manifest.account !== config.account || manifest.region !== config.region || manifest.qualifier !== config.qualifier ||
    manifest.appStack !== config.appStack || manifest.toolkitStack !== config.toolkitStack || manifest.projectTag !== config.projectTag ||
    config.sourceCommit !== undefined && manifest.sourceCommit !== config.sourceCommit ||
    config.expiresAt !== undefined && manifest.expiresAt !== config.expiresAt ||
    config.repository !== undefined && manifest.repository !== config.repository || config.branch !== undefined && manifest.branch !== config.branch) {
    throw new Error('Saved deployment manifest does not match the requested target.');
  }
};

const requiredOutput = (manifest: DeploymentManifest, name: string): string => {
  const output = manifest.outputs[name];
  if (!output) throw new Error(`Deployment output ${name} is missing.`);
  return output;
};

export type CostRates = {
  databaseHourly: number; proxyVcpuHourly: number; databaseVcpus: number; interfaceEndpointAzHourly: number; azCount: number;
  cognito: number; logging: number; storage: number; transfer: number;
};
export type CostInput = { durationHours: number; capUsd: number; rates: CostRates };
export const estimateCost = (input: CostInput) => {
  const duration = z.number().positive().max(6).parse(input.durationHours);
  const cap = z.number().nonnegative().parse(input.capUsd);
  const rates = z.object({
    databaseHourly: z.number().nonnegative(), proxyVcpuHourly: z.number().nonnegative(), databaseVcpus: z.number().int().positive().max(128),
    interfaceEndpointAzHourly: z.number().nonnegative(), azCount: z.number().int().min(2).max(3),
    cognito: z.number().nonnegative(), logging: z.number().nonnegative(), storage: z.number().nonnegative(), transfer: z.number().nonnegative(),
  }).parse(input.rates);
  const components = [
    { name: 'database', usd: rates.databaseHourly * duration },
    // RDS Proxy is billed per vCPU and has a ten-minute minimum per billable status change.
    { name: 'rdsProxyMinimum', usd: rates.proxyVcpuHourly * rates.databaseVcpus * Math.max(duration, 1 / 6) },
    { name: 'interfaceEndpoints', usd: rates.interfaceEndpointAzHourly * rates.azCount * duration },
    { name: 'cognito', usd: rates.cognito }, { name: 'logging', usd: rates.logging },
    { name: 'storage', usd: rates.storage }, { name: 'transfer', usd: rates.transfer },
  ];
  const totalUsd = components.reduce((sum, component) => sum + component.usd, 0);
  return { input, components, totalUsd, allowed: totalUsd <= cap };
};

export const deploymentCompletionMessage = (frontendUrl: string): string =>
  `Automated deployment verification passed for ${frontendUrl}; manual Cognito registration and recovery evidence may still be pending.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime deployment configuration path.');
    const { makeAwsDemoDependencies, readAwsDemoInput } = await import('./aws-lifecycle.js');
    const config = await readAwsDemoInput(process.argv[2]!);
    const manifest = await runDemo(makeAwsDemoDependencies(config));
    process.stdout.write(`${deploymentCompletionMessage(manifest.outputs.FrontendUrl ?? 'the recorded frontend')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Deployment failed.'}\n`);
    process.exitCode = 1;
  }
}

export const manifestFileAdapter = { load: loadDeploymentManifest, save: saveDeploymentManifest };
