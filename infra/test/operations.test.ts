import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PortalStack } from '../lib/portal-stack.js';

const synth = (phase: 'bootstrap' | 'ready' = 'ready') => {
  const env = { account: '111111111111', region: 'eu-north-1' };
  const app = new App({ context: { 'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'] } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010', reason: 'Offline tests use fictional cached AZs.' });
  const stack = new PortalStack(app, 'TestPortal', { env,
    config: { ...env, postgresVersion: '17.6', phase, qualifier: 'portal123',
      ...(phase === 'ready' ? { frontendUrl: 'https://demo.cloudfront.net' } : {}) } });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return { stack, template };
};

describe('bounded disposable operations', () => {
  it.each(['bootstrap', 'ready'] as const)('%s creates literal-named proxy logs before the proxy and deletes them after it', (phase) => {
    const { template } = synth(phase);
    const [proxyId, proxy] = Object.entries(template.findResources('AWS::RDS::DBProxy'))[0]!;
    const expectedName = 'appointment-portal-portal123';
    expect.soft(proxy.Properties.DBProxyName).toBe(expectedName);
    const [logId, logs] = Object.entries(template.findResources('AWS::Logs::LogGroup')).find(([, resource]) =>
      JSON.stringify(resource.Properties.LogGroupName).includes('/aws/rds/proxy/'))!;
    expect.soft(logs.Properties.LogGroupName).toBe(`/aws/rds/proxy/${expectedName}`);
    expect.soft(proxy.DependsOn ?? []).toContain(logId);
    expect.soft(logs.DependsOn ?? []).not.toContain(proxyId);
    expect.soft(JSON.stringify(logs)).not.toContain(proxyId);
    // Template.fromStack also rejects dependency cycles during synthesis.
  });

  it('finds the S3 maintenance Lambda, role and log group in the project-tag inventory', () => {
    const { template } = synth();
    const functions = template.findResources('AWS::Lambda::Function');
    const [functionId, fn] = Object.entries(functions).find(([, resource]) => !resource.Properties.VpcConfig)!;
    const projectTag = { Key: 'Project', Value: 'appointment-portal' };
    const inventory = Object.entries(template.toJSON().Resources).filter(([, resource]) => {
      const tags = (resource as { Properties?: { Tags?: { Key: string; Value: string }[] } }).Properties?.Tags ?? [];
      return Array.isArray(tags) && tags.some((tag) => tag.Key === projectTag.Key && tag.Value === projectTag.Value);
    }).map(([id]) => id);
    expect(inventory).toContain(functionId);
    expect(inventory).toContain(fn.Properties.Role['Fn::GetAtt'][0]);
    expect(inventory).toContain(fn.Properties.LoggingConfig.LogGroup.Ref);
    expect(Object.keys(functions).every((id) => inventory.includes(id))).toBe(true);
  });

  it('assigns named one-week log groups to every Lambda and API stage, plus the proxy', () => {
    const { template } = synth();
    const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    expect(groups.length).toBeGreaterThanOrEqual(6);
    for (const group of groups) {
      expect(group.Properties.RetentionInDays).toBe(7);
      expect(group.Properties.LogGroupName).toBeDefined();
      expect(group.DeletionPolicy).toBe('Delete'); expect(group.UpdateReplacePolicy).toBe('Delete');
    }
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) expect(fn.Properties.LoggingConfig.LogGroup).toBeDefined();
    expect(groups.some((group) => JSON.stringify(group.Properties.LogGroupName).includes('/aws/rds/proxy/'))).toBe(true);
  });

  it('alarms on errors/throttles per feature and API 5xx with nonbreaching missing data', () => {
    const { template } = synth();
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((resource) => resource.Properties);
    expect(alarms).toHaveLength(7);
    for (const alarm of alarms) {
      expect(alarm).toMatchObject({ TreatMissingData: 'notBreaching', EvaluationPeriods: 1,
        Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', Statistic: 'Sum', Period: 60 });
      expect(alarm.AlarmActions).toBeUndefined();
    }
    const functions = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([, resource]) => /^Appointment portal \w+ API$/.test(resource.Properties.Description ?? ''));
    for (const [id] of functions) for (const metric of ['Errors', 'Throttles']) {
      expect(alarms).toContainEqual(expect.objectContaining({ Namespace: 'AWS/Lambda', MetricName: metric,
        Dimensions: [{ Name: 'FunctionName', Value: { Ref: id } }] }));
    }
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0]!;
    expect(alarms).toContainEqual(expect.objectContaining({ Namespace: 'AWS/ApiGateway', MetricName: '5xx', Dimensions: [{ Name: 'ApiId', Value: { Ref: apiId } }] }));
  });

  it('dashboards API/Lambda latency and errors, database/proxy connections and borrow latency', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const dashboardBody = Object.values(template.findResources('AWS::CloudWatch::Dashboard'))[0]!.Properties.DashboardBody;
    const body = JSON.stringify(dashboardBody);
    for (const metric of ['Latency', 'IntegrationLatency', '5xx', '4xx', 'Duration', 'Errors', 'Throttles', 'DatabaseConnections', 'ClientConnections', 'DatabaseConnectionsBorrowLatency']) expect(body).toContain(metric);
    for (const dimension of ['ApiId', 'FunctionName', 'DBInstanceIdentifier', 'ProxyName']) expect(body).toContain(dimension);
    expect(body).toContain('AWS/RDS'); expect(body).toContain('Sum');
    // CDK omits CloudWatch's default Average statistic. Resolve only the Join
    // for inspection, substituting stable fake resource identifiers for tokens.
    const rendered = JSON.parse(dashboardBody['Fn::Join'][1].map((part: unknown) => typeof part === 'string' ? part : 'fixture-id').join(''));
    const widgets = rendered.widgets as { properties: { metrics: (string | { stat?: string; period: number })[][] } }[];
    const borrow = widgets.flatMap((widget) => widget.properties.metrics).find((metric) => metric[1] === 'DatabaseConnectionsBorrowLatency')!;
    expect(borrow.slice(0, 4)).toEqual(['AWS/RDS', 'DatabaseConnectionsBorrowLatency', 'ProxyName', 'fixture-id']);
    const options = borrow.at(-1) as { stat?: string; period: number };
    expect(options.stat ?? 'Average').toBe('Average'); expect(options.period).toBe(60);
  });

  it.each(['bootstrap', 'ready'] as const)('%s exposes exact public/operation outputs and destroys every resource', (phase) => {
    const { stack, template } = synth(phase);
    const outputs = template.toJSON().Outputs;
    expect(Object.keys(outputs).sort()).toEqual(['FrontendUrl', 'ApiUrl', 'DistributionId', 'WebBucketName', 'UserPoolId', 'ClientId', 'Issuer', 'CognitoDomain', 'ProxyName', 'DatabaseId', 'MigrationFunctionName'].sort());
    const output = (name: string, value: unknown) => expect(outputs[name].Value).toEqual(stack.resolve(value));
    output('UserPoolId', stack.identity.userPool.userPoolId); output('ClientId', stack.identity.appClient.userPoolClientId);
    output('Issuer', stack.identity.issuer); output('CognitoDomain', stack.identity.domain.baseUrl());
    output('ProxyName', stack.data.proxy.dbProxyName); output('DatabaseId', stack.data.database.instanceIdentifier);
    output('MigrationFunctionName', stack.data.migrationFunction.functionName);
    for (const resource of Object.values(template.toJSON().Resources) as { DeletionPolicy: string; UpdateReplacePolicy: string }[]) {
      expect(resource.DeletionPolicy).toBe('Delete'); expect(resource.UpdateReplacePolicy).toBe('Delete');
    }
  });
});
