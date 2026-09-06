import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parsePortalConfig, type PortalConfig } from '../lib/config.js';
import { PortalStack } from '../lib/portal-stack.js';

const defaults: PortalConfig = {
  account: '111111111111', region: 'eu-north-1', postgresVersion: '17.6',
  phase: 'bootstrap', qualifier: 'portal123',
};
const synth = (overrides: Partial<PortalConfig> = {}) => {
  const config = parsePortalConfig({ ...defaults, ...overrides });
  const app = new App({ context: {
    [`availability-zones:account=${config.account}:region=${config.region}`]: [`${config.region}a`, `${config.region}b`],
  } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010',
    reason: 'Tests cache fictional concrete AZs for deterministic offline synthesis.' });
  const stack = new PortalStack(app, 'TestPortal', {
    env: { account: config.account, region: config.region }, config,
  });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return { stack, template };
};
const one = (template: Template, type: string) => {
  const entries = Object.entries(template.findResources(type));
  expect(entries).toHaveLength(1);
  return entries[0]!;
};

describe('Cognito managed login', () => {
  it('requires verified email registration and email recovery with optional TOTP and no SMS', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'ESSENTIALS', AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      UsernameAttributes: ['email'], UsernameConfiguration: { CaseSensitive: false },
      AutoVerifiedAttributes: ['email'],
      Schema: Match.arrayWith([{ Name: 'email', Required: true, Mutable: true }]),
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      SmsConfiguration: Match.absent(),
    });
    template.resourceCountIs('AWS::Cognito::IdentityPool', 0);
    // The only IAM role is the existing RDS Proxy role; identity must add none.
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  it('allows only public code OAuth with exactly the frontend scopes and short token validity', () => {
    const { template } = synth();
    const [poolId] = one(template, 'AWS::Cognito::UserPool');
    const [serverId] = one(template, 'AWS::Cognito::UserPoolResourceServer');
    template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'portal', UserPoolId: { Ref: poolId },
      Scopes: [{ ScopeName: 'access', ScopeDescription: 'Access the appointment portal API' }],
    });
    const [, client] = one(template, 'AWS::Cognito::UserPoolClient');
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      UserPoolId: { Ref: poolId }, GenerateSecret: false,
      AllowedOAuthFlows: ['code'], AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'profile', 'portal/access'],
      SupportedIdentityProviders: ['COGNITO'],
      AccessTokenValidity: 5, RefreshTokenValidity: 1440,
      TokenValidityUnits: { AccessToken: 'minutes', RefreshToken: 'minutes' },
      PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true,
    });
    expect(client.DependsOn).toContain(serverId);
  });

  it('provisions newer managed login and client branding after its domain', () => {
    const { template } = synth();
    const [poolId] = one(template, 'AWS::Cognito::UserPool');
    const [clientId] = one(template, 'AWS::Cognito::UserPoolClient');
    const [domainId] = one(template, 'AWS::Cognito::UserPoolDomain');
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      UserPoolId: { Ref: poolId }, ManagedLoginVersion: 2,
    });
    const [, branding] = one(template, 'AWS::Cognito::ManagedLoginBranding');
    expect(branding.Properties).toEqual({
      UserPoolId: { Ref: poolId }, ClientId: { Ref: clientId }, UseCognitoProvidedValues: true,
    });
    expect(branding.DependsOn).toContain(domainId);
  });

  it('registers only explicit local callbacks in bootstrap, even if an origin is supplied', () => {
    const { template } = synth({ frontendUrl: 'https://demo.cloudfront.net' });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['http://localhost:5173/auth/callback'], LogoutURLs: ['http://localhost:5173/signed-out'],
    });
  });

  it('adds literal HTTPS ready URLs without replacing the pool, client, or domain', () => {
    const bootstrap = synth().template;
    const ready = synth({ phase: 'ready', frontendUrl: 'https://demo.cloudfront.net' }).template;
    const [, client] = one(ready, 'AWS::Cognito::UserPoolClient');
    expect(client.Properties.CallbackURLs).toEqual(['http://localhost:5173/auth/callback', 'https://demo.cloudfront.net/auth/callback']);
    expect(client.Properties.LogoutURLs).toEqual(['http://localhost:5173/signed-out', 'https://demo.cloudfront.net/signed-out']);
    // Exact strings rule out any CloudFront Ref/GetAtt (including nested Join/Sub).
    for (const value of [...client.Properties.CallbackURLs, ...client.Properties.LogoutURLs]) expect(typeof value).toBe('string');
    for (const type of ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient', 'AWS::Cognito::UserPoolDomain']) {
      expect(one(ready, type)[0]).toBe(one(bootstrap, type)[0]);
    }
    expect(one(ready, 'AWS::Cognito::UserPool')[1]).toEqual(one(bootstrap, 'AWS::Cognito::UserPool')[1]);
    expect(one(ready, 'AWS::Cognito::UserPoolDomain')[1]).toEqual(one(bootstrap, 'AWS::Cognito::UserPoolDomain')[1]);
    const withoutUrls = (template: Template) => {
      const properties = { ...one(template, 'AWS::Cognito::UserPoolClient')[1].Properties };
      delete properties.CallbackURLs; delete properties.LogoutURLs;
      return properties;
    };
    expect(withoutUrls(ready)).toEqual(withoutUrls(bootstrap));
  });

  it('uses a stable valid domain prefix unique to account, region, and project qualifier', () => {
    const prefix = (config: Partial<PortalConfig> = {}) => one(synth(config).template, 'AWS::Cognito::UserPoolDomain')[1].Properties.Domain;
    const baseline = prefix();
    expect(prefix()).toBe(baseline);
    const prefixes = [baseline, prefix({ account: '222222222222' }), prefix({ region: 'eu-west-1' }), prefix({ qualifier: 'other123' })];
    expect(new Set(prefixes).size).toBe(4);
    for (const value of prefixes) {
      expect(value).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
      expect(value).not.toMatch(/aws|amazon|cognito/);
    }
  });

  it('deletes all identity resources and applies the project tag to the pool', () => {
    const { template } = synth();
    for (const type of ['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient', 'AWS::Cognito::UserPoolResourceServer',
      'AWS::Cognito::UserPoolDomain', 'AWS::Cognito::ManagedLoginBranding']) {
      const [, resource] = one(template, type);
      expect(resource.DeletionPolicy).toBe('Delete');
      expect(resource.UpdateReplacePolicy).toBe('Delete');
    }
    template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTags: { Project: 'appointment-portal' } });
  });

  it('exposes pool, client, domain and issuer for API and public frontend configuration', () => {
    const { stack, template } = synth();
    const [poolId] = one(template, 'AWS::Cognito::UserPool');
    const [clientId] = one(template, 'AWS::Cognito::UserPoolClient');
    expect(stack.resolve(stack.identity.userPool.userPoolId)).toEqual({ Ref: poolId });
    expect(stack.resolve(stack.identity.appClient.userPoolClientId)).toEqual({ Ref: clientId });
    expect(stack.resolve(stack.identity.issuer)).toEqual({ 'Fn::GetAtt': [poolId, 'ProviderURL'] });
    expect(stack.identity.apiScope).toBe('portal/access');
    expect(stack.identity.domain.baseUrl()).toContain('.auth.eu-north-1.');
  });
});
