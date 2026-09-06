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
});
