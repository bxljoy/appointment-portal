import { DescribeStackEventsCommand, CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { writePrivateJson } from './private-file.js';

type EventClient = Pick<CloudFormationClient, 'send'>;

export const captureDiagnostics = async (manifest: DeploymentManifest | undefined, client?: EventClient, path = resolve('.runtime/diagnostics.json')) => {
  const events: { stack: string; logicalResourceId?: string; resourceType?: string; status?: string; timestamp?: string }[] = [];
  if (manifest) {
    const cloudformation = client ?? new CloudFormationClient({ region: manifest.region });
    const stacks: string[] = [manifest.appStack, ...(manifest.deliveryStack ? [manifest.deliveryStack] : []), manifest.toolkitStack];
    for (const stack of stacks) {
      let NextToken: string | undefined;
      do {
        try {
          const page = await cloudformation.send(new DescribeStackEventsCommand({ StackName: stack, NextToken }));
          for (const event of page.StackEvents ?? []) events.push({ stack,
            ...(isSafeLogicalId(event.LogicalResourceId) ? { logicalResourceId: event.LogicalResourceId } : {}),
            ...(isSafeResourceType(event.ResourceType) ? { resourceType: event.ResourceType } : {}),
            ...(event.ResourceStatus && SAFE_STATUSES.has(event.ResourceStatus) ? { status: event.ResourceStatus } : {}),
            ...(event.Timestamp instanceof Date ? { timestamp: event.Timestamp.toISOString() } : {}),
          });
          NextToken = page.NextToken;
        } catch { NextToken = undefined; }
      } while (NextToken && events.length < 500);
    }
  }
  const diagnostic = { capturedAt: new Date().toISOString(), manifestAvailable: Boolean(manifest), events: events.slice(0, 500) };
  await writePrivateJson(path, diagnostic);
  return diagnostic;
};

const SAFE_STATUSES = new Set([
  'CREATE_IN_PROGRESS', 'CREATE_FAILED', 'CREATE_COMPLETE', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_FAILED', 'ROLLBACK_COMPLETE',
  'DELETE_IN_PROGRESS', 'DELETE_FAILED', 'DELETE_COMPLETE', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
  'UPDATE_COMPLETE', 'UPDATE_FAILED', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED',
  'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE', 'REVIEW_IN_PROGRESS',
  'IMPORT_IN_PROGRESS', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_IN_PROGRESS', 'IMPORT_ROLLBACK_FAILED', 'IMPORT_ROLLBACK_COMPLETE',
]);
const isSafeLogicalId = (value?: string): value is string => Boolean(value && /^[A-Za-z][A-Za-z0-9]{0,254}$/.test(value) &&
  !/(?:password|token|secret|authorization|credential)/i.test(value));
const isSafeResourceType = (value?: string): value is string => Boolean(value && /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(value));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await captureDiagnostics(await loadDeploymentManifest()); process.stdout.write('Sanitized CloudFormation diagnostics captured.\n'); }
  catch { process.stderr.write('Sanitized diagnostics could not be captured.\n'); process.exitCode = 1; }
}
