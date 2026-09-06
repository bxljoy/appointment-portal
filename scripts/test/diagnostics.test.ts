import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureDiagnostics } from '../capture-diagnostics.js';
import { manifest } from './fakes.js';

describe('sanitized lifecycle diagnostics', () => {
  it('paginates CloudFormation events while excluding status reasons and physical identifiers', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'portal-diagnostics-'));
    const path = join(root, 'diagnostics.json');
    const calls: object[] = [];
    try {
      const client = { send: async (command: object) => {
        calls.push(command);
        const input = (command as { input: { NextToken?: string } }).input;
        if (!input.NextToken) return { StackEvents: [
          { LogicalResourceId: 'Database', ResourceType: 'AWS::RDS::DBInstance', ResourceStatus: 'DELETE_FAILED',
            ResourceStatusReason: 'Authorization: Bearer bearer-must-never-leak', PhysicalResourceId: 'private-resource-id',
            Timestamp: new Date('2026-09-06T12:00:00Z') },
          { LogicalResourceId: 'Secret', ResourceType: 'AWS::SecretsManager::Secret', ResourceStatus: 'DELETE_FAILED',
            ResourceStatusReason: 'password="quoted value with spaces" token=another-secret-value' },
          { LogicalResourceId: 'AuthorizationBearerIdentifierLeak', ResourceType: 'token=resource-type-leak',
            ResourceStatus: 'password=status-leak' },
        ], NextToken: 'next' };
        return { StackEvents: [{ LogicalResourceId: 'Proxy', ResourceStatus: 'DELETE_IN_PROGRESS' }] };
      } };
      await captureDiagnostics(manifest, client as never, path);
      const contents = await readFile(path, 'utf8');
      expect(calls.length).toBe(6);
      expect(contents).toContain('DELETE_FAILED');
      expect(contents).toContain('Proxy');
      expect(contents).not.toContain('reason');
      expect(contents).not.toContain('bearer-must-never-leak');
      expect(contents).not.toContain('quoted value with spaces');
      expect(contents).not.toContain('another-secret-value');
      expect(contents).not.toContain('resource-type-leak');
      expect(contents).not.toContain('status-leak');
      expect(contents).not.toContain('private-resource-id');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
