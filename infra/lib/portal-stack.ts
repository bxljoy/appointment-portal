import { CfnOutput, DefaultStackSynthesizer, RemovalPolicies, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { parsePortalConfig, type PortalConfig } from './config.js';
import { DataConstruct } from './data-construct.js';
import { IdentityConstruct } from './identity-construct.js';
import { ApiConstruct } from './api-construct.js';
import { WebConstruct } from './web-construct.js';
import { OperationsConstruct } from './operations-construct.js';

export type PortalStackProps = StackProps & { config: PortalConfig };

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
    this.data = new DataConstruct(this, 'Data', { config });
    this.identity = new IdentityConstruct(this, 'Identity', { config });
    this.api = new ApiConstruct(this, 'Api', { data: this.data, identity: this.identity });
    this.web = new WebConstruct(this, 'Web', { apiUrl: this.api.apiUrl,
      cognitoDomain: this.identity.domain.baseUrl(), cognitoIssuerOrigin: `https://cognito-idp.${this.region}.${this.urlSuffix}` });
    this.operations = new OperationsConstruct(this, 'Operations', { functions: this.api.functions, httpApi: this.api.httpApi,
      database: this.data.database, proxy: this.data.proxy });
    const outputs = {
      FrontendUrl: this.web.frontendUrl, ApiUrl: this.api.apiUrl, DistributionId: this.web.distribution.distributionId,
      WebBucketName: this.web.bucket.bucketName, UserPoolId: this.identity.userPool.userPoolId,
      ClientId: this.identity.appClient.userPoolClientId, Issuer: this.identity.issuer,
      CognitoDomain: this.identity.domain.baseUrl(), ProxyName: this.data.proxy.dbProxyName,
      DatabaseId: this.data.database.instanceIdentifier,
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
    RemovalPolicies.of(this).destroy();
  }
}
