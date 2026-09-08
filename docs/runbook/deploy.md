# Deploy the disposable AWS demo

This runbook is for one short verification window. Task 16 supplies and tests the
tooling; do not run it until Task 17 selects the AWS account, repository, controlled
addresses, branch, and cost ceiling.

## Deployed verification

`pnpm demo:verify` reads only the checked private manifest/config/account files and
runs the three opt-in AWS files in order: managed authentication at desktop and mobile
sizes, API/edge controls,
and booking races. The child environment contains only basic runtime variables,
four private credential-file paths, the CloudFront/API/S3 coordinates, the exact
manifest Cognito issuer/client/pool/domain authority, and the AWS
opt-in marker. It does not inherit AWS credentials, GitHub tokens, controlled email
values, passwords, or unrelated `PORTAL_E2E_*` variables.

```sh
pnpm demo:verify
pnpm demo:measure -- "https://DEPLOYED-CLOUDFRONT/" public
PORTAL_LIGHTHOUSE_CREDENTIAL_FILE=.runtime/credentials/PATIENT_FILE pnpm demo:measure -- "https://DEPLOYED-CLOUDFRONT/appointments" authenticated
```

Before the final `pnpm demo:verify`, a person must complete self-registration, email
verification, initial patient-role inspection, sign-in, sign-out, and password
recovery through the controlled inbox. Record that observation without an address:

```sh
pnpm demo:confirm-registration
```

The command requires an interactive TTY, refuses flags and CI/piped input, and asks
for an explicit `yes` for every checklist item. It persists no email, alias, display
name, or local-part. The confirmation
is bound to the account, region, ready commit, FrontendUrl, DistributionId, exact
Cognito issuer/client/pool/domain authority, and a six-hour
expiry. Without it, standalone verification writes an incomplete manual check and
exits unsuccessfully. Provisioned accounts cannot create this record.

Verification writes sanitized status and request IDs to
`.runtime/verification.json`; performance writes three mobile runs to
`.runtime/performance.json`. Both remain ignored private working files until a person
reviews and copies the safe fields into `docs/evidence/`. AWS Playwright permits only
the list reporter and disables traces, video, screenshots, saved storage, HARs,
failure-page snapshots, debug protocol logs, UI mode, and injected reporters before
credential entry. Access and ID tokens live only in worker memory.

The public performance command uses the exact pinned Lighthouse version. Authenticated
appointment-route measurement launches a scrubbed child process and temporary-profile Chromium session, signs in
from one private patient credential file, and uses a Lighthouse timespan around reauthentication
against the authenticated appointment DOM. It rejects the sign-in DOM even when the
URL is still `/appointments`, closes the browser, and removes the temporary profile.
Run three repeats and investigate a public navigation median below 90. Authenticated
timespan evidence records only the metrics that timespan mode supplies and has no
navigation score. Describe both as Lighthouse lab data. The private performance record includes the ready source commit, UTC time,
Lighthouse version, target, mode, mobile profile, and run count; stale or mismatched
records are rejected. Each recorded final URL must equal the requested URL exactly;
same-origin sign-in, callback, error, query, and fragment diversions are rejected.

The access-token-expiry case intentionally waits until the deployed five-minute token
expires. Keep this separate from the controlled throttling check, and do not increase
request volume while diagnosing an unrelated failure. Manual self-registration,
email verification, initial patient role, sign-out/sign-in, and password recovery
remain a person-observed check and must never be inferred from provisioned users.

## Private runtime inputs

Create `.runtime/demo-config.json`, `.runtime/accounts.json`, and
`.runtime/prices.json` with mode `0600`. Git ignores `.runtime/`. Accounts contain
only controlled lowercase addresses, display names, and roles. Generated passwords
remain in `.runtime/credentials/`; never place them in arguments, logs, artifacts,
workflow outputs, or commits.

Use exactly four aliases in `accounts.json`: `patient-a`, `patient-b`,
`clinician-a`, and `clinician-b`. Each alias has a distinct controlled email. The
deployed browser process receives four deterministic private file paths through
`PORTAL_E2E_PATIENT_A_FILE`, `PORTAL_E2E_PATIENT_B_FILE`,
`PORTAL_E2E_CLINICIAN_A_FILE`, and `PORTAL_E2E_CLINICIAN_B_FILE`; passwords do not
enter process arguments or environment variables.

`demo-config.json` contains deployment coordinates and file paths:

```json
{
  "account": "111111111111",
  "region": "eu-north-1",
  "postgresVersion": "17.6",
  "durationHours": 2,
  "maxCostUsd": 5,
  "lambdaConcurrencyMode": "reserved",
  "repository": "OWNER/REPOSITORY",
  "repositoryOwnerId": "18458919",
  "repositoryId": "1360681625",
  "branch": "main",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "createdAt": "2030-06-01T12:00:00.000Z",
  "expiresAt": "2030-06-01T14:00:00.000Z",
  "accountsFile": "/absolute/path/.runtime/accounts.json",
  "priceReport": "/absolute/path/.runtime/prices.json"
}
```

