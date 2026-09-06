import { createHash } from 'node:crypto';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AccountRecovery, CfnManagedLoginBranding, FeaturePlan, ManagedLoginVersion, Mfa,
  OAuthScope, ResourceServerScope, UserPool, UserPoolClientIdentityProvider,
  type UserPoolClient, type UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { parsePortalConfig, type PortalConfig } from './config.js';

export class IdentityConstruct extends Construct {
  readonly userPool: UserPool;
  readonly appClient: UserPoolClient;
  readonly domain: UserPoolDomain;
  readonly issuer: string;
  readonly apiScope = 'portal/access';

  constructor(scope: Construct, id: string, props: { config: PortalConfig }) {
    super(scope, id);
    const config = parsePortalConfig(props.config);
    this.userPool = new UserPool(this, 'UserPool', {
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      enableSmsRole: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: 'portal',
      scopes: [new ResourceServerScope({ scopeName: 'access', scopeDescription: 'Access the appointment portal API' })],
    });
    // Hash concrete project/environment inputs to keep the prefix bounded and free
    // of Cognito's reserved words, including when a qualifier contains one.
    const domainSuffix = createHash('sha256')
      .update(JSON.stringify(['appointment-portal', config.account, config.region, config.qualifier]))
      .digest('hex').slice(0, 24);
    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `appointment-portal-${domainSuffix}` },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const callbackUrls = ['http://localhost:5173/auth/callback'];
    const logoutUrls = ['http://localhost:5173/signed-out'];
    if (config.phase === 'ready') {
      // Validated literal deployment output, never a reference to Web/CloudFront.
      callbackUrls.push(`${config.frontendUrl}/auth/callback`);
      logoutUrls.push(`${config.frontendUrl}/signed-out`);
    }
    this.appClient = this.userPool.addClient('AppClient', {
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [OAuthScope.OPENID, OAuthScope.PROFILE, OAuthScope.custom(this.apiScope)],
        callbackUrls, logoutUrls,
      },
      accessTokenValidity: Duration.minutes(5),
      refreshTokenValidity: Duration.days(1),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
    // The scope is literal, so CloudFormation needs an explicit creation dependency.
    this.appClient.node.addDependency(resourceServer);
    const branding = new CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.appClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(this.domain);
    this.issuer = this.userPool.userPoolProviderUrl;
  }
}
