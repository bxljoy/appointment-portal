import { CfnOutput, DefaultStackSynthesizer, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { z } from 'zod';

const propsSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).max(255),
  qualifier: z.literal('apptdemo'),
  projectTag: z.literal('appointment-portal'),
  oidcProviderArn: z.string().startsWith('arn:aws:iam::').optional(),
});

export type DeliveryStackProps = StackProps & z.infer<typeof propsSchema>;

export class DeliveryStack extends Stack {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    const account = z.string().regex(/^\d{12}$/).parse(props.env?.account);
    const region = z.string().min(1).parse(props.env?.region);
    const config = propsSchema.parse({
      repository: props.repository, branch: props.branch, qualifier: props.qualifier,
      projectTag: props.projectTag, ...(props.oidcProviderArn ? { oidcProviderArn: props.oidcProviderArn } : {}),
    });
    super(scope, id, { ...props, analyticsReporting: false,
      synthesizer: new DefaultStackSynthesizer({ qualifier: config.qualifier }) });
    Tags.of(this).add('Project', config.projectTag);

    const providerArn = config.oidcProviderArn ?? new iam.CfnOIDCProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com', clientIdList: ['sts.amazonaws.com'],
    }).attrArn;
    const principal = new iam.FederatedPrincipal(providerArn, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${config.repository}:environment:demo`,
      },
    }, 'sts:AssumeRoleWithWebIdentity');
    this.role = new iam.Role(this, 'DeliveryRole', {
      roleName: `appointment-portal-delivery-${config.qualifier}`,
      description: `Manual demo delivery for ${config.repository} from GitHub environment demo`,
      assumedBy: principal,
      maxSessionDuration: undefined,
    });
    const bootstrapRole = (kind: string) => `arn:${this.partition}:iam::${account}:role/cdk-${config.qualifier}-${kind}-role-${account}-${region}`;
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(bootstrapRole),
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:ListStackResources', 'cloudformation:DeleteStack'],
      resources: [`arn:${this.partition}:cloudformation:${region}:${account}:stack/AppointmentPortal/*`],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'], resources: [`arn:${this.partition}:lambda:${region}:${account}:function:AppointmentPortal-*`],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminSetUserPassword', 'cognito-idp:DescribeUserPoolClient'],
      resources: [`arn:${this.partition}:cognito-idp:${region}:${account}:userpool/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/Project': config.projectTag } },
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions', 's3:GetBucketLocation'], resources: [`arn:${this.partition}:s3:::appointmentportal-*`, `arn:${this.partition}:s3:::cdk-${config.qualifier}-assets-${account}-${region}`],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'], resources: [`arn:${this.partition}:s3:::appointmentportal-*/*`],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: [`arn:${this.partition}:cloudfront::${account}:distribution/*`],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:DescribeDBEngineVersions', 'rds:DescribeOrderableDBInstanceOptions', 'rds:DescribeDBProxies', 'rds:DescribeDBProxyTargets',
        'rds:DescribeDBInstances', 'rds:DescribeDBSnapshots', 'rds:DescribeDBInstanceAutomatedBackups', 'lambda:GetAccountSettings',
        'ec2:DescribeNetworkInterfaces', 'ec2:DescribeVpcEndpoints', 'secretsmanager:ListSecrets', 'logs:DescribeLogGroups',
        'ecr:DescribeRepositories', 'ssm:GetParameter', 'iam:ListOpenIDConnectProviders', 'iam:GetOpenIDConnectProvider'], resources: ['*'],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [bootstrapRole('*')],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    new CfnOutput(this, 'DeliveryRoleArn', { value: this.role.roleArn });
    new CfnOutput(this, 'AllowedBranch', { value: config.branch });
  }
}
