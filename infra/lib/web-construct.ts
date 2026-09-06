import { join } from 'node:path';
import { Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { workspaceRoot } from './workspace-path.js';

type WebProps = { apiUrl: string; cognitoDomain: string; cognitoIssuerOrigin: string };

export class WebConstruct extends Construct {
  readonly bucket: Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly frontendUrl: string;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);
    this.bucket = new Bucket(this, 'Bucket', { blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, versioned: false, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true });
    const frontendOrigin = S3BucketOrigin.withOriginAccessControl(this.bucket);
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { override: true, contentSecurityPolicy: [
          "default-src 'self'", "script-src 'self'",
          // Radix's react-remove-scroll-bar injects viewport-specific styles when
          // dialogs open. Revisit this exception if that dependency changes.
          "style-src 'self' 'unsafe-inline'", "img-src 'self'", "font-src 'self'",
          `connect-src 'self' ${props.cognitoDomain} ${props.cognitoIssuerOrigin}`,
          "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "frame-src 'none'", "form-action 'self'",
        ].join('; ') },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
      customHeadersBehavior: { customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()', override: true }] },
    });
    const rewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: join(workspaceRoot, 'infra/functions/spa-rewrite.js') }),
    });
    const common = { viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, responseHeadersPolicy: headers };
    const api: cloudfront.BehaviorOptions = {
      ...common, origin: new HttpOrigin(Fn.select(2, Fn.split('/', props.apiUrl)), {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY, originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      }),
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    };
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: { ...common, origin: frontendOrigin, cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }] },
      additionalBehaviors: {
        '/api': api, '/api/*': api,
        '/assets/*': { ...common, origin: frontendOrigin, cachePolicy: new cloudfront.CachePolicy(this, 'PublishedAssets', {
          minTtl: Duration.seconds(0), defaultTtl: Duration.seconds(0), maxTtl: Duration.days(365),
          enableAcceptEncodingBrotli: true, enableAcceptEncodingGzip: true,
        }) },
      },
    });
    this.frontendUrl = `https://${this.distribution.distributionDomainName}`;
  }
}
