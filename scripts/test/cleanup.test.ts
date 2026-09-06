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
    expect(inventory.stackDeletes).toEqual([manifest.appStack]);
    expect(inventory.deleted).toEqual(['AWS::SecretsManager::Secret:partial-secret']);
    expect(result.deleted).toEqual([owned]);
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
        { DBSnapshots: [{ DBSnapshotIdentifier: 'first', DBInstanceIdentifier: 'portal-db' }], Marker: 'next' },
        { DBSnapshots: [{ DBSnapshotIdentifier: 'second', DBInstanceIdentifier: 'portal-db' }] },
      ],
      ListSecretsCommand: [
        { SecretList: [{ Name: 'admin', ARN: 'arn:admin' }], NextToken: 'next' },
        { SecretList: [{ Name: 'application', ARN: 'arn:application', DeletedDate: new Date('2026-09-06T00:00:00Z') }] },
      ],
    });
    const deployed = { ...manifest, outputs: { ...manifest.outputs, DatabaseId: 'portal-db', AdminSecretArn: 'arn:admin', ApplicationSecretArn: 'arn:application' } };
    const result = await verifyCleanup(deployed, new AwsInventoryAdapter(deployed, clients));
    expect(result.remaining.map((item) => item.id)).toEqual(['first', 'second', 'admin']);
    expect(result.scheduled.map((item) => item.id)).toEqual(['application']);
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
});
