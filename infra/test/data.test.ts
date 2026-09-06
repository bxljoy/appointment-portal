import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PortalStack } from '../lib/portal-stack.js';

const env = { account: '111111111111', region: 'eu-north-1' };
const synth = (phase: 'bootstrap' | 'ready' = 'ready') => {
  const app = new App({ context: {
    'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'],
  } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010',
    reason: 'Tests intentionally cache concrete fake AZs to prevent any AWS lookup.' });
  const stack = new PortalStack(app, 'TestPortal', {
    env, config: { ...env, postgresVersion: '17.6', phase, qualifier: 'portal123',
      ...(phase === 'ready' ? { frontendUrl: 'https://demo.cloudfront.net' } : {}), },
  });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return template;
};

const one = (template: Template, type: string, props?: Record<string, unknown>) => {
  const entries = Object.entries(template.findResources(type, props ? { Properties: props } : undefined));
  expect(entries).toHaveLength(1);
  return entries[0]!;
};

describe('private disposable PostgreSQL infrastructure', () => {
  it('places two /24 isolated subnets in concrete AZs without NAT or internet routing', () => {
    const template = synth();
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 2);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::EC2::Route', 0);
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
    expect(subnets.map((r) => r.Properties.AvailabilityZone).sort()).toEqual(['eu-north-1a', 'eu-north-1b']);
    for (const subnet of subnets) {
      expect(subnet.Properties.CidrBlock).toMatch(/\/24$/);
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
    }
  });

  it('uses bounded encrypted private PostgreSQL 17 with disposable storage', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres', EngineVersion: '17.6', DBInstanceClass: 'db.t4g.small',
      AllocatedStorage: '20', StorageType: 'gp3', StorageEncrypted: true,
      PubliclyAccessible: false, MultiAZ: false, DeletionProtection: false,
      BackupRetentionPeriod: 0, DeleteAutomatedBackups: true,
      MaxAllocatedStorage: Match.absent(), DBName: 'portal', Port: '5432',
    });
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', { SubnetIds: [Match.anyValue(), Match.anyValue()] });
  });

  it('generates separate administrator and fixed portal_app credentials', () => {
    const template = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets.map((r) => JSON.parse(r.Properties.GenerateSecretString.SecretStringTemplate).username).sort())
      .toEqual(['portal_admin', 'portal_app']);
    for (const secret of secrets) {
      expect(secret.Properties.GenerateSecretString).toMatchObject({ GenerateStringKey: 'password', PasswordLength: 32 });
      expect(secret.Properties.SecretString).toBeUndefined();
    }
    const [adminId] = one(template, 'AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: JSON.stringify({ username: 'portal_admin' }) }),
    });
    const [, db] = one(template, 'AWS::RDS::DBInstance');
    expect(JSON.stringify(db.Properties.MasterUserPassword)).toContain(adminId);
    expect(JSON.stringify(db.Properties.MasterUserPassword)).toContain('secretsmanager:');
  });

  it('requires TLS with bounded pooling and no debug SQL', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBProxy', { RequireTLS: true, DebugLogging: false, EngineFamily: 'POSTGRESQL' });
    template.hasResourceProperties('AWS::RDS::DBProxyTargetGroup', {
      ConnectionPoolConfigurationInfo: {
        MaxConnectionsPercent: 60, MaxIdleConnectionsPercent: 30, ConnectionBorrowTimeout: 5,
      }, DBInstanceIdentifiers: [Match.anyValue()],
    });
  });

  it.each(['bootstrap', 'ready'] as const)('%s attaches and grants proxy access to exactly its own secret', (phase) => {
    const template = synth(phase);
    const username = phase === 'ready' ? 'portal_app' : 'portal_admin';
    const [secretId] = one(template, 'AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: JSON.stringify({ username }) }),
    });
    const [, proxy] = one(template, 'AWS::RDS::DBProxy');
    expect(proxy.Properties.Auth).toEqual([{ AuthScheme: 'SECRETS', IAMAuth: 'DISABLED', SecretArn: { Ref: secretId } }]);
    const roleId = proxy.Properties.RoleArn['Fn::GetAtt'][0];
    const role = template.findResources('AWS::IAM::Role')[roleId]!;
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((resource) =>
      resource.Properties.Roles.some((value: { Ref: string }) => value.Ref === roleId));
    expect(policies).toHaveLength(1);
    expect(policies[0]!.Properties.PolicyDocument.Statement).toEqual([{
      Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Effect: 'Allow', Resource: { Ref: secretId },
    }]);
    expect(proxy.Properties.RoleArn).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    expect(policies[0]!.Properties.Roles).toEqual([{ Ref: roleId }]);
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([{
      Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'rds.amazonaws.com' },
    }]);
  });

  it('allows only API→proxy, proxy→RDS, migration→RDS and API/migration→Secrets Manager', () => {
    const template = synth();
    const sgId = (description: string) => one(template, 'AWS::EC2::SecurityGroup', { GroupDescription: description })[0];
    const api = sgId('API functions');
    const migration = sgId('Migration function');
    const proxy = sgId('Database proxy');
    const database = sgId('PostgreSQL database');
    const endpoint = sgId('Secrets Manager endpoint');
    template.resourceCountIs('AWS::EC2::SecurityGroup', 5);
    const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).map((r) => r.Properties);
    const [dbId] = one(template, 'AWS::RDS::DBInstance');
    const databasePort = { 'Fn::GetAtt': [dbId, 'Endpoint.Port'] };
    const rule = (from: string, to: string, port: number | Record<string, unknown>) => ({
      SourceSecurityGroupId: { 'Fn::GetAtt': [from, 'GroupId'] }, GroupId: { 'Fn::GetAtt': [to, 'GroupId'] },
      IpProtocol: 'tcp', FromPort: port, ToPort: port,
    });
    expect(ingress).toHaveLength(5);
    for (const expected of [rule(api, proxy, 5432), rule(proxy, database, databasePort), rule(migration, database, 5432),
      rule(api, endpoint, 443), rule(migration, endpoint, 443)]) {
      expect(ingress).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
    }
    for (const sg of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
      expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
      expect(JSON.stringify(sg.Properties.SecurityGroupEgress ?? [])).not.toMatch(/0\.0\.0\.0\/0|::\/0/);
    }
    const egress = Object.values(template.findResources('AWS::EC2::SecurityGroupEgress')).map((r) => r.Properties);
    expect(egress).toHaveLength(7);
    const outgoingConnections = egress.filter((r) => r.DestinationSecurityGroupId !== undefined);
    expect(outgoingConnections).toHaveLength(5);
    for (const r of outgoingConnections) {
      expect(r.CidrIp).toBeUndefined(); expect(r.CidrIpv6).toBeUndefined();
      expect(ingress).toContainEqual(expect.objectContaining({
        SourceSecurityGroupId: r.GroupId, GroupId: r.DestinationSecurityGroupId,
        IpProtocol: r.IpProtocol, FromPort: r.FromPort, ToPort: r.ToPort,
      }));
    }
    // EC2 creates allow-all egress when no rule is supplied. CDK uses these
    // impossible ICMP rules to keep the database and endpoint outbound closed.
    for (const id of [database, endpoint]) {
      expect(egress).toContainEqual({
        CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic',
        FromPort: 252, ToPort: 86, IpProtocol: 'icmp', GroupId: { 'Fn::GetAtt': [id, 'GroupId'] },
      });
    }
    template.hasResourceProperties('AWS::RDS::DBInstance', { VPCSecurityGroups: [{ 'Fn::GetAtt': [database, 'GroupId'] }] });
    template.hasResourceProperties('AWS::RDS::DBProxy', { VpcSecurityGroupIds: [{ 'Fn::GetAtt': [proxy, 'GroupId'] }] });
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface', PrivateDnsEnabled: true,
      ServiceName: 'com.amazonaws.eu-north-1.secretsmanager',
      SecurityGroupIds: [{ 'Fn::GetAtt': [endpoint, 'GroupId'] }], SubnetIds: [Match.anyValue(), Match.anyValue()],
    });
  });

  it('applies Delete to every resource and tags every taggable data/network resource', () => {
    const template = synth();
    const resources = template.toJSON().Resources ?? {};
    expect(Object.keys(resources).length).toBeGreaterThan(10);
    const taggable = new Set(['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::RouteTable',
      'AWS::EC2::SecurityGroup', 'AWS::EC2::VPCEndpoint', 'AWS::RDS::DBInstance', 'AWS::RDS::DBSubnetGroup',
      'AWS::RDS::DBProxy', 'AWS::SecretsManager::Secret', 'AWS::IAM::Role']);
    for (const resource of Object.values(resources) as { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Properties: { Tags?: unknown[] } }[]) {
      expect(resource.DeletionPolicy).toBe('Delete');
      expect(resource.UpdateReplacePolicy).toBe('Delete');
      if (taggable.has(resource.Type)) expect(resource.Properties.Tags).toContainEqual({ Key: 'Project', Value: 'appointment-portal' });
    }
  });
});
