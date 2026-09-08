# Final branch deployment-safety fix report

Date: 2026-09-08

Base: `0105fed`

Scope: local implementation and offline verification only

Fresh-review base: `ca3366c`

## Outcome

The disposable AWS demo now gates publication on an invocation of the deployed
`AppointmentPortal-profiles` application Lambda. The probe sends a controlled
synthetic HTTP API JWT-authorizer event for the provisioned patient fixture and
requires a successful benign `GET /api/me` response. This proves that application
code can query PostgreSQL as `portal_app` through RDS Proxy with the application
secret. The delivery role can invoke only this fixed function, and the probe never
accepts migration success as application-credential proof.

HTTP API stage rate is two requests/second with a burst of three, leaving capacity
below each application function's reserved concurrency of five. The deployed AWS
browser suite retains a normal authenticated Lambda request and generates its explicit
HTTP 429 assertion on an unknown gateway-only route. It also covers cross-clinician
slot and appointment access, patient attempts to manage availability, clinician
attempts to book, and forged role/body identities. It verifies concealed 403/404
responses and unchanged owner state while retaining only allowlisted request IDs.

Cleanup no longer turns restored `owned:true` manifest data into deletion authority.
Direct deletion requires a current live `Project=appointment-portal` tag or fresh
membership in the exact currently owned CloudFormation stack for the matching
resource type and ID/ARN. S3 versions are enumerated only after live tag verification.
The shared GitHub OIDC provider is never deleted. Adversarial tests cover unrelated
prefix-matching buckets, log groups, secrets, repositories, and providers; unverified
items are reported instead of deleted, including recovery from `DELETE_FAILED` stacks
through fresh membership.

The destroy workflow now validates GitHub run and artifact metadata before AWS
credential configuration or artifact download. The injected helper binds the exact
repository, demo workflow path, configured branch, run-derived head SHA, completed
successful conclusion, artifact name, run association, expiry, and SHA-256 digest,
then binds manifest account, region, repository, branch, and commit to that provenance.
Workflow permissions remain `contents: read`, `actions: read`, and the existing OIDC
permission used only after provenance validation.

The delivery control plane supplies an EventBridge Scheduler role constrained to the
exact project schedule ARN and `AppointmentPortal` stack. The application stack creates
a one-time `at(...)` schedule with a zero-width flexible window and
`ActionAfterCompletion: DELETE`; the Secrets Manager interface endpoint, database,
proxy, and CloudFront resources depend on the schedule. Absolute `createdAt` and
`expiresAt` values are private configuration fields; `expiresAt` is also persisted in
the manifest, evidence, and stack outputs. They must describe a positive duration no
longer than the requested lifetime or six hours. The schedule targets only
CloudFormation `DeleteStack` for the application stack.

The manual demo gate includes `pnpm audit --audit-level high`, and the workflow/package
whitespace issue is corrected. Fixture markers remain PII-free.

## Fresh-review corrections

The destroy workflow now checks out only immutable `github.sha` from an exact
`refs/heads/${DEMO_BRANCH}` dispatch. The selected demo run ID is data and operator
approval authority; the run-derived commit is never checked out or executed. Trusted
validator code downloads the exact artifact ID through `gh api` into a private raw ZIP,
hashes the downloaded bytes, compares that value with authenticated artifact metadata,
rejects unsafe paths, symlinks, duplicates, encryption, invalid directory records,
unsupported compression, CRC/size mismatches, and extracts only root
`deployment.json`. The manifest is schema- and provenance-validated before it replaces
the private deployment file or AWS credentials are requested.

The Scheduler resource is also an explicit dependency of the two-AZ Secrets Manager
interface endpoint. Fresh deployment readers require `createdAt` within five minutes
of the execution clock and require the absolute expiry to be in the future and no
later than the current time plus the configured duration, with the six-hour cap.
Setup can structurally reuse its control-plane configuration, and verification can
reuse the same still-unexpired configuration later in the window without resetting
the expiry.

The stage throttle is two requests/second with a burst of three. Live verification
makes one normal authenticated application request, then drives the stage throttle
through an unmatched direct-API route that cannot select a Lambda integration; only
gateway 404 and 429 statuses are accepted. Completion output describes automated
verification as passed and explicitly says the manual Cognito journey may be pending.

## Behavioral TDD evidence

The first focused behavioral run against the base produced 19 assertion failures
across seven test files. The expiry implementation was also introduced behind an
assertion-level RED in which expected absolute timestamps differed from an initially
empty result. Focused GREEN results before the final aggregate run included:

- lifecycle, cleanup, and destroy provenance: 74/74
- API throttling and delivery IAM/scheduler: 20/20
- expiry/scheduler dependency checks: all focused cases passed
- verification-summary regression: 10/10

The tests cover publication failure when the application probe fails, exact Lambda
invoke permission, schedule creation/dependencies, expiry bounds, provenance failures,
forged-manifest cleanup attempts, and deployed authorization scenarios.

The fresh-review RED pass added assertion-level failures for the untrusted candidate
checkout/input, absent exact artifact-ID ZIP streaming and extraction, missing
interface-endpoint schedule dependency, stale/future `createdAt`, overlong absolute
expiry, old 5/5 throttle, and inaccurate completion wording. Focused GREEN results are
21/21 for trusted workflow/provenance, 64/64 across the affected server files, and
10/10 for the complete infrastructure API file. The 21/21 workflow/provenance set was
rerun after the final all-entry ZIP symlink rejection.

## Verification

- Full serialized Vitest aggregate: 61/61 files and 664/664 tests passed in
  187.26 seconds. The preceding run's sole failure was an old exact-object expectation
  that omitted the intentionally persisted `expiresAt`; its focused correction passed
  10/10 before the clean aggregate rerun.
- Local Playwright desktop/mobile E2E: 16/16 passed.
- ESLint: passed.
- TypeScript workspace and scripts checks: passed.
- Workspace build: passed.
- Offline two-phase CDK synth and policy checks: passed. The only synth warnings were
  the existing fictional-availability-zone W3010 warnings.
- Lambda bundle import/contents checks: passed.
- Artifact privacy checks: passed.
- `pnpm audit --audit-level high`: passed with no known vulnerabilities.
- `git diff --check`: passed before the report was written and is rerun at handoff.

The first sandboxed aggregate attempt encountered loopback `EPERM` failures in local
server tests. The same local-only suite was rerun with loopback permission; this was an
execution-environment limitation rather than a product failure.

## Residual limits

The AWS-side schedule deletes the primary `AppointmentPortal` application stack after
runner loss. It does not delete retained residual resources, the delivery stack, the
CDK toolkit, or the shared OIDC provider; those remain covered by the separately
verified cleanup path. `ActionAfterCompletion` is applied as a raw CloudFormation
override because the repository's pinned CDK L1 schema does not yet expose the
officially supported property; offline synth tests verify the emitted template.

No AWS or GitHub API was called, no cloud resource was created, no runtime credential
file was inspected manually, and no branch was pushed as part of this fix. The deployed
authorization suite and lifecycle gates will receive their live proof only when the
manual demo workflow is deliberately run later.
