import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { expect, test } from 'vitest';
import { PortalStack } from '../lib/portal-stack.js';

const synth = (phase: 'bootstrap' | 'ready') => {
  const env = { account: '111111111111', region: 'eu-north-1' };
  const app = new App({ context: { 'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'] } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010', reason: 'Offline tests use fictional cached AZs.' });
  const stack = new PortalStack(app, 'TestPortal', { env, config: { ...env, qualifier: 'portal123', phase, postgresVersion: '17.6',
    ...(phase === 'ready' ? { frontendUrl: 'https://demo.cloudfront.net' } : {}) } });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return { stack, template, directory: app.outdir };
};

test.each(['bootstrap', 'ready'] as const)('%s isolates the private admin migration function from all API routes', async (phase) => {
  const { template } = synth(phase);
  const entries = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([, resource]) => resource.Properties.Description === 'Appointment portal private migration and seed');
  expect(entries).toHaveLength(1);
  const [id, fn] = entries[0]!;
  const secrets = Object.keys(template.findResources('AWS::SecretsManager::Secret'));
  const adminId = secrets.find((id) => id.includes('AdminSecret'))!;
  const appId = secrets.find((id) => id.includes('ApplicationSecret'))!;
  const databaseId = Object.keys(template.findResources('AWS::RDS::DBInstance'))[0]!;
  const sgId = Object.entries(template.findResources('AWS::EC2::SecurityGroup')).find(([, resource]) => resource.Properties.GroupDescription === 'Migration function')![0];
  expect(fn.Properties).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'], MemorySize: 512, Timeout: 120,
    ReservedConcurrentExecutions: 1, Handler: 'index.handler', LoggingConfig: { LogFormat: 'JSON' },
    VpcConfig: { SecurityGroupIds: [{ 'Fn::GetAtt': [sgId, 'GroupId'] }] },
    Environment: { Variables: { ADMIN_DATABASE_SECRET_ARN: { Ref: adminId }, APPLICATION_DATABASE_SECRET_ARN: { Ref: appId },
      DATABASE_HOST: { 'Fn::GetAtt': [databaseId, 'Endpoint.Address'] }, DATABASE_NAME: 'portal', DATABASE_PORT: '5432',
      DATABASE_CA_BUNDLE_PATH: '/var/task/certs/rds-global-bundle.pem', MIGRATIONS_PATH: '/var/task/migrations' } } });
  const roleId = fn.Properties.Role['Fn::GetAtt'][0];
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) => policy.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const secretStatements = statements.filter((statement) => JSON.stringify(statement.Action).includes('secretsmanager:'));
  expect(secretStatements).toEqual([adminId, appId].map((Ref) => ({ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Resource: { Ref } })));
  expect(JSON.stringify(statements)).not.toMatch(/cognito-idp:|secretsmanager:\*|rds:\*/);
  for (const type of ['AWS::ApiGatewayV2::Integration', 'AWS::Lambda::Permission', 'AWS::Lambda::Url']) expect(JSON.stringify(template.findResources(type))).not.toContain(id);
  const logId = fn.Properties.LoggingConfig.LogGroup.Ref;
  expect(template.findResources('AWS::Logs::LogGroup')[logId]).toMatchObject({ Properties: {
    LogGroupName: '/appointment-portal/TestPortal/migration', RetentionInDays: 7 }, DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
  expect(fn.Properties.Tags).toContainEqual({ Key: 'Project', Value: 'appointment-portal' });
  expect(template.toJSON().Outputs.MigrationFunctionName.Value).toEqual({ Ref: id });
});

test('bundles the real migration handler, SDK, SQL and verified CA at a stable hash in both phases', async () => {
  const hashes: string[] = [];
  for (const phase of ['bootstrap', 'ready'] as const) {
    const { stack, directory } = synth(phase);
    const fn = stack.data.node.tryFindChild('Migration') as NodejsFunction | undefined;
    expect(fn).toBeDefined();
    const asset = fn!.node.findChild('Code') as Asset;
    hashes.push(asset.assetHash);
    const artifact = join(directory, asset.assetPath);
    const sqlSource = new URL('../../packages/database/migrations/', import.meta.url);
    expect(readdirSync(join(artifact, 'migrations')).sort()).toEqual(readdirSync(sqlSource).sort());
    for (const file of readdirSync(sqlSource)) expect(readFileSync(join(artifact, 'migrations', file))).toEqual(readFileSync(new URL(file, sqlSource)));
    expect(readFileSync(join(artifact, 'certs/rds-global-bundle.pem'))).toEqual(readFileSync(new URL('../assets/rds-global-bundle.pem', import.meta.url)));
    const metadata = JSON.parse(readFileSync(join(artifact, 'index.meta.json'), 'utf8'));
    expect(Object.keys(metadata.inputs).some((path) => path.includes('/@aws-sdk/client-secrets-manager/'))).toBe(true);
    const bundle = join(artifact, 'index.mjs');
    expect(readFileSync(bundle, 'utf8')).not.toMatch(/patient-a|clinician-a|X-Local-Actor|LOCAL_AUTH_DEVELOPMENT_ONLY/);
    expect(typeof (await import(pathToFileURL(bundle).href)).handler).toBe('function');
  }
  expect(hashes[0]).toBe(hashes[1]);
});
