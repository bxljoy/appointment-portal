import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanup } from '../cleanup.js';
import { verifyCleanup } from '../verify-cleanup.js';
import { AwsInventoryAdapter } from '../aws-lifecycle.js';
import { fakeAwsClients, fakeInventory, manifest } from './fakes.js';

describe('inventory-driven cleanup', () => {
  it('refuses cleanup when the active AWS account differs from the manifest', async () => {
    const inventory = fakeInventory({});
    inventory.account = async () => '222222222222';
    await expect(cleanup(manifest, inventory)).rejects.toThrow(/account/i);
    expect(inventory.stackDeletes).toEqual([]);
  });

  it('refuses cleanup verification before inventory when the active account differs', async () => {
    const inventory = fakeInventory({ snapshots: [{ type: 'AWS::RDS::DBSnapshot', id: 'must-not-read', owned: true }] });
    let paged = false;
    const page = inventory.page;
    inventory.account = async () => '222222222222';
    inventory.page = async (cursor) => { paged = true; return page(cursor); };
    await expect(verifyCleanup(manifest, inventory)).rejects.toThrow(/account/i);
    expect(paged).toBe(false);
  });

  it('refuses SDK stack deletion when the live stack lacks established project ownership', async () => {
    const clients = fakeAwsClients({
      DescribeStacksCommand: [{ Stacks: [{ StackName: manifest.appStack, Tags: [] }] }],
    });
    await expect(new AwsInventoryAdapter(manifest, clients).deleteStack(manifest.appStack)).rejects.toThrow(/ownership/i);
  });

  it('archives inventory before stack deletion and cleans partial-stack resources', async () => {
    const owned = { type: 'AWS::SecretsManager::Secret', id: 'partial-secret', owned: true };
    const inventory = fakeInventory({ secrets: [owned] });
    const result = await cleanup({ ...manifest, phase: 'bootstrap', resources: [owned] }, inventory);
    expect(inventory.archived).toHaveLength(1);
    expect(inventory.persisted).toHaveLength(1);
    expect(inventory.events.slice(0, 3)).toEqual(['archive', 'persist', `delete-stack:${manifest.appStack}`]);
    expect(inventory.stackDeletes).toEqual([manifest.appStack]);
    expect(inventory.deleted).toEqual(['AWS::SecretsManager::Secret:partial-secret']);
    expect(result.deleted).toEqual([owned]);
  });

  it('diagnoses supported owned blockers and retries after a DELETE_FAILED waiter', async () => {
    const snapshot = { type: 'AWS::RDS::DBSnapshot', id: 'blocked-final', owned: true };
    const inventory = fakeInventory({ snapshots: [snapshot] });
    let waits = 0;
    inventory.waitStackDeleted = async (name) => {
      inventory.events.push(`wait-stack:${name}`);
      if (waits++ === 0) throw new Error('DELETE_FAILED');
    };
    await cleanup(manifest, inventory);
    expect(inventory.deleted).toContain('AWS::RDS::DBSnapshot:blocked-final');
    expect(inventory.stackDeletes).toEqual([manifest.appStack, manifest.appStack]);
  });

  it('deletes a proxy blocker before its database when recovering DELETE_FAILED', async () => {
    const database = { type: 'AWS::RDS::DBInstance', id: 'database', owned: true };
    const proxy = { type: 'AWS::RDS::DBProxy', id: 'proxy', owned: true };
    const inventory = fakeInventory({ databases: [database], proxies: [proxy] });
    let waits = 0;
    inventory.waitStackDeleted = async () => { if (waits++ === 0) throw new Error('DELETE_FAILED'); };
    await cleanup(manifest, inventory);
    expect(inventory.deleted.slice(0, 2)).toEqual(['AWS::RDS::DBProxy:proxy', 'AWS::RDS::DBInstance:database']);
  });

  it('enumerates every service page including S3 versions and delete markers', async () => {
    const records = [
      { type: 'AWS::S3::ObjectVersion', id: 'bucket/key#v1', owned: true },
      { type: 'AWS::S3::DeleteMarker', id: 'bucket/key#v2', owned: true },
      { type: 'AWS::RDS::DBSnapshot', id: 'demo-final', owned: true },
    ];
    const inventory = fakeInventory({ objects: records }, 1);
    const result = await verifyCleanup(manifest, inventory);
    expect(result.remaining).toEqual(records);
  });

  it('consumes service-specific AWS SDK pagination tokens', async () => {
    const clients = fakeAwsClients({
      DescribeDBSnapshotsCommand: [
        { DBSnapshots: [{ DBSnapshotIdentifier: 'first', DBInstanceIdentifier: 'portal-db', TagList: [{ Key: 'Project', Value: manifest.projectTag }] }], Marker: 'next' },
        { DBSnapshots: [{ DBSnapshotIdentifier: 'second', DBInstanceIdentifier: 'portal-db', TagList: [{ Key: 'Project', Value: manifest.projectTag }] }] },
      ],
      ListSecretsCommand: [
        { SecretList: [{ Name: 'admin', ARN: 'arn:admin', Tags: [{ Key: 'Project', Value: manifest.projectTag }] }], NextToken: 'next' },
        { SecretList: [{ Name: 'application', ARN: 'arn:application', DeletedDate: new Date('2026-09-06T00:00:00Z'), Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] },
      ],
    });
    const deployed = { ...manifest, outputs: { ...manifest.outputs, DatabaseId: 'portal-db', AdminSecretArn: 'arn:admin', ApplicationSecretArn: 'arn:application' } };
    const result = await verifyCleanup(deployed, new AwsInventoryAdapter(deployed, clients));
    expect(result.remaining.map((item) => item.id)).toEqual(['first', 'second', 'admin']);
    expect(result.scheduled.map((item) => item.id)).toEqual(['application']);
  });

  it('does not promote shared or cross-service ID collisions to owned resources', async () => {
    const clients = fakeAwsClients({ ListSecretsCommand: [{ SecretList: [{ Name: 'collision', ARN: 'arn:secret:collision' }] }] });
    const deployed = { ...manifest, resources: [
      { type: 'AWS::RDS::DBSnapshot', id: 'collision', owned: true },
      { type: 'AWS::SecretsManager::Secret', id: 'collision', arn: 'arn:secret:collision', owned: false },
    ] };
    const result = await verifyCleanup(deployed, new AwsInventoryAdapter(deployed, clients));
    expect(result.remaining).not.toContainEqual(expect.objectContaining({ type: expect.stringContaining('SecretsManager'), id: 'collision' }));
    expect(result.shared).toContainEqual(expect.objectContaining({ type: 'AWS::SecretsManager::Secret', id: 'collision', owned: false }));
  });

  it('does not treat output identifiers as deletion authority without tags or stack membership', async () => {
    const clients = fakeAwsClients({ DescribeDBInstancesCommand: [{ DBInstances: [{ DBInstanceIdentifier: 'output-only-db' }] }] });
    const deployed = { ...manifest, outputs: { ...manifest.outputs, DatabaseId: 'output-only-db' } };
    const result = await verifyCleanup(deployed, new AwsInventoryAdapter(deployed, clients));
    expect(result.remaining).toContainEqual(expect.objectContaining({ type: 'Application::AWS::RDS::DBInstance', id: 'output-only-db', owned: false, state: 'unverified' }));
    expect(result.shared).toEqual([]);
  });

  it('discovers tagged owned leftovers even when the saved manifest is stale', async () => {
    const clients = fakeAwsClients({
      DescribeDBInstancesCommand: [{ DBInstances: [{ DBInstanceIdentifier: 'tagged-db', TagList: [{ Key: 'Project', Value: manifest.projectTag }] }] }],
      DescribeDBProxiesCommand: [{ DBProxies: [{ DBProxyName: 'appointment-portal-tagged-proxy', DBProxyArn: 'arn:proxy' }] }],
      ListTagsForResourceCommand: [{ TagList: [{ Key: 'Project', Value: manifest.projectTag }] }],
      ListSecretsCommand: [{ SecretList: [{ Name: 'tagged-secret', ARN: 'arn:secret:tagged', Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] }],
      DescribeVpcEndpointsCommand: [{ VpcEndpoints: [{ VpcEndpointId: 'vpce-tagged', Tags: [{ Key: 'Project', Value: manifest.projectTag }] }] }],
    });
    const result = await verifyCleanup(manifest, new AwsInventoryAdapter(manifest, clients));
    expect(result.remaining.map((item) => item.id)).toEqual(expect.arrayContaining(['tagged-db', 'appointment-portal-tagged-proxy', 'tagged-secret', 'vpce-tagged']));
  });

  it('paginates and verifies tags for stale S3, logs, ECR, and SSM resources', async () => {
    const clients = fakeAwsClients({
      ListBucketsCommand: [
        { Buckets: [{ Name: 'appointmentportal-tagged-bucket' }], ContinuationToken: 'next' },
        { Buckets: [{ Name: 'shared-bucket' }] },
      ],
      GetBucketTaggingCommand: [
        { TagSet: [{ Key: 'Project', Value: manifest.projectTag }] },
        { TagSet: [{ Key: 'Project', Value: 'shared-project' }] },
      ],
      DescribeLogGroupsCommand: [{ logGroups: [{ logGroupName: '/appointment-portal/stale', arn: 'arn:log:stale' }] }],
      DescribeRepositoriesCommand: [{ repositories: [{ repositoryName: 'cdk-apptdemo-container-assets-111111111111-eu-north-1', repositoryArn: 'arn:ecr:tagged' }], nextToken: 'next' }, { repositories: [] }],
      DescribeParametersCommand: [{ Parameters: [{ Name: '/cdk-bootstrap/apptdemo/version' }], NextToken: 'next' }, { Parameters: [] }],
      ListTagsForResourceCommand: [
        { tags: { Project: manifest.projectTag } },
        { tags: [{ Key: 'Project', Value: manifest.projectTag }] },
        { TagList: [{ Key: 'Project', Value: manifest.projectTag }] },
      ],
    });
    const result = await verifyCleanup(manifest, new AwsInventoryAdapter(manifest, clients), { includeInfrastructure: true });
    expect(result.remaining.map((item) => item.id)).toEqual(expect.arrayContaining([
      'appointmentportal-tagged-bucket', '/appointment-portal/stale', 'cdk-apptdemo-container-assets-111111111111-eu-north-1', '/cdk-bootstrap/apptdemo/version',
    ]));
    expect(clients.commands.filter((command) => command.constructor.name === 'ListBucketsCommand')).toHaveLength(2);
    expect(clients.commands.filter((command) => command.constructor.name === 'DescribeRepositoriesCommand')).toHaveLength(2);
    expect(clients.commands.filter((command) => command.constructor.name === 'DescribeParametersCommand')).toHaveLength(2);
  });

  it('discovers a tagged automated backup without trusting a stale database output', async () => {
    const clients = fakeAwsClients({
      DescribeDBInstanceAutomatedBackupsCommand: [{ DBInstanceAutomatedBackups: [{
        DbiResourceId: 'dbi-stale', DBInstanceIdentifier: 'appointmentportal-different-db', DBInstanceAutomatedBackupsArn: 'arn:backup:stale',
      }] }],
      ListTagsForResourceCommand: [{ TagList: [{ Key: 'Project', Value: manifest.projectTag }] }],
    });
    const result = await verifyCleanup(manifest, new AwsInventoryAdapter(manifest, clients));
    expect(result.remaining).toContainEqual(expect.objectContaining({ type: 'Application::AWS::RDS::DBInstanceAutomatedBackup', id: 'dbi-stale', owned: true }));
  });

  it('reports a service-owned VPC interface ENI as unverified instead of deleting it', async () => {
    const clients = fakeAwsClients({ DescribeNetworkInterfacesCommand: [{ NetworkInterfaces: [{ NetworkInterfaceId: 'eni-service-owned' }] }] });
    const deployed = { ...manifest, outputs: { ...manifest.outputs, VpcId: 'vpc-portal' } };
    const adapter = new AwsInventoryAdapter(deployed, clients);
    const result = await verifyCleanup(deployed, adapter);
    expect(result.remaining).toContainEqual(expect.objectContaining({ id: 'eni-service-owned', owned: false, state: 'unverified' }));
    expect(adapter.canDeleteResource(result.remaining[0]!)).toBe(false);
  });

  it('enumerates every page of versions and delete markers in recorded S3 buckets', async () => {
    const bucket = 'apptdemo-assets-111111111111-eu-north-1';
    const clients = fakeAwsClients({
      ListObjectVersionsCommand: [
        {
          Versions: [{ Key: 'asset.js', VersionId: 'v1' }],
          NextKeyMarker: 'asset.js',
          NextVersionIdMarker: 'v1',
        },
        { DeleteMarkers: [{ Key: 'old.js', VersionId: 'v2' }] },
      ],
    });
    const deployed = {
      ...manifest,
      resources: [{ type: 'Bootstrap::AWS::S3::Bucket', id: bucket, owned: true }],
    };
    const result = await verifyCleanup(deployed, new AwsInventoryAdapter(deployed, clients), {
      includeInfrastructure: true,
    });
    expect(result.remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'Bootstrap::AWS::S3::ObjectVersion', id: JSON.stringify({ bucket, key: 'asset.js', versionId: 'v1' }) }),
      expect.objectContaining({ type: 'Bootstrap::AWS::S3::DeleteMarker', id: JSON.stringify({ bucket, key: 'old.js', versionId: 'v2' }) }),
      expect.objectContaining({ type: 'Bootstrap::AWS::S3::Bucket', id: bucket }),
    ]));
  });

  it('does not claim cleanup while a project snapshot remains', async () => {
    const result = await verifyCleanup(manifest, fakeInventory({
      snapshots: [{ type: 'AWS::RDS::DBSnapshot', id: 'demo-final', owned: true }],
    }));
    expect(result.remaining).toHaveLength(1);
  });

  it('reports pending secret deletion separately from active leftovers', async () => {
    const secret = { type: 'AWS::SecretsManager::Secret', id: 'demo-secret', arn: 'arn:aws:secretsmanager:eu-north-1:111111111111:secret:demo', owned: true,
      state: 'scheduled' as const };
    const result = await verifyCleanup(manifest, fakeInventory({ secrets: [secret] }));
    expect(result.remaining).toEqual([]);
    expect(result.scheduled).toEqual([secret]);
  });

  it('preserves and reports shared resources even when their names match', async () => {
    const shared = { type: 'AWS::IAM::OIDCProvider', id: 'token.actions.githubusercontent.com', owned: false };
    const inventory = fakeInventory({ providers: [shared] });
    const result = await cleanup({ ...manifest, resources: [shared] }, inventory);
    expect(inventory.deleted).toEqual([]);
    expect(result.shared).toEqual([shared]);
  });

  it('dry-run returns exact owned IDs without deleting anything', async () => {
    const resource = { type: 'AWS::EC2::VPCEndpoint', id: 'vpce-0123456789abcdef0', owned: true };
    const inventory = fakeInventory({ endpoints: [resource] });
    const result = await cleanup(manifest, inventory, { dryRun: true });
    expect(result.targets).toEqual([resource]);
    expect(inventory.deleted).toEqual([]);
    expect(inventory.stackDeletes).toEqual([]);
  });

  it('deletes owned database and proxy residuals and waits until both are absent', async () => {
    const database = { type: 'AWS::RDS::DBInstance', id: 'tagged-db', arn: 'arn:db', owned: true };
    const proxy = { type: 'AWS::RDS::DBProxy', id: 'appointment-portal-tagged-proxy', arn: 'arn:proxy', owned: true };
    const clients = fakeAwsClients({
      DescribeDBInstancesCommand: [
        { DBInstances: [{ DBInstanceIdentifier: database.id, DBInstanceArn: database.arn, TagList: [{ Key: 'Project', Value: manifest.projectTag }] }] },
        { DBInstances: [] },
      ],
      DescribeDBProxiesCommand: [
        { DBProxies: [{ DBProxyName: proxy.id, DBProxyArn: proxy.arn }] },
        { DBProxies: [] },
      ],
      ListTagsForResourceCommand: [{ TagList: [{ Key: 'Project', Value: manifest.projectTag }] }],
    });
    const adapter = new AwsInventoryAdapter(manifest, clients, { sleep: async () => {} } as never);
    await adapter.page();
    await expect(adapter.deleteResource(database)).resolves.toBeUndefined();
    await expect(adapter.deleteResource(proxy)).resolves.toBeUndefined();
    expect(clients.commands.map((command) => command.constructor.name)).toEqual(expect.arrayContaining([
      'DeleteDBInstanceCommand', 'DeleteDBProxyCommand',
    ]));
  });

  it('rejects partial S3 and VPC endpoint deletion responses without claiming success', async () => {
    const clients = fakeAwsClients({
      DeleteObjectsCommand: [{ Errors: [{ Key: 'asset.js', VersionId: 'v1', Code: 'AccessDenied' }] }],
      DeleteVpcEndpointsCommand: [{ Unsuccessful: [{ ResourceId: 'vpce-owned', Error: { Code: 'DependencyViolation' } }] }],
    });
    const ownedManifest = { ...manifest, resources: [
      { type: 'AWS::S3::ObjectVersion', id: JSON.stringify({ bucket: 'owned-bucket', key: 'asset.js', versionId: 'v1' }), owned: true },
      { type: 'AWS::EC2::VPCEndpoint', id: 'vpce-owned', owned: true },
    ] };
    const adapter = new AwsInventoryAdapter(ownedManifest, clients);
    await expect(adapter.deleteResource({ type: 'AWS::S3::ObjectVersion',
      id: JSON.stringify({ bucket: 'owned-bucket', key: 'asset.js', versionId: 'v1' }), owned: true })).rejects.toThrow(/delete/i);
    await expect(adapter.deleteResource({ type: 'AWS::EC2::VPCEndpoint', id: 'vpce-owned', owned: true })).rejects.toThrow(/delete/i);
  });

  it('refuses a caller-forged owned record that inventory did not verify', async () => {
    const clients = fakeAwsClients();
    const adapter = new AwsInventoryAdapter(manifest, clients);
    await expect(adapter.deleteResource({ type: 'AWS::RDS::DBInstance', id: 'forged', owned: true })).rejects.toThrow(/verified ownership/i);
    expect(clients.commands.some((command) => command.constructor.name === 'DeleteDBInstanceCommand')).toBe(false);
  });

  it('refuses a symlinked pre-destroy archive without changing its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portal-archive-symlink-'));
    try {
      const victim = join(root, 'victim'); await writeFile(victim, 'unchanged');
      const archive = join(root, 'archive.json'); await symlink(victim, archive);
      const adapter = new AwsInventoryAdapter(manifest, fakeAwsClients(), { archivePath: archive });
      await expect(adapter.archive(manifest)).rejects.toThrow(/unsafe|symlink/i);
      expect(await readFile(victim, 'utf8')).toBe('unchanged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a symlinked archive ancestor before creating anything through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portal-archive-ancestor-symlink-'));
    try {
      const target = join(root, 'target'); await mkdir(target);
      const alias = join(root, 'alias'); await symlink(target, alias);
      const adapter = new AwsInventoryAdapter(manifest, fakeAwsClients(), { archivePath: join(alias, 'nested', 'archive.json') });
      await expect(adapter.archive(manifest)).rejects.toThrow(/unsafe|symlink/i);
      expect(await readdir(target)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
