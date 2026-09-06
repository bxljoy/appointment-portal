import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { describe, expect, it } from 'vitest';
import { PortalStack } from '../lib/portal-stack.js';

const env = { account: '111111111111', region: 'eu-north-1' };
const synth = (phase: 'bootstrap' | 'ready') => {
  const app = new App({ context: {
    'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'],
  } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010', reason: 'Offline tests use fictional cached AZs.' });
  const stack = new PortalStack(app, 'TestPortal', {
    env, config: { ...env, postgresVersion: '17.6', phase, qualifier: 'portal123',
      ...(phase === 'ready' ? { frontendUrl: 'https://demo.cloudfront.net' } : {}) },
  });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return { stack, template, assemblyDirectory: app.outdir };
};
const expectedRoutes: Record<string, string> = {
  'GET /api/me': 'profiles', 'GET /api/clinicians': 'profiles', 'GET /api/clinicians/{id}': 'profiles',
  'GET /api/clinicians/{id}/slots': 'availability', 'GET /api/availability': 'availability',
  'POST /api/availability': 'availability', 'POST /api/availability/{id}/withdraw': 'availability',
  'GET /api/appointments': 'appointments', 'POST /api/appointments': 'appointments',
  'POST /api/appointments/{id}/cancel': 'appointments',
};

describe.each(['bootstrap', 'ready'] as const)('%s API trust boundary', (phase) => {
  it('maps exactly ten routes to three feature integrations and authorizes every direct-origin request', () => {
    const { template } = synth(phase);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    const authorizers = Object.entries(template.findResources('AWS::ApiGatewayV2::Authorizer'));
    expect(authorizers).toHaveLength(1);
    const [authorizerId, authorizer] = authorizers[0]!;
    const poolId = Object.keys(template.findResources('AWS::Cognito::UserPool'))[0]!;
    const clientId = Object.keys(template.findResources('AWS::Cognito::UserPoolClient'))[0]!;
    expect(authorizer.Properties).toMatchObject({ AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: { Issuer: { 'Fn::GetAtt': [poolId, 'ProviderURL'] }, Audience: [{ Ref: clientId }] } });
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.map((route) => route.Properties.RouteKey).sort()).toEqual(Object.keys(expectedRoutes).sort());
    const integrations = template.findResources('AWS::ApiGatewayV2::Integration');
    expect(Object.keys(integrations)).toHaveLength(3);
    const functions = template.findResources('AWS::Lambda::Function');
    for (const { Properties: route } of routes) {
      expect(route.AuthorizationType).toBe('JWT');
      expect(route.AuthorizationScopes).toEqual(['portal/access']);
      expect(route.AuthorizerId).toEqual({ Ref: authorizerId });
      const integrationId = route.Target['Fn::Join'][1][1].Ref;
      const integration = integrations[integrationId]!.Properties;
      expect(integration).toMatchObject({ IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0' });
      const functionId = integration.IntegrationUri['Fn::GetAtt'][0];
      expect(functions[functionId]!.Properties.Description).toBe(`Appointment portal ${expectedRoutes[route.RouteKey]} API`);
    }
    const api = Object.values(template.findResources('AWS::ApiGatewayV2::Api'))[0]!.Properties;
    expect(api.CorsConfiguration).toBeUndefined();
    expect(api.DisableExecuteApiEndpoint ?? false).toBe(false);
  });

  it('bounds three Node 24 feature functions to the proxy network and application credential only', () => {
    const { template } = synth(phase);
    const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter((resource) => resource.Properties.VpcConfig);
    expect(functions).toHaveLength(3);
    const applicationId = Object.keys(template.findResources('AWS::SecretsManager::Secret')).find((id) => id.includes('ApplicationSecret'))!;
    const adminId = Object.keys(template.findResources('AWS::SecretsManager::Secret')).find((id) => id.includes('AdminSecret'))!;
    const proxyId = Object.keys(template.findResources('AWS::RDS::DBProxy'))[0]!;
    const databaseId = Object.keys(template.findResources('AWS::RDS::DBInstance'))[0]!;
    const apiSg = Object.entries(template.findResources('AWS::EC2::SecurityGroup')).find(([, resource]) => resource.Properties.GroupDescription === 'API functions')![0];
    const subnets = Object.keys(template.findResources('AWS::EC2::Subnet')).map((Ref) => ({ Ref }));
    for (const { Properties: fn } of functions) {
      expect(fn).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'], MemorySize: 512,
        Timeout: 15, ReservedConcurrentExecutions: 5, Handler: 'index.handler',
        LoggingConfig: { LogFormat: 'JSON' },
        VpcConfig: { SecurityGroupIds: [{ 'Fn::GetAtt': [apiSg, 'GroupId'] }], SubnetIds: subnets },
        Environment: { Variables: { APPLICATION_DATABASE_SECRET_ARN: { Ref: applicationId },
          DATABASE_HOST: { 'Fn::GetAtt': [proxyId, 'Endpoint'] }, DATABASE_NAME: 'portal', DATABASE_PORT: '5432',
          DATABASE_CA_BUNDLE_PATH: '/var/task/certs/rds-global-bundle.pem' } } });
      expect(JSON.stringify(fn)).not.toContain(adminId);
      expect(JSON.stringify(fn)).not.toContain(databaseId);
      const roleId = fn.Role['Fn::GetAtt'][0];
      const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((resource) => resource.Properties.Roles.some((role: { Ref: string }) => role.Ref === roleId));
      const statements = policies.flatMap((resource) => resource.Properties.PolicyDocument.Statement);
      const secretStatements = statements.filter((statement) => JSON.stringify(statement.Action).includes('secretsmanager:'));
      expect(secretStatements).toEqual([{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], Resource: { Ref: applicationId } }]);
      expect(JSON.stringify(statements)).not.toMatch(/rds-db:connect|rds:\*|secretsmanager:\*/);
      expect(JSON.stringify(statements)).not.toContain(adminId);
    }
  });

  it('throttles the default stage and writes only structured safe fields with the gateway request ID', () => {
    const { template } = synth(phase);
    template.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
    const stage = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'))[0]!.Properties;
    expect(stage).toMatchObject({ StageName: '$default', AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 } });
    expect(JSON.parse(stage.AccessLogSettings.Format)).toEqual({ requestId: '$context.requestId',
      routeKey: '$context.routeKey', status: '$context.status', responseLength: '$context.responseLength',
      integrationLatency: '$context.integrationLatency', responseLatency: '$context.responseLatency' });
    expect(JSON.stringify(stage.AccessLogSettings.DestinationArn)).toContain('AccessLogs');
  });

  it('packages importable feature handlers with the SDK and public RDS CA assets in the actual CDK artifacts', async () => {
    const { stack, assemblyDirectory } = synth(phase);
    const expectedCa = readFileSync(new URL('../assets/rds-global-bundle.pem', import.meta.url), 'utf8');
    expect(expectedCa).not.toContain('PRIVATE KEY');
    const certificates = expectedCa.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
    expect(certificates.length).toBeGreaterThan(0);
    for (const pem of certificates) expect(new X509Certificate(pem).ca).toBe(true);
    for (const [feature, fn] of Object.entries(stack.api.functions)) {
      const asset = fn.node.findChild('Code') as Asset;
      const assetDirectory = join(assemblyDirectory, asset.assetPath);
      const metadata = JSON.parse(readFileSync(join(assetDirectory, 'index.meta.json'), 'utf8'));
      const inputs = Object.keys(metadata.inputs);
      expect(inputs.some((input) => input.endsWith(`src/modules/${feature}/handler.ts`))).toBe(true);
      expect(inputs.some((input) => input.includes('/@aws-sdk/client-secrets-manager/'))).toBe(true);
      expect(inputs.some((input) => /(?:^|\/)(?:local|test|tests)\//.test(input))).toBe(false);
      const outputs = Object.values(metadata.outputs) as { imports: { path: string; external?: boolean }[] }[];
      expect(outputs).toHaveLength(1);
      for (const dependency of outputs[0]!.imports) expect(dependency.external && (isBuiltin(dependency.path) || dependency.path === 'pg-native')).toBe(true);
      expect(readFileSync(join(assetDirectory, 'certs/rds-global-bundle.pem'), 'utf8')).toBe(expectedCa);
      const bundle = join(assetDirectory, 'index.mjs');
      expect(readFileSync(bundle, 'utf8')).not.toMatch(/X-Local-Actor|LOCAL_AUTH_DEVELOPMENT_ONLY|src\/local\/|local\/identity/);
      expect(typeof (await import(pathToFileURL(bundle).href)).handler).toBe('function');
    }
  });
});
