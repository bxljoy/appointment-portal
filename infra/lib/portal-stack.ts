import { DefaultStackSynthesizer, RemovalPolicies, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { parsePortalConfig, type PortalConfig } from './config.js';
import { DataConstruct } from './data-construct.js';

export type PortalStackProps = StackProps & { config: PortalConfig };

export class PortalStack extends Stack {
  readonly data: DataConstruct;

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
    RemovalPolicies.of(this).destroy();
  }
}
