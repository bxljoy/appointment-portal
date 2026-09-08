# Disposable deployment and database boundaries

The CDK application is in `infra/`. It provisions the private data foundation,
Cognito identity, three feature Lambdas, an HTTP API, the CloudFront/S3 frontend,
and bounded operational resources. Migration execution, frontend publication, and
lifecycle commands live in `scripts/`. Tests inject every cloud and process boundary;
they never deploy or contact AWS.

## Lifecycle control plane

`.runtime/deployment.json` is the recovery record. It stores account, Region, phase,
stack names, outputs, and owned/shared resource IDs after each successful phase. It
contains no keys, tokens, passwords, secret values, or browser state. A resumed ready
deployment migrates in place and cannot switch the proxy back to administrator auth.

CDK runs through executable/argument arrays with `shell: false`; cloud inspection,
migration, publication, and inventory use AWS SDK v3 clients. The publisher checks
the actual Cognito callback against CloudFront, uploads immutable content hashes
first, publishes public config and shell with `no-cache`, and waits for invalidation.

DeliveryStack uses exact audience `sts.amazonaws.com` and immutable subject
`repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:environment:demo`. GitHub environment policy supplies the
branch boundary because an environment claim replaces the ref form of `sub`.
GitHub's numeric repository-owner and repository IDs are validated in the private
configuration and carried through CDK context, so renaming either path segment does
not silently widen or break the identity boundary.
Delivery setup confirms both numeric IDs and the exact `sub_claim_prefix` through
authenticated GitHub API reads before mutation. A bootstrap-only legacy manifest may
adopt that identity only after CloudFormation confirms that no application stack exists;
the same absence check applies before setup creates a fresh identity-bound manifest.
Deployment assumes only `apptdemo` bootstrap roles. CloudFormation's execution role
owns template provisioning authority; runtime roles remain feature-scoped.

Cleanup uses the saved inventory as its ownership ceiling and refreshes paginated
service inventories after stack deletion. Application cleanup happens first.
Project-exclusive delivery/bootstrap removal needs explicit `--all` under local
credentials and happens last. Scheduled secrets and shared OIDC providers remain
separate from active owned leftovers.

## Configuration and offline synthesis

`PortalConfig` validates a concrete 12-digit account, AWS region name, explicit
PostgreSQL 17 minor version, `bootstrap` or `ready` phase, and a 1–10 character
lowercase alphanumeric CDK bootstrap qualifier. Uppercase is rejected because the
synthesizer includes the qualifier in its S3 asset bucket name. Use lowercase
context such as `-c qualifier=portal123`. The stack environment must match that account
and region. `ready` requires `frontendUrl`, a public HTTPS origin without a trailing
slash, path, credentials, query, or fragment. The default deployment region in the
approved design is `eu-north-1`; actual engine support remains a preflight check.
The test value `17.6` is a fixture, not a claim about current regional availability.
`lambdaConcurrencyMode` accepts only `reserved` or `shared-unreserved` and defaults
to `reserved`. Shared mode is limited to a controlled, disposable demo account whose
regional quota is too small to allocate reserved concurrency.

The CDK entrypoint reads `account`, `region`, `postgresVersion`, `phase`,
`lambdaConcurrencyMode`, `qualifier`, and optional `frontendUrl` from CDK context.
Nothing infers a deployment account or silently changes the phase. The synthesizer
uses the configured qualifier; the
corresponding bootstrap stack is separately inventoried and is not created here.

Run `pnpm test infra/test/data.test.ts infra/test/config.test.ts` from the root.
Tests synthesize both phases with fake account `111111111111`, region `eu-north-1`,
and the cached CDK context key
`availability-zones:account=111111111111:region=eu-north-1` containing
`["eu-north-1a", "eu-north-1b"]`. They assert that no context lookups remain.
`pnpm --filter @portal/infra typecheck` checks the infrastructure types;
`pnpm --filter @portal/infra synth` runs the CDK CLI with `--no-lookups` and requires
explicit context, including previously verified AZ context for the target account.
Keep account-specific `cdk.context.json` untracked.

