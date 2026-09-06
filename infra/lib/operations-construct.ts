import { CfnResource, Duration, Names, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { DatabaseInstance, DatabaseProxy } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import type { FeatureFunctions } from './api-construct.js';

type OperationsProps = { functions: FeatureFunctions; httpApi: HttpApi; database: DatabaseInstance; proxy: DatabaseProxy };

export class OperationsConstruct extends Construct {
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, { functions, httpApi, database, proxy }: OperationsProps) {
    super(scope, id);
    const stack = Stack.of(this);
    // Generic CDK provider CfnResources do not participate in tag propagation.
    for (const resource of stack.node.findAll()) {
      if (resource instanceof CfnResource && resource.cfnResourceType === 'AWS::IAM::Role' && !(resource instanceof CfnRole)) {
        resource.addPropertyOverride('Tags', [{ Key: 'Project', Value: 'appointment-portal' }]);
      }
    }
    const period = Duration.minutes(1);
    const alarm = (name: string, metric: Metric) => new Alarm(this, name, {
      metric, threshold: 1, evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    for (const [feature, fn] of Object.entries(functions)) {
      alarm(`${feature}Errors`, fn.metricErrors({ period, statistic: 'Sum' }));
      alarm(`${feature}Throttles`, fn.metricThrottles({ period, statistic: 'Sum' }));
    }
    alarm('Api5xx', httpApi.metricServerError({ period, statistic: 'Sum' }));
    new LogGroup(this, 'ProxyLogs', {
      logGroupName: `/aws/rds/proxy/${proxy.dbProxyName}`,
      retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY,
    });
    // CDK's bucket emptying provider is a maintenance Lambda outside our three API
    // functions. Bind any such provider to an explicit group instead of letting
    // its first invocation create an unbounded, orphaned /aws/lambda group.
    for (const fn of stack.node.findAll().filter((node): node is CfnResource => node instanceof CfnResource && node.cfnResourceType === 'AWS::Lambda::Function')) {
      if (fn instanceof CfnFunction && fn.loggingConfig !== undefined) continue;
      const group = new LogGroup(this, `${Names.uniqueId(fn)}Logs`, {
        logGroupName: `/appointment-portal/${stack.stackName}/maintenance/${Names.uniqueId(fn)}`,
        retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY,
      });
      fn.addPropertyOverride('LoggingConfig.LogGroup', group.logGroupName);
    }
    const proxyMetric = (metricName: string, statistic: string) => new Metric({ namespace: 'AWS/RDS', metricName,
      dimensionsMap: { ProxyName: proxy.dbProxyName }, period, statistic });
    this.dashboard = new Dashboard(this, 'Dashboard', { dashboardName: `${stack.stackName}-operations` });
    this.dashboard.addWidgets(
      new GraphWidget({ title: 'API latency (ms)', width: 12, left: [httpApi.metricLatency({ period, statistic: 'Average' }), httpApi.metricIntegrationLatency({ period, statistic: 'Average' })] }),
      new GraphWidget({ title: 'API errors', width: 12, left: [httpApi.metricServerError({ period, statistic: 'Sum' }), httpApi.metricClientError({ period, statistic: 'Sum' })] }),
      new GraphWidget({ title: 'Lambda duration (ms)', width: 12, left: Object.values(functions).map((fn) => fn.metricDuration({ period, statistic: 'Average' })) }),
      new GraphWidget({ title: 'Lambda errors and throttles', width: 12, left: Object.values(functions).flatMap((fn) => [fn.metricErrors({ period, statistic: 'Sum' }), fn.metricThrottles({ period, statistic: 'Sum' })]) }),
      new GraphWidget({ title: 'Database and proxy connections', width: 12, left: [database.metricDatabaseConnections({ period, statistic: 'Average' }), proxyMetric('ClientConnections', 'Sum'), proxyMetric('DatabaseConnections', 'Sum')] }),
      new GraphWidget({ title: 'Proxy borrow latency (microseconds)', width: 12, left: [proxyMetric('DatabaseConnectionsBorrowLatency', 'Average')] }),
    );
  }
}