The workflow generates this file immediately before AWS credential configuration.
Fresh preflight and deploy readers require `createdAt` to be within five minutes of
their current clock and require `expiresAt` to be in the future and no later than the
current time plus the configured duration, capped at six hours. Later verification
requires the same configuration to remain unexpired; delivery setup performs structural
validation because it creates the reusable control plane rather than the application.
This accepts normal action and preflight startup while preventing a restored timestamp
from extending a deployment's lifetime.

`prices.json` records `checkedAt`, `region`, `currency: "USD"`, at least two source
URLs, duration assumptions, and these numeric rate fields: `databaseHourly`,
`proxyVcpuHourly`, `databaseVcpus`, `interfaceEndpointAzHourly`, `azCount`, `cognito`, `logging`,
`storage`, and `transfer`. Obtain quotes for the selected account and Region on the
deployment day. Reports older than seven days or more than five minutes in the future
are rejected. The cap is an execution
guard; AWS does not enforce it as a budget.

Pricing behavior was checked on 2026-09-06 against the official
[RDS pricing](https://aws.amazon.com/rds/pricing/),
[RDS Proxy pricing](https://aws.amazon.com/rds/proxy/pricing/),
[PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/),
[Cognito pricing](https://aws.amazon.com/cognito/pricing/),
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/),
[S3 pricing](https://aws.amazon.com/s3/pricing/), and
[CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/). RDS Proxy bills
provisioned databases per vCPU-second with a ten-minute minimum after a billable
status change. This design uses the default proxy endpoint and one Secrets Manager
interface endpoint in each of two AZs.

## Preflight and delivery identity

```text
pnpm demo:preflight
```

This read-only check compares STS identity with the configured account; checks the
PostgreSQL 17 patch and `db.t4g.small`, and confirms that the caller can reach the
RDS Proxy API in the selected Region. Default `reserved` mode requires Lambda
headroom for 16 reserved executions while leaving 100 unreserved. Explicit
`shared-unreserved` mode requires at least 10 unreserved executions and omits all
four application reservations; use it only for a dedicated, low-traffic temporary
demo account. It preserves API routes, authorization, handlers, stage throttling,
and database pool limits, but loses per-feature and migration capacity isolation.
Preflight also reads Node, pnpm, and Docker versions, requires a clean worktree, and
checks the estimate. The reserved-mode quota calculation follows AWS's requirement
to retain 100 unreserved executions;
see [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
(checked 2026-09-06). Region support and price values are always queried or supplied
at execution time; this repository does not claim live availability or a fixed cost.

The application and bootstrap both use qualifier `apptdemo`; the toolkit stack is
`AppointmentPortalToolkit`. A matching name alone is not ownership. The tooling
requires `Project=appointment-portal` before reuse. After locally creating the
project-specific toolkit, run `pnpm demo:setup-delivery`. It inspects any existing
GitHub provider and imports it only when its URL and `sts.amazonaws.com` audience
match. Imported providers are shared. Before creating or updating AWS resources,
setup also runs `gh api` against the selected repository and its Actions OIDC
customization endpoint. Authenticate GitHub CLI as a repository administrator with
API access to both endpoints; unavailable, malformed, or mismatched responses stop
setup before manifest or AWS mutation.

DeliveryStack trusts only `repo:OWNER@OWNER_ID/REPOSITORY@REPOSITORY_ID:environment:demo`
with audience `sts.amazonaws.com`. The workflow copies GitHub's immutable
`repository_owner_id` and `repository_id` contexts into the private configuration;
setup validates them as nonzero decimal IDs. In GitHub, create environment `demo`, restrict its deployment
branch to the configured branch, and populate the variables/secrets used by
`demo.yml`, including `AWS_DELIVERY_ROLE_ARN`. A delivery-only bootstrap manifest
from the earlier name-only trust format may adopt these IDs and the current commit;
an application manifest cannot be rebound to a different commit or repository identity.
Fresh setup and legacy delivery-only adoption require `AppointmentPortal` to be
absent in CloudFormation; any live application stack state blocks identity binding.
Set environment variable
`LAMBDA_CONCURRENCY_MODE` to `shared-unreserved` only for the constrained disposable
account; when absent, the workflow and private configuration default to `reserved`.
The workflow also rejects a different
`github.ref_name` before requesting AWS credentials. See [GitHub environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)
and [OIDC subject claims](https://docs.github.com/en/actions/reference/security/oidc)
(checked 2026-09-06).

Workflow action versions were checked 2026-09-06 against their official release
pages and are pinned by full commit SHA: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0),
[pnpm/action-setup v6.1.0](https://github.com/pnpm/action-setup/releases/tag/v6.1.0),
[configure-aws-credentials v6.2.3](https://github.com/aws-actions/configure-aws-credentials/releases/tag/v6.2.3),
and [upload-artifact v7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1).

The delivery role assumes only project qualifier bootstrap roles and has bounded
publication, migration, provisioning, and inventory access. The bootstrap
CloudFormation execution role is the separate, broader provisioning authority.
Application Lambda roles keep feature-specific permissions.

Deployed verification correlates allowlisted API response request IDs with completion
records from `/appointment-portal/AppointmentPortal/api/{profiles,availability,appointments}`.
The delivery role therefore needs only `logs:FilterLogEvents` on those application API
log-group ARNs. It does not need log-body persistence, `cloudwatch:GetMetricData`, or
access to unrelated log groups. The persisted summary contains only request count,
cold/warm counts, maximum observed duration, and fixed text; warm/cold values are
diagnostic observations, not an SLA.

## Two-pass deployment

Run the manual **Disposable AWS demo** workflow. It runs local gates, obtains OIDC
credentials, runs preflight, deploys bootstrap mode, saves the manifest, migrates and
provisions fictional users, waits for proxy health, deploys ready mode with the
literal CloudFront origin and `portal_app` proxy auth, verifies migration again,
saves ready state, publishes, invalidates, and runs deployed tests.
Before frontend publication, the runner directly invokes the fixed
`AppointmentPortal-profiles` Lambda with a synthetic gateway event for the provisioned
patient fixture. A 200 invocation, absent `FunctionError`, safe HTTP 200 payload, and
patient profile prove that an application function can query through RDS Proxy using
the `portal_app` secret. Migration success does not satisfy this gate.
Each application deployment passes
`AppointmentPortal:DeploymentPhase=bootstrap|ready` explicitly through CDK's
`--parameters` option. The live parameter therefore records the deployed phase even
when CloudFormation would otherwise reuse a previous parameter value. After CDK
returns successfully, the runner reinspects that live parameter and rejects a missing
or mismatched phase before saving ready state, publishing, or starting browser tests.

A saved ready deployment migrates in place and never restores administrator proxy
auth. Function errors, unhealthy targets, callback mismatch, unsafe publication, or
test failure stop the run. Hashed assets upload first with immutable metadata;
validated public config and shell use `no-cache`; old hashes remain through
verification.

The live application stack carries project and source commit tags plus a deployment
phase parameter. A missing local manifest is restored from a matching live stack before any
function is invoked. A saved ready manifest whose stack is absent, or a live stack
from another commit, stops before migration. A saved bootstrap manifest whose live
application stack is absent is treated as stale and is redeployed before any recorded
function or user pool is invoked. After a deployment mutation the runner
writes a minimal private recovery manifest before parsing CDK outputs, then enriches
it atomically after inventory succeeds. Failed runs capture sanitized CloudFormation
events in `.runtime/diagnostics.json`; arbitrary CloudFormation status reasons are
omitted, and identifiers and statuses must match fixed allowlists. The workflow scans
that file for credential material before uploading it with the recovery inventory.

`pnpm demo:verify` rereads the matching private demo configuration and maps exactly
`PATIENT_A`, `PATIENT_B`, `CLINICIAN_A`, and `CLINICIAN_B` to deterministic `0600`
credential file paths. Playwright receives those paths, never generated passwords, in
its environment. The child environment is rebuilt from a small runtime allowlist, so
AWS credentials, OIDC request values, controlled email inputs, GitHub tokens, and
inherited `PORTAL_E2E_*` values cannot cross into Playwright. Runtime configuration, account, output, manifest, inventory, and
credential reads and writes reject symlinked path components before access.

Delivery setup writes an ownership-neutral toolkit recovery target before invoking
bootstrap, checkpoints it again immediately after bootstrap returns, then records
ownership only after live inspection confirms the project tag. It does the same around
the delivery-stack deployment before parsing outputs or collecting detailed resource
inventory, so an interrupted first setup remains discoverable by the local `--all`
cleanup path.

Failure diagnostics are uploaded separately only when the allowlist-based artifact
scan succeeds. A rejected diagnostics file is never included in the always-uploaded
deployment-manifest artifact.

The workflow uses concurrency group `appointment-portal-demo` with cancellation
disabled. A lost runner cannot guarantee an `always()` cleanup step. Restore the
manifest and follow [destroy.md](destroy.md) locally. CDK qualifier behavior was
checked 2026-09-06 in [AWS CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)
and the [bootstrap CLI reference](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html).

The application stack creates a one-time EventBridge Scheduler safeguard before its
primary billable resources through explicit CloudFormation dependencies, including
the two-subnet Secrets Manager interface endpoint, database, proxy, and distribution. The schedule
uses an absolute UTC `ExpiresAt` computed from the configured
duration, capped at six hours, and persisted in the private configuration, manifest,
and stack outputs. The schedule targets CloudFormation `DeleteStack` for
`AppointmentPortal` through a role limited to that stack, uses a zero-width flexible
window, and deletes itself after invocation. Manual stack cleanup removes the schedule.
This safeguard removes primary application resources after runner loss; it does not
remove retained residuals, the delivery stack, CDK toolkit, or shared resources.