## Network and credentials

The VPC has two isolated `/24` subnets, no NAT or internet gateway, and no public
database. Five dedicated security groups allow only these initiated connections:

| Source | Destination | TCP port |
| --- | --- | --- |
| API functions | RDS Proxy | 5432 |
| RDS Proxy | PostgreSQL | 5432 |
| Migration function | PostgreSQL | 5432 |
| API functions | Secrets Manager interface endpoint | 443 |
| Migration function | Secrets Manager interface endpoint | 443 |

The endpoint uses private DNS and does not admit the whole VPC CIDR. Its network
policy is supplemented by narrowly scoped secret IAM permissions on execution
roles. The default VPC security group is unused; CDK's optional default-group cleanup
custom resource is disabled to avoid adding a privileged Lambda. Every workload
must explicitly use its dedicated group. Database and endpoint outbound rules use
CDK's impossible ICMP sentinel to prevent EC2's implicit allow-all egress default.

Two Secrets Manager resources independently generate 32-character passwords for
`portal_admin` and `portal_app`. Only the admin secret is attached to the database
instance; RDS Proxy receives exactly one secret according to deployment phase:

1. **Bootstrap:** the proxy authenticates with the admin secret so its target can
   become healthy before `portal_app` exists. This is a temporary provisioning state.
   API functions must never receive the admin secret ARN or read permission, in
   either phase. Browser verification and frontend publication must not run yet.
2. **Provision:** the privileged migration function connects directly to RDS using
   the admin credential, creates the schema and least-privilege `portal_app` role,
   and assigns that role the password from the application secret (Task 14).
3. **Ready:** redeploy with `phase=ready` and the deployed frontend HTTPS origin.
   Proxy authentication and its IAM policy change to the application secret alone.
   Confirm proxy target health and application access before browser verification
   or publication (Task 17). Never use a ready proxy as evidence that provisioning
   ran; the phase value alone cannot prove the database role exists.

The API adapter expects `APPLICATION_DATABASE_SECRET_ARN` to refer to the application
secret, `DATABASE_HOST` to the proxy endpoint, `DATABASE_NAME=portal`, and
`DATABASE_PORT=5432`. It rejects a username other than `portal_app`. The application
secret deliberately contains only username and password; explicit connection
environment values prevent accidentally selecting the administrator's direct RDS
endpoint. Proxy connections verify TLS using Node's standard trust store; direct
RDS migration connections require the RDS CA bundle. Normal runtime never migrates.

RDS Proxy requires TLS, disables debug SQL logging, and uses connection percentages
60 maximum / 30 idle with a five-second borrow timeout. The database is an encrypted
20 GiB gp3 `db.t4g.small` PostgreSQL 17 instance, single AZ, without storage autoscaling.

## Removal behavior

All stack resources have explicit `Delete` deletion and replacement policies;
taggable resources carry `Project=appointment-portal`. Database deletion protection
is disabled, automated backup retention is zero, automated backups are deleted,
and deletion takes no final snapshot. This is deliberate for fictional demo data.

