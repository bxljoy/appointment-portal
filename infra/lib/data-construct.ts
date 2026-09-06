import { join } from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { parsePortalConfig, type PortalConfig } from './config.js';
import { workspaceRoot } from './workspace-path.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class DataConstruct extends Construct {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly proxy: rds.DatabaseProxy;
  readonly proxyName: string;
  readonly adminSecret: secretsmanager.Secret;
  readonly applicationSecret: secretsmanager.Secret;
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly migrationSecurityGroup: ec2.SecurityGroup;
  readonly migrationFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: { config: PortalConfig }) {
    super(scope, id);
    const config = parsePortalConfig(props.config);
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      // No resource uses the default SG; avoid a privileged custom-resource Lambda.
      restrictDefaultSecurityGroup: false,
    });
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
    const securityGroup = (name: string, description: string) => new ec2.SecurityGroup(this, name, {
      vpc: this.vpc, description, allowAllOutbound: false, disableInlineRules: true,
    });
    this.apiSecurityGroup = securityGroup('ApiSecurityGroup', 'API functions');
    this.migrationSecurityGroup = securityGroup('MigrationSecurityGroup', 'Migration function');
    const databaseSecurityGroup = securityGroup('DatabaseSecurityGroup', 'PostgreSQL database');
    const proxySecurityGroup = securityGroup('ProxySecurityGroup', 'Database proxy');
    const endpointSecurityGroup = securityGroup('EndpointSecurityGroup', 'Secrets Manager endpoint');

    this.adminSecret = new secretsmanager.Secret(this, 'AdminSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'portal_admin' }),
        generateStringKey: 'password', passwordLength: 32, excludePunctuation: true,
      }, removalPolicy: RemovalPolicy.DESTROY,
    });
    this.applicationSecret = new secretsmanager.Secret(this, 'ApplicationSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'portal_app' }),
        generateStringKey: 'password', passwordLength: 32, excludePunctuation: true,
      }, removalPolicy: RemovalPolicy.DESTROY,
    });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      vpc: this.vpc, vpcSubnets: isolated, securityGroups: [databaseSecurityGroup],
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of(config.postgresVersion, '17') }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      credentials: rds.Credentials.fromSecret(this.adminSecret), databaseName: 'portal', port: 5432,
      allocatedStorage: 20, storageType: rds.StorageType.GP3, storageEncrypted: true,
      publiclyAccessible: false, multiAz: false, deletionProtection: false,
      backupRetention: Duration.days(0), deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Keep the name independent of the resource Ref so operations can precreate
    // its service log group. The validated qualifier keeps this a valid RDS name.
    this.proxyName = `appointment-portal-${config.qualifier}`;
    this.proxy = new rds.DatabaseProxy(this, 'Proxy', {
      dbProxyName: this.proxyName,
      vpc: this.vpc, vpcSubnets: isolated, securityGroups: [proxySecurityGroup],
      proxyTarget: rds.ProxyTarget.fromInstance(this.database),
      // Bootstrap must become healthy before the migration creates portal_app.
      secrets: [config.phase === 'bootstrap' ? this.adminSecret : this.applicationSecret],
      requireTLS: true, iamAuth: false, debugLogging: false,
      maxConnectionsPercent: 60, maxIdleConnectionsPercent: 30, borrowTimeout: Duration.seconds(5),
    });

    this.apiSecurityGroup.connections.allowTo(proxySecurityGroup, ec2.Port.tcp(5432));
    this.migrationSecurityGroup.connections.allowTo(databaseSecurityGroup, ec2.Port.tcp(5432));
    // DatabaseProxy grants its security group the target database's port above.
    this.apiSecurityGroup.connections.allowTo(endpointSecurityGroup, ec2.Port.tcp(443));
    this.migrationSecurityGroup.connections.allowTo(endpointSecurityGroup, ec2.Port.tcp(443));
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true, subnets: isolated, securityGroups: [endpointSecurityGroup],
      open: false, lookupSupportedAzs: false,
    });

    this.migrationFunction = new NodejsFunction(this, 'Migration', {
      description: 'Appointment portal private migration and seed',
      entry: join(workspaceRoot, 'packages/database/src/lambda.ts'), projectRoot: workspaceRoot,
      depsLockFilePath: join(workspaceRoot, 'pnpm-lock.yaml'),
      runtime: Runtime.NODEJS_24_X, architecture: Architecture.ARM_64,
      memorySize: 512, timeout: Duration.seconds(120), reservedConcurrentExecutions: 1,
      vpc: this.vpc, vpcSubnets: isolated, securityGroups: [this.migrationSecurityGroup], loggingFormat: LoggingFormat.JSON,
      logGroup: new LogGroup(this, 'MigrationLogs', {
        logGroupName: `/appointment-portal/${Stack.of(this).stackName}/migration`,
        retention: RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        ADMIN_DATABASE_SECRET_ARN: this.adminSecret.secretArn, APPLICATION_DATABASE_SECRET_ARN: this.applicationSecret.secretArn,
        DATABASE_HOST: this.database.dbInstanceEndpointAddress, DATABASE_NAME: 'portal', DATABASE_PORT: '5432',
        DATABASE_CA_BUNDLE_PATH: '/var/task/certs/rds-global-bundle.pem', MIGRATIONS_PATH: '/var/task/migrations',
      },
      bundling: {
        target: 'node24', format: OutputFormat.ESM, bundleAwsSDK: true, externalModules: [], metafile: true,
        banner: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);",
        commandHooks: {
          beforeBundling: () => [], beforeInstall: () => [],
          afterBundling: (input, output) => [
            `mkdir -p ${shellQuote(join(output, 'certs'))}`,
            `cp ${shellQuote(join(input, 'infra/assets/rds-global-bundle.pem'))} ${shellQuote(join(output, 'certs/rds-global-bundle.pem'))}`,
            `cp -R ${shellQuote(join(input, 'packages/database/migrations'))} ${shellQuote(join(output, 'migrations'))}`,
            `node ${shellQuote(join(input, 'infra/scripts/normalize-metafile.mjs'))} ${shellQuote(join(output, 'index.meta.json'))}`,
          ],
        },
      },
    });
    this.adminSecret.grantRead(this.migrationFunction);
    this.applicationSecret.grantRead(this.migrationFunction);
  }
}
