import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { App, Validations } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CachePolicy, OriginRequestPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { describe, expect, it } from 'vitest';
import { PortalStack } from '../lib/portal-stack.js';

const source = readFileSync(new URL('../functions/spa-rewrite.js', import.meta.url), 'utf8');
const rewrite = (uri: string) => runInNewContext(`${source}\nhandler(event)`, {
  event: { request: { uri, method: 'GET', headers: {}, querystring: { code: { value: 'not-logged' } } } },
}, { timeout: 100 }).uri;
const synth = () => {
  const env = { account: '111111111111', region: 'eu-north-1' };
  const app = new App({ context: { 'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'] } });
  Validations.of(app).acknowledge({ id: 'CloudFormation-Validate::W3010', reason: 'Offline tests use fictional cached AZs.' });
  const stack = new PortalStack(app, 'TestPortal', { env,
    config: { ...env, postgresVersion: '17.6', phase: 'ready', frontendUrl: 'https://demo.cloudfront.net', qualifier: 'portal123' } });
  const template = Template.fromStack(stack);
  expect(app.synth().manifest.missing ?? []).toEqual([]);
  return { stack, template };
};

describe('frontend-only SPA rewriting', () => {
  it.each(['/', '/appointments', '/clinicians', '/clinicians/123', '/clinician/availability', '/clinician/appointments', '/auth/callback', '/signed-out', '/appointments/'])('rewrites page %s', (uri) => {
    expect(rewrite(uri)).toBe('/index.html');
  });
  it.each(['/api', '/api/', '/api/appointments', '/api/missing', '/assets', '/assets/', '/assets/missing', '/assets/app.js',
    '/config.json', '/index.html', '/favicon.ico', '/missing.js', '/images/missing', '/clinicians/file.json', '/api%2fappointments', '/unknown'])('preserves non-page %s', (uri) => {
    expect(rewrite(uri)).toBe(uri);
  });
  it('preserves query data and other request fields during callback rewriting', () => {
    const request = { uri: '/auth/callback', method: 'GET', headers: { accept: { value: 'text/html' } }, querystring: { code: { value: 'code' } } };
    expect(runInNewContext(`${source}\nhandler(event)`, { event: { request } }, { timeout: 100 })).toEqual({ ...request, uri: '/index.html' });
  });
});

describe('CloudFront and private S3', () => {
  it('uses an SSL-only private disposable bucket with distribution-restricted OAC reads', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    const [bucketId, bucket] = Object.entries(template.findResources('AWS::S3::Bucket'))[0]!;
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
    expect(bucket.Properties.WebsiteConfiguration).toBeUndefined();
    expect(bucket.DeletionPolicy).toBe('Delete'); expect(bucket.UpdateReplacePolicy).toBe('Delete');
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    template.hasResourceProperties('Custom::S3AutoDeleteObjects', { BucketName: { Ref: bucketId } });
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', { OriginAccessControlConfig: {
      OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4',
    } });
    const policy = Object.values(template.findResources('AWS::S3::BucketPolicy'))[0]!.Properties.PolicyDocument.Statement;
    expect(policy).toContainEqual(expect.objectContaining({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }));
    const read = policy.find((statement: { Principal?: { Service?: string } }) => statement.Principal?.Service === 'cloudfront.amazonaws.com');
    expect(read).toMatchObject({ Effect: 'Allow', Action: 's3:GetObject' });
    expect(JSON.stringify(read.Condition)).toContain('Distribution');
  });

  it('forwards /api and /api/* uncached over TLS without the viewer Host and preserves API status codes', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    const config = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    const apiBehaviors = config.CacheBehaviors.filter((behavior: { PathPattern: string }) => ['/api', '/api/*'].includes(behavior.PathPattern));
    expect(apiBehaviors).toHaveLength(2);
    for (const behavior of apiBehaviors) {
      expect(behavior).toMatchObject({ CachePolicyId: CachePolicy.CACHING_DISABLED.cachePolicyId,
        OriginRequestPolicyId: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
        ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'] });
      expect(behavior.FunctionAssociations).toBeUndefined();
      const origin = config.Origins.find((value: { Id: string }) => value.Id === behavior.TargetOriginId);
      expect(origin.CustomOriginConfig).toMatchObject({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
      expect(JSON.stringify(origin.DomainName)).toContain('ApiEndpoint');
      expect(origin.OriginPath).toBeUndefined();
    }
    expect(config.CustomErrorResponses).toBeUndefined();
  });

  it('revalidates shell/config while enabling immutable published assets and frontend-only functions', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFront::Function', 1);
    const config = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    expect(config.DefaultRootObject).toBe('index.html');
    expect(config.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(config.DefaultCacheBehavior.CachePolicyId).toBe(CachePolicy.CACHING_DISABLED.cachePolicyId);
    expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    expect(config.DefaultCacheBehavior.FunctionAssociations[0].EventType).toBe('viewer-request');
    const assets = config.CacheBehaviors.find((behavior: { PathPattern: string }) => behavior.PathPattern === '/assets/*');
    expect(assets).toBeDefined(); expect(assets.FunctionAssociations).toBeUndefined();
    const policyId = assets.CachePolicyId.Ref;
    expect(template.findResources('AWS::CloudFront::CachePolicy')[policyId]!.Properties.CachePolicyConfig)
      .toMatchObject({ MinTTL: 0, DefaultTTL: 0, MaxTTL: 31536000 });
    const deployedSource = Object.values(template.findResources('AWS::CloudFront::Function'))[0]!.Properties.FunctionCode;
    expect(deployedSource).toBe(source);
  });

  it('applies strict same-origin/Cognito security headers without CORS or broad CSP sources', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1);
    const config = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]!.Properties.ResponseHeadersPolicyConfig;
    expect(config.CorsConfig).toBeUndefined();
    expect(config.SecurityHeadersConfig).toMatchObject({ ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: 'DENY', Override: true }, ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
      StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Override: true } });
    const csp = JSON.stringify(config.SecurityHeadersConfig.ContentSecurityPolicy);
    for (const directive of ["default-src 'self'", "script-src 'self';", "style-src 'self' 'unsafe-inline';", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(directive);
    expect(csp).toContain('connect-src'); expect(csp).toContain('cognito-idp.eu-north-1.'); expect(csp).toContain('.auth.eu-north-1.');
    expect(csp).not.toMatch(/unsafe-eval|https:\*|https:\/\/\*|localhost|(?:script|style)-src[^;]*https:/);
    expect(csp.match(/unsafe-inline/g)).toHaveLength(1);
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    for (const behavior of [distribution.DefaultCacheBehavior, ...distribution.CacheBehaviors]) expect(behavior.ResponseHeadersPolicyId).toBeDefined();
  });
});
