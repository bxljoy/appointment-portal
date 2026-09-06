import { DescribeStackEventsCommand, CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentManifest, type DeploymentManifest } from './lifecycle-types.js';
import { writePrivateJson } from './private-file.js';

type EventClient = Pick<CloudFormationClient, 'send'>;

export const captureDiagnostics = async (manifest: DeploymentManifest | undefined, client?: EventClient, path = resolve('.runtime/diagnostics.json')) => {
  const events: { stack: string; logicalResourceId?: string; resourceType?: string; status?: string; reason?: string; timestamp?: string }[] = [];
  if (manifest) {
    const cloudformation = client ?? new CloudFormationClient({ region: manifest.region });
    const stacks: string[] = [manifest.appStack, ...(manifest.deliveryStack ? [manifest.deliveryStack] : []), manifest.toolkitStack];
    for (const stack of stacks) {
      let NextToken: string | undefined;
      do {
        try {
          const page = await cloudformation.send(new DescribeStackEventsCommand({ StackName: stack, NextToken }));
          for (const event of page.StackEvents ?? []) events.push({ stack,
            ...(event.LogicalResourceId ? { logicalResourceId: event.LogicalResourceId } : {}),
            ...(event.ResourceType ? { resourceType: event.ResourceType } : {}),
            ...(event.ResourceStatus ? { status: event.ResourceStatus } : {}),
            ...(event.ResourceStatusReason ? { reason: sanitizeReason(event.ResourceStatusReason) } : {}),
            ...(event.Timestamp ? { timestamp: event.Timestamp.toISOString() } : {}),
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

const sanitizeReason = (reason: string) => [...reason].map((character) => character.charCodeAt(0) < 32 ? ' ' : character).join('')
  .replace(/\b(password|token|secret|authorization|credential)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]')
  .slice(0, 1_000);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await captureDiagnostics(await loadDeploymentManifest()); process.stdout.write('Sanitized CloudFormation diagnostics captured.\n'); }
  catch { process.stderr.write('Sanitized diagnostics could not be captured.\n'); process.exitCode = 1; }
}
