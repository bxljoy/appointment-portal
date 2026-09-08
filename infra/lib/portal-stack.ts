import { CfnOutput, CfnParameter, DefaultStackSynthesizer, RemovalPolicies, Stack, Tags, Validations, type StackProps } from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';
import { parsePortalConfig, type PortalConfig } from './config.js';
import { DataConstruct } from './data-construct.js';
import { IdentityConstruct } from './identity-construct.js';
import { ApiConstruct } from './api-construct.js';
import { WebConstruct } from './web-construct.js';
import { OperationsConstruct } from './operations-construct.js';

export type PortalStackProps = StackProps & { config: PortalConfig; sourceCommit?: string };

export class PortalStack extends Stack {
  readonly data: DataConstruct;
  readonly identity: IdentityConstruct;
  readonly api: ApiConstruct;
  readonly web: WebConstruct;
  readonly operations: OperationsConstruct;

  constructor(scope: Construct, id: string, props: PortalStackProps) {
    const config = parsePortalConfig(props.config);
    if (props.env?.account !== config.account || props.env.region !== config.region) {
      throw new Error('Stack environment must match the concrete PortalConfig account and region.');
    }
    super(scope, id, {
      ...props, analyticsReporting: false,
      synthesizer: new DefaultStackSynthesizer({ qualifier: config.qualifier }),
    });
    Tags.of(this).add('Project', 'appointment-portal');
    new CfnParameter(this, 'DeploymentPhase', { type: 'String', allowedValues: ['bootstrap', 'ready'], default: config.phase });
    Validations.of(this).acknowledge({ id: 'CloudFormation-Validate::W2001',
      reason: 'Lifecycle reconciliation reads this stack parameter through DescribeStacks; template resources intentionally do not reference it.' });
    if (config.expiresAt) Validations.of(this).acknowledge({ id: 'CloudFormation-Validate::F3002',
      reason: 'The current CloudFormation specification supports Scheduler ActionAfterCompletion; the validation schema bundled with this pinned CDK release lags that property.' });
    if (props.sourceCommit) Tags.of(this).add('SourceCommit', zCommit(props.sourceCommit));
    const safeguard = config.expiresAt ? this.addExpirySafeguard(config.expiresAt, config.qualifier) : undefined;
    this.data = new DataConstruct(this, 'Data', { config });
    this.identity = new IdentityConstruct(this, 'Identity', { config });
    this.api = new ApiConstruct(this, 'Api', {
      data: this.data, identity: this.identity, lambdaConcurrencyMode: config.lambdaConcurrencyMode,
    });
    this.web = new WebConstruct(this, 'Web', { apiUrl: this.api.apiUrl,
      cognitoDomain: this.identity.domain.baseUrl(), cognitoIssuerOrigin: `https://cognito-idp.${this.region}.${this.urlSuffix}` });
    this.operations = new OperationsConstruct(this, 'Operations', { functions: this.api.functions, httpApi: this.api.httpApi,
      database: this.data.database, proxy: this.data.proxy, proxyName: this.data.proxyName });
    if (safeguard) {
      this.data.secretsManagerEndpoint.node.addDependency(safeguard);
      this.data.database.node.addDependency(safeguard);
      this.data.proxy.node.addDependency(safeguard);
      this.web.distribution.node.addDependency(safeguard);
    }
    const outputs = {
      FrontendUrl: this.web.frontendUrl, ApiUrl: this.api.apiUrl, DistributionId: this.web.distribution.distributionId,
      WebBucketName: this.web.bucket.bucketName, UserPoolId: this.identity.userPool.userPoolId,
      ClientId: this.identity.appClient.userPoolClientId, Issuer: this.identity.issuer,
      CognitoDomain: this.identity.domain.baseUrl(), ProxyName: this.data.proxy.dbProxyName,
      DatabaseId: this.data.database.instanceIdentifier,
      MigrationFunctionName: this.data.migrationFunction.functionName,
      VpcId: this.data.vpc.vpcId,
      AdminSecretArn: this.data.adminSecret.secretArn,
      ApplicationSecretArn: this.data.applicationSecret.secretArn,
      ProfilesFunctionName: this.api.functions.profiles.functionName,
      ...(config.expiresAt && safeguard ? { ExpiresAt: config.expiresAt, SafeguardScheduleName: safeguard.name! } : {}),
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
    RemovalPolicies.of(this).destroy();
  }

  private addExpirySafeguard(expiresAt: string, qualifier: string): scheduler.CfnSchedule {
    const schedule = new scheduler.CfnSchedule(this, 'ExpirySafeguard', {
      name: 'appointment-portal-expiry', groupName: 'default',
      scheduleExpression: `at(${expiresAt.slice(0, 19)})`, scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: 'arn:aws:scheduler:::aws-sdk:cloudformation:deleteStack',
        roleArn: `arn:${this.partition}:iam::${this.account}:role/appointment-portal-expiry-${qualifier}`,
        input: JSON.stringify({ StackName: this.stackName }) },
    });
    // CloudFormation supports ActionAfterCompletion although this pinned CDK L1
    // has not yet exposed it in CfnScheduleProps:
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-scheduler-schedule.html
    schedule.addPropertyOverride('ActionAfterCompletion', 'DELETE');
    return schedule;
  }
}

const zCommit = (value: string) => {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Source commit must be a full lowercase Git SHA.');
  return value;
};
