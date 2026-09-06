import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DeliveryStack } from '../lib/delivery-stack.js';

const synth = (oidcProviderArn?: string) => {
  const stack = new DeliveryStack(new App(), 'TestDelivery', {
    env: { account: '111111111111', region: 'eu-north-1' },
    repository: 'OWNER/REPOSITORY', branch: 'main', qualifier: 'apptdemo',
    projectTag: 'appointment-portal', ...(oidcProviderArn ? { oidcProviderArn } : {}),
  });
  return Template.fromStack(stack);
};

describe('GitHub OIDC delivery identity', () => {
  it('trusts only the exact GitHub audience and demo environment subject', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({
        Action: 'sts:AssumeRoleWithWebIdentity', Effect: 'Allow',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:OWNER/REPOSITORY:environment:demo',
          },
        },
      })] },
    });
  });

  it('reuses an explicitly inspected provider instead of creating a shared replacement', () => {
    const template = synth('arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com');
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  it('limits PassRole to project bootstrap roles and AWS service principals', () => {
    const json = JSON.stringify(synth().toJSON());
    expect(json).toContain(':iam::111111111111:role/cdk-apptdemo-');
    expect(json).toContain('iam:PassedToService');
    expect(json).toContain('cloudformation.amazonaws.com');
    expect(json).not.toContain('"Action":"iam:*"');
    expect(json).not.toContain('"Action":"*"');
  });

  it('uses the project qualifier and exports the runtime role ARN', () => {
    const template = synth();
    expect(JSON.stringify(template.toJSON())).toContain('/cdk-bootstrap/apptdemo/version');
    template.hasOutput('DeliveryRoleArn', { Value: Match.anyValue() });
  });

  it('reads all three lifecycle stacks but permits workflow deletion only for the application stack', () => {
    const policies = Object.values(synth().findResources('AWS::IAM::Policy')) as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: string | string[] }[] } } }[];
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const actions = (statement: (typeof statements)[number]) => Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = (statement: (typeof statements)[number]) => Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    const reads = statements.find((statement) => actions(statement).includes('cloudformation:ListStackResources'))!;
    const readResources = JSON.stringify(resources(reads));
    for (const name of ['AppointmentPortal', 'AppointmentPortalToolkit', 'AppointmentPortalDelivery']) expect(readResources).toContain(`stack/${name}/*`);
    const deletes = statements.filter((statement) => actions(statement).includes('cloudformation:DeleteStack'));
    expect(deletes).toHaveLength(1);
    expect(JSON.stringify(resources(deletes[0]!))).toContain('stack/AppointmentPortal/*');
    expect(JSON.stringify(resources(deletes[0]!))).not.toContain('Toolkit');
  });

  it('grants every application residual delete used by the workflow without provider deletion', () => {
    const template = synth();
    const json = JSON.stringify(template.toJSON());
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: string | string[]; Condition?: object }[] } } }[];
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const statementFor = (action: string) => statements.find((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(action));
    const bounds = new Map([
      ['rds:DeleteDBInstance', ':rds:eu-north-1:111111111111:db:*'],
      ['rds:DeleteDBProxy', ':rds:eu-north-1:111111111111:db-proxy:*'],
      ['rds:DeleteDBSnapshot', ':rds:eu-north-1:111111111111:snapshot:*'],
      ['rds:DeleteDBInstanceAutomatedBackup', ':rds:eu-north-1:111111111111:auto-backup:*'],
      ['secretsmanager:DeleteSecret', ':secretsmanager:eu-north-1:111111111111:secret:*'],
      ['logs:DeleteLogGroup', ':logs:eu-north-1:111111111111:log-group:/appointment-portal/*'],
      ['ec2:DeleteVpcEndpoints', ':ec2:eu-north-1:111111111111:vpc-endpoint/*'],
      ['s3:DeleteObject', ':s3:::appointmentportal-*/*'],
      ['s3:DeleteObjectVersion', ':s3:::appointmentportal-*/*'],
      ['s3:DeleteBucket', ':s3:::appointmentportal-*'],
    ]);
    for (const [action, resource] of bounds) {
      const statement = statementFor(action);
      expect(statement, action).toBeDefined();
      expect(JSON.stringify(statement!.Resource), action).toContain(resource);
      if (!action.startsWith('s3:')) expect(JSON.stringify(statement!.Condition), action).toContain('aws:ResourceTag/Project');
    }
    expect(json).not.toContain('iam:DeleteOpenIDConnectProvider');
    expect(json).not.toContain('ec2:DeleteNetworkInterface');
    expect(json).toContain('aws:ResourceTag/Project');
    expect(JSON.stringify(statementFor('logs:DeleteLogGroup')!.Resource)).toContain(':log-group:/aws/rds/proxy/appointment-portal-*');
    expect(JSON.stringify(statementFor('logs:ListTagsForResource')!.Resource)).toContain(':log-group:/aws/rds/proxy/appointment-portal-*');
  });

  it('grants the paginated tag discovery calls used by lifecycle inventory', () => {
    const json = JSON.stringify(synth().toJSON());
    for (const action of [
      's3:ListAllMyBuckets', 's3:GetBucketTagging', 'logs:ListTagsForResource',
      'ecr:ListTagsForResource', 'ssm:DescribeParameters', 'ssm:ListTagsForResource',
    ]) expect(json).toContain(action);
  });
});
