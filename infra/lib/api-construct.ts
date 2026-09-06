import { join } from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { DataConstruct } from './data-construct.js';
import type { IdentityConstruct } from './identity-construct.js';
import { workspaceRoot } from './workspace-path.js';

type Feature = 'profiles' | 'availability' | 'appointments';
export type FeatureFunctions = Record<Feature, NodejsFunction>;
type ApiProps = { data: DataConstruct; identity: IdentityConstruct };
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class ApiConstruct extends Construct {
  readonly httpApi: HttpApi;
  readonly functions: FeatureFunctions;
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, { data, identity }: ApiProps) {
    super(scope, id);
    const logGroup = (name: string) => new LogGroup(this, `${name}Logs`, {
      logGroupName: `/appointment-portal/${Stack.of(this).stackName}/api/${name.toLowerCase()}`,
      retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY,
    });
    const makeFunction = (feature: Feature) => {
      const fn = new NodejsFunction(this, feature, {
        description: `Appointment portal ${feature} API`,
        entry: join(workspaceRoot, `apps/api/src/modules/${feature}/handler.ts`),
        projectRoot: workspaceRoot, depsLockFilePath: join(workspaceRoot, 'pnpm-lock.yaml'),
        runtime: Runtime.NODEJS_24_X, architecture: Architecture.ARM_64,
        memorySize: 512, timeout: Duration.seconds(15), reservedConcurrentExecutions: 5,
        vpc: data.vpc, vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
        securityGroups: [data.apiSecurityGroup], logGroup: logGroup(feature), loggingFormat: LoggingFormat.JSON,
        environment: {
          APPLICATION_DATABASE_SECRET_ARN: data.applicationSecret.secretArn,
          DATABASE_HOST: data.proxy.endpoint, DATABASE_NAME: 'portal', DATABASE_PORT: '5432',
          DATABASE_CA_BUNDLE_PATH: '/var/task/certs/rds-global-bundle.pem',
        },
        bundling: {
          target: 'node24', format: OutputFormat.ESM, bundleAwsSDK: true, externalModules: [], metafile: true,
          banner: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);",
          commandHooks: {
            beforeBundling: () => [], beforeInstall: () => [],
            afterBundling: (input, output) => [
              `mkdir -p ${shellQuote(join(output, 'certs'))}`,
              `cp ${shellQuote(join(input, 'infra/assets/rds-global-bundle.pem'))} ${shellQuote(join(output, 'certs/rds-global-bundle.pem'))}`,
              `node ${shellQuote(join(input, 'infra/scripts/normalize-metafile.mjs'))} ${shellQuote(join(output, 'index.meta.json'))}`,
            ],
          },
        },
      });
      // The API cannot use bootstrap/admin credentials in either phase.
      data.applicationSecret.grantRead(fn);
      return fn;
    };
    this.functions = { profiles: makeFunction('profiles'), availability: makeFunction('availability'), appointments: makeFunction('appointments') };
    this.httpApi = new HttpApi(this, 'HttpApi', { createDefaultStage: false });
    const authorizer = new HttpJwtAuthorizer('PortalJwt', identity.issuer, {
      jwtAudience: [identity.appClient.userPoolClientId],
    });
    const integrations = {
      profiles: new HttpLambdaIntegration('ProfilesIntegration', this.functions.profiles),
      availability: new HttpLambdaIntegration('AvailabilityIntegration', this.functions.availability),
      appointments: new HttpLambdaIntegration('AppointmentsIntegration', this.functions.appointments),
    };
    const routes: [HttpMethod, string, Feature][] = [
      [HttpMethod.GET, '/api/me', 'profiles'], [HttpMethod.GET, '/api/clinicians', 'profiles'],
      [HttpMethod.GET, '/api/clinicians/{id}', 'profiles'], [HttpMethod.GET, '/api/clinicians/{id}/slots', 'availability'],
      [HttpMethod.GET, '/api/availability', 'availability'], [HttpMethod.POST, '/api/availability', 'availability'],
      [HttpMethod.POST, '/api/availability/{id}/withdraw', 'availability'], [HttpMethod.GET, '/api/appointments', 'appointments'],
      [HttpMethod.POST, '/api/appointments', 'appointments'], [HttpMethod.POST, '/api/appointments/{id}/cancel', 'appointments'],
    ];
    for (const [method, path, feature] of routes) {
      this.httpApi.addRoutes({ path, methods: [method], integration: integrations[feature],
        authorizer, authorizationScopes: [identity.apiScope] });
    }
    new HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi, stageName: '$default', autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(logGroup('Access')),
        format: AccessLogFormat.custom(JSON.stringify({ requestId: '$context.requestId', routeKey: '$context.routeKey',
          status: '$context.status', responseLength: '$context.responseLength', integrationLatency: '$context.integrationLatency',
          responseLatency: '$context.responseLatency' })),
      },
    });
    this.apiUrl = this.httpApi.apiEndpoint;
  }
}