CloudFormation deletes Secrets Manager secrets using `ForceDeleteWithoutRecovery`
under its normal Delete behavior, so these secrets do not have a recovery window.
Actual permanent deletion is asynchronous. Teardown must inventory resources and
verify disappearance, recording any pending deletion rather than treating successful
stack destruction as proof. See [CloudFormation deletion policies](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
and the [Secrets Manager deletion API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html).
Shared CDK bootstrap resources remain outside this application stack and must be
preserved unless separately verified as project exclusive.

## Edge, API, and publication contract

`ApiConstruct` consumes the data and identity constructs and exposes `httpApi`,
`functions` (profiles, availability, appointments), and the direct origin `apiUrl`.
Each feature uses Node 24 ARM64, 512 MiB, a 15-second timeout, the isolated subnets,
and the API security group. Default `reserved` mode assigns concurrency five to each
feature and one to the private migration function. Explicit `shared-unreserved` mode
omits all four reservations so the functions share the account's unreserved pool.
Application-secret IAM
access is unchanged between phases. AWS SDK clients are included in the ESM bundles;
Node built-ins and pg's unused lazy `pg-native` alternative are the only externals.
The RDS public CA asset and its provenance live in `infra/assets/`.
CDK retains esbuild's analyzed input/import metadata in each artifact. Its bundling
hook normalizes the sole output key to `index.mjs` before hashing, removing only the
temporary synth-directory prefix. Identical code, CA files, and dependency inputs
produce identical asset hashes across bootstrap and ready synth directories.

All ten approved routes retain the `/api` prefix and explicitly require the Cognito
issuer, app-client audience, and `portal/access` scope. There is no anonymous
default route, CORS wildcard, or separate direct-origin authentication path. The
default stage permits an average two requests/second with a burst of three, reducing
burst pressure before requests contend for Lambda concurrency. The throttle,
authentication, pool limits, routes, and handlers are identical in both modes.
Shared mode does not provide per-feature isolation: another regional function or a
slow route can exhaust the pool and throttle unrelated requests. Deployed throttling
tests send unauthenticated requests to the existing direct-API `GET /api/me` route.
The route inherits the stage throttle, while
its managed JWT authorizer rejects requests before Lambda integration; the test accepts
only 401 and 429. API Gateway documents the token-bucket settings as
best-effort targets in [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)
(checked 2026-09-08) and the pre-integration authorization behavior in
[JWT authorizers for HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
(checked 2026-09-08).
Local development calls `/api` through Vite's local proxy; direct cross-origin use
of the deployed API from localhost is not enabled.

`WebConstruct` exposes `bucket`, `distribution`, and `frontendUrl`. S3 blocks all
public access, requires TLS, has no website endpoint or versioning, and allows
CloudFront reads only through distribution-scoped origin access control. Both
`/api` and `/api/*` use the API origin over TLS 1.2, all HTTP methods, disabled
caching, and `ALL_VIEWER_EXCEPT_HOST_HEADER`. Authorization, cookies, and query
parameters reach API Gateway; the viewer Host is replaced by the origin Host.

Only the frontend default behavior runs the SPA function. It recognizes the
current React page routes and leaves API paths, assets, files, and unknown paths
alone. There is no global error-to-index mapping. The shell and public config
use a cache-disabled behavior; `/assets/*` can cache only as allowed by origin
metadata, with zero minimum/default TTL and a one-year maximum.

The later publisher must apply this S3 metadata, rather than relying on browser
or CloudFront defaults:

| Objects | Cache-Control | Publication rule |
| --- | --- | --- |
| `index.html`, `config.json` | `no-cache, max-age=0, must-revalidate` | Publish after assets; config contains only public ready-phase outputs |
| Vite content-hashed JS/CSS under `assets/` | `public, max-age=31536000, immutable` | Upload new hashes first; never overwrite an existing hash with different bytes |
| Other public files | `no-cache, max-age=0, must-revalidate` | Do not label unhashed files immutable |

Keep prior hashed assets during a publication so open tabs can finish their
current version. Use correct Content-Type metadata. The Vite manifest is build
input for publication, not a required public object. Do not publish bootstrap
configuration or treat a successful synthesis as proof the app role is provisioned.

The response policy sets HSTS, nosniff, DENY framing, no-referrer, and disables
camera/microphone/geolocation. CSP permits scripts, images, fonts, and ordinary
assets only from the same origin. `connect-src` adds only the concrete Cognito
managed-login and regional issuer origins used by the OIDC client. Frames, object
embeds, and base URI changes are denied. The sole inline exception is
`style-src 'self' 'unsafe-inline'`: the existing Radix Dialog dependency
`react-remove-scroll-bar` injects a viewport-specific style element to lock page
scrolling. Scripts still require `'self'`, with no inline/eval or external script
permission. Review the style exception when that UI dependency changes.

## Operations and stable outputs

API feature logs and access logs use named `/appointment-portal/<stack>/api/...`
groups. The proxy has the physical name `appointment-portal-<qualifier>` in both
phases. Its literal `/aws/rds/proxy/appointment-portal-<qualifier>` log group is an
explicit dependency of the proxy: it is created first and deleted after the proxy,
without depending on the proxy's Ref. CDK's S3 emptying provider
also receives an explicit named maintenance log group. Every group retains one
week and is deleted with the stack, including the maintenance group. The provider
is a CDK lifecycle function, separate from the three application features. Its
Lambda, role, and log group all carry `Project=appointment-portal` for inventory.

The access log is one JSON object with gateway `requestId`, normalized `routeKey`,
status, response length, integration latency, and response latency. The existing
Lambda adapter carries `event.requestContext.requestId` into its completion log
and `X-Request-Id` response header. API functions explicitly select Lambda's JSON
logging format. The adapter writes exactly one newline-terminated JSON object to
stdout, bypassing the Node runtime's console wrapper so the gateway request ID and
all five application fields remain at the top level:

```json
{"requestId":"gateway-request-id","operation":"GET /api/me","status":200,"durationMs":12,"errorCode":null}
```

`requestId` is the gateway correlation ID; it is distinct from the Lambda invocation
ID in Lambda's own system records. Do not serialize this completion record through
`console.log`: in JSON mode that places an escaped string inside `message` and uses
the invocation ID in the wrapper. Tokens, query strings, caller claims,
request/response payloads, and raw exceptions or database errors are excluded.

Select the access group and the relevant feature groups in CloudWatch Logs Insights,
then correlate the two streams with the returned gateway request ID:

```text
fields @timestamp, @log, requestId, operation, routeKey, status, durationMs, errorCode, integrationLatency, responseLatency
| filter requestId = "gateway-request-id"
| sort @timestamp asc
```

For completion counts and latency, filter out access and system records:

```text
filter ispresent(operation)
| stats count(*) as requests, pct(durationMs, 95) as p95DurationMs by operation
```

Each feature has Errors and Throttles alarms; the API has a 5xx alarm. Each alarms
on one or more events within one minute and treats missing data as nonbreaching.
There are no notification subscriptions. The dashboard covers API latency and
4xx/5xx, Lambda duration/errors/throttles, database connections, proxy client and
database connections, and average proxy borrow latency in microseconds. RDS Proxy
metrics use the documented `AWS/RDS` namespace and `ProxyName` dimension.

Exact stack output names are `FrontendUrl`, `ApiUrl`, `DistributionId`,
`WebBucketName`, `UserPoolId`, `ClientId`, `Issuer`, `CognitoDomain`, `ProxyName`,
`DatabaseId`, `MigrationFunctionName`, `VpcId`, `AdminSecretArn`,
`ApplicationSecretArn`, `ProfilesFunctionName`, `ExpiresAt`, and
`SafeguardScheduleName`. The migration output references the private
setup Lambda described in [the provisioning runbook](../runbook/provisioning.md).
`FrontendUrl` and `CognitoDomain` are HTTPS origins with no trailing slash;
`ApiUrl` is the direct API Gateway base endpoint, while browser config uses `/api`.

Build the API Lambdas and frontend before `pnpm check:bundles`. The guard reads
each feature's esbuild import metadata, rejects local/test inputs or unbundled SDK
dependencies, imports each actual handler, and scans all frontend artifacts for
local-auth code and identities. CDK tests separately inspect and import the real
deployment assets, including their CA files. Run `pnpm test infra/test` for both
phases and `pnpm --filter @portal/infra synth` with explicit offline context.
The root pins esbuild so CDK can find it at the monorepo bundling boundary. Nested
`pnpm` invocations must resolve the same pinned 11.22.0 version as the outer command.
