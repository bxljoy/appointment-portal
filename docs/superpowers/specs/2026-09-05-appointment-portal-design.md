# Patient and clinician appointment portal

Date: 2026-09-05
Status: Approved by the user on 2026-09-05; implementation planning authorized.

## 1. Purpose and outcome

Build a portfolio project to understand React, Node.js, CloudFront, API Gateway,
Lambda, Cognito, PostgreSQL, RDS Proxy, and infrastructure deployment with AWS CDK.
The reference job description motivates these choices; this design does not claim
to describe the employer's actual architecture.

The finished project must be reproducible from GitHub: develop locally, deploy a
disposable AWS environment, verify real user journeys, capture sanitized evidence,
and destroy project resources. Continuous hosting is not a requirement. Use fictional
patient and clinician information, with controlled email addresses for authentication.

## 2. Scope and user journeys

Patients register, verify their email, sign in, browse clinicians and their available
slots, book a slot, view their own appointments, and cancel future appointments.
Clinicians sign in using provisioned accounts, publish individual available slots,
view their appointments, cancel future appointments, and withdraw open slots.

Appointments are 30 minutes. Slots may start on any minute but cannot overlap for
one clinician. Adjacent slots are allowed. Only future open slots can be booked.
Cancellation keeps the historical booking and reopens the slot unless the clinician
withdraws it. A clinician may cancel and withdraw the slot in one atomic operation.
Withdrawn slots cannot be reopened in version one; publish a new slot instead.
An occupied slot cannot be withdrawn without cancelling its active appointment.

Appointment timestamps represent UTC instants. The interface displays the viewer's
timezone explicitly. Clinicians enter slot times in their configured IANA timezone;
reject ambiguous or nonexistent daylight-saving local times with a clear message.
Server time determines whether booking or cancellation is still allowed.

Payments, video calls, notifications, medical records, recurring availability,
rescheduling, account administration screens, and production healthcare operation
are outside scope. Rescheduling can be done by cancelling and making a new booking.

## 3. Agreed technology choices

| Area | Choice |
| --- | --- |
| Frontend | React, TypeScript, Vite, React Router |
| Server data | TanStack Query |
| Forms and contracts | React Hook Form, Zod |
| Styling and components | Tailwind CSS, shadcn/ui |
| Browser authentication | react-oidc-context, oidc-client-ts; Cognito managed login |
| API requests | Native fetch through a shared wrapper |
| Backend | TypeScript on Node.js Lambda; one function per feature area |
| Public API | API Gateway HTTP API with JWT authorization |
| Data | RDS PostgreSQL through RDS Proxy |
| Hosting | CloudFront with a private S3 frontend origin |
| Infrastructure | AWS CDK in TypeScript |
| Tests | Vitest, React Testing Library, real PostgreSQL integration tests, Playwright |
| Automation and operations | GitHub Actions, AWS OIDC federation, CloudWatch |

Implementation defaults proposed in this written spec: pnpm workspaces; parameterized
SQL using node-postgres (`pg`); versioned SQL migrations with an execution ledger and
database lock; no ORM and no additional backend web framework initially. Pin compatible
stable dependencies in a lockfile. Confirm a supported Node.js Lambda runtime and
PostgreSQL version compatible with RDS Proxy before implementation deployment.

## 4. Architecture and boundaries

The browser obtains frontend assets from CloudFront and signs in directly with
Cognito. Requests to `/api/*` pass through CloudFront to API Gateway. API Gateway
validates access tokens and invokes the feature Lambda. The Lambda validates input,
checks application permissions, and runs SQL through RDS Proxy to PostgreSQL.

CloudFront is a delivery and forwarding layer, not the authentication authority.
Use origin access control for the S3 REST origin and block public S3 access. Disable
API caching, forward Authorization and required query parameters, and allow the API's
HTTP methods. Keep the `/api` prefix consistent between CloudFront and API Gateway.
Use an origin request policy that forwards Authorization while replacing the viewer
Host with the API Gateway origin host, such as AllViewerExceptHostHeader.
Direct API Gateway access must enforce the same authentication and authorization.

Use a CloudFront Function only on the frontend behavior to rewrite extensionless
frontend page requests to `/index.html`. API errors and missing assets must retain
their actual statuses. Hashed assets receive long immutable cache lifetimes;
the HTML shell and runtime configuration revalidate instead of remaining stale.
Use the generated CloudFront HTTPS domain for the demo; no domain purchase is needed.

Three feature Lambdas form one modular application sharing a database:

| Module | Responsibility | Dependencies |
| --- | --- | --- |
| Profiles | Current application user, clinician directory and public biographies | Validated caller identity, users and clinician profiles |
| Availability | Publish, list, and withdraw clinician slots | Caller permissions, users, slots, appointment status |
| Appointments | Book, list, and cancel appointments | Caller permissions, users, slots, appointments |

Handlers adapt Lambda events to typed operations and map results to HTTP responses.
Services enforce business rules. Repositories encapsulate parameterized SQL. Share
database and permission helpers without invoking one feature Lambda from another.
Avoid both per-endpoint infrastructure and a distributed microservices design.

## 5. Repository layout

```text
apps/
  web/src/
    app/                         # Routes, layouts, providers
    features/{auth,clinicians,availability,appointments}/
    components/ui/               # Shared visual components
    lib/                         # API client and authentication configuration
  api/src/
    modules/{profiles,availability,appointments}/
      handler.ts
      service.ts
      repository.ts
    shared/                      # Database, permissions, errors, logging
    local/                       # Local HTTP adapter, excluded from Lambda bundles
packages/
  contracts/                     # Public Zod schemas and inferred API types
  database/                      # SQL migrations, migration runner, fictional seed data
infra/                           # CDK app, stacks, constructs
tests/e2e/                       # Browser journeys and deployed API checks
docs/                            # Design, runbook, architecture, sanitized evidence
```

Only public API shapes cross into the frontend. Database rows, credentials, and
backend internals are not exported from the contracts package. Extract reusable
modules when needed; the tree is a responsibility map rather than a requirement to
create empty placeholder files.

## 6. Authentication and authorization

Use one Cognito user pool, a public app client without a client secret, and managed
login with authorization code flow and PKCE. Allow explicit local and deployed
callback/logout URLs. Require verified email for self-registration. An identity pool
is unnecessary because the browser calls our application API rather than AWS services.

Request an application scope such as `portal/access`. Every protected API route
requires that scope and a JWT authorizer configured with the user-pool issuer and
app-client audience. Lambda reads identity from validated authorizer claims. Use the
access token for API calls; ID tokens are for identity information in the client.

On the first authenticated request, idempotently create a missing application user
using the validated `sub`, always with the patient role. Never accept a role or user
identity from request fields as authority. Application roles live in PostgreSQL.
Provision clinician accounts and their clinician-role rows through privileged setup,
before their first app login. Fetch the application role through `/api/me`.

Use the OIDC library for state, nonce, PKCE, callbacks, and renewal. Default to
in-memory user tokens, session-scoped storage for temporary redirect state, and
re-authentication after a full page reload when necessary; Cognito may reuse its login
session. Do not persist tokens in localStorage. Sign-out clears the app's token state
and TanStack Query cache and uses Cognito's logout endpoint. Scope private query keys
to the authenticated user; switching identities must never reveal cached prior data.

API Gateway validates tokens; Lambda enforces ownership and roles. Patients can only
see or cancel their own bookings. Clinicians can only manage their own slots and
appointments. Clinician appointment responses expose only the patient fields needed
for the demo, not authentication details. Frontend route guards improve navigation
but are not permission enforcement. Invalid sessions return 401; wrong-role operations
return 403; inaccessible object IDs return 404 to avoid revealing their existence.

## 7. Data model and booking consistency

| Table | Main fields and constraints |
| --- | --- |
| users | UUID id, unique Cognito sub, display name, role restricted to patient/clinician, created_at |
| clinician_profiles | User id FK/PK, biography, specialty, IANA timezone |
| availability_slots | UUID id, clinician profile FK, timestamptz start/end, open/withdrawn status, created_at |
| appointments | UUID id, slot FK, patient user FK, booked/cancelled status, created_at, cancelled_at, cancelled_by user FK |

Use foreign keys, database checks for valid statuses and 30-minute duration, and a
partial unique index on appointments(slot_id) where status is booked. Enforce clinician
slot non-overlap at the database layer using a GiST exclusion constraint on clinician
identity and the half-open time range `[start, end)` for non-withdrawn slots, with the
`btree_gist` extension. Role checks remain explicit in services.

Booking locks the target slot row, verifies open/future state, and inserts the booking
in one transaction. Cancellation and withdrawal take that same slot lock first, then
check ownership, update the booking, and optionally withdraw the slot. A cancelled
booking is immutable history; a replacement booking gets a new row. A slot is available
when open, in the future, and without a booked appointment; do not store a second
independent occupied flag. Use consistent lock ordering and bounded transaction times.

Map booking uniqueness and overlap violations to meaningful 409 responses. For
simultaneous bookings, exactly one succeeds and exactly one active row persists.
Repeated cancellation of an already cancelled appointment by an authorized actor
returns the existing cancelled representation without additional side effects.
Do not automatically retry booking mutations in the client. On an ambiguous network
failure, refetch the user's appointments before offering another attempt.

Use TLS with certificate validation for database connections and small reusable
connection pools per Lambda environment. Explicitly bound Lambda concurrency and pool
sizes against database capacity. RDS Proxy helps manage connections; it does not remove
database limits or provide booking consistency. Release connections in finally blocks.

## 8. HTTP interface and frontend behavior

All application routes are authenticated. Availability queries default to seven days
and allow a maximum 31-day window. List endpoints use cursor pagination, defaulting to
20 records with a maximum of 100. Times in JSON are ISO 8601 with UTC offsets.

| Route | Operation |
| --- | --- |
| GET /api/me | Ensure and return the caller's application profile and role |
| GET /api/clinicians | List clinician profiles |
| GET /api/clinicians/{id} | Get one clinician's public profile |
| GET /api/clinicians/{id}/slots | List future available slots in a date window |
| GET /api/availability | Clinician's own slots, including booked/withdrawn state |
| POST /api/availability | Clinician creates one slot |
| POST /api/availability/{id}/withdraw | Clinician withdraws an unoccupied slot |
| GET /api/appointments | Caller's bookings; patient-owned or clinician-assigned |
| POST /api/appointments | Patient books a slot; server supplies patient identity |
| POST /api/appointments/{id}/cancel | Owner cancels; clinician may also request slot withdrawal |

Validate query, path, and body data with Zod. Creation returns 201. Mutation responses
return the resulting representation; cancellation returns 200. Use consistent errors:
`{ error: { code, message, requestId, fieldErrors? } }`. Validation is 400, missing or
inaccessible resources 404, conflicts 409, and unexpected failures 500 with no SQL or
stack trace exposed. Render 429 as a retry-later state.

Frontend routes include clinician browsing, clinician detail and booking, patient
appointments, clinician availability and appointments, and authentication callbacks.
React Router owns navigation. TanStack Query owns server data; React state owns local
UI state; query parameters own date and clinician filters; React Hook Form owns forms.
No Zustand initially. Fetch wrappers attach tokens and normalize errors.

Booking displays pending state and disables duplicate submissions. Confirm success
only after the server response; invalidate availability and appointment queries.
Conflicts show a clear explanation and refresh choices. Display loading, empty, error,
and retry states. Build semantic forms, keyboard-operable dialogs, visible focus,
accessible error messages, and responsive layouts. Target WCAG 2.2 AA for these flows;
automated checks alone are not proof of conformance.

## 9. Infrastructure and local development

Use one disposable environment. Default region is eu-north-1, reflecting the user's
location; deployment preflight verifies account, supported engine/runtime combinations,
quotas, and estimated resource costs. Use a small encrypted single-AZ RDS instance for
this short-lived demo, not a high-availability claim. The VPC has isolated subnets in
two Availability Zones to support database subnet groups and RDS Proxy placement.

API Lambdas and the migration Lambda run in the VPC. Security groups allow API Lambda
to proxy, proxy to database, and migration Lambda directly to database. There is no
public database endpoint. A Secrets Manager interface endpoint with private DNS allows
credential retrieval without a NAT gateway. Browser authentication and provisioning
from the deployment runner reach Cognito outside this VPC; API Lambdas do not need to
call Cognito. Additional runtime outbound dependencies require revisiting connectivity.

Use separate database migration/admin credentials and a least-privilege application
database role. Store credentials in Secrets Manager, attach the application secret to
RDS Proxy, and grant narrowly scoped secret access to the relevant execution roles.
The migration function has schema privileges; application functions have required DML
privileges only. Normal runtime never runs migrations or has schema-owner privileges.

Group CDK infrastructure into an application stack with focused networking/data,
identity, API, and web constructs. Generate frontend configuration from stack outputs
after deployment so callbacks and resource IDs agree. Configuration contains public
identifiers only. Explicitly create log groups with bounded retention and demo removal
policies. Configure API access logs and structured Lambda logs with request IDs,
operation, duration, and error category; redact tokens, passwords, and personal payloads.
Record API/Lambda errors, throttling, duration, and database/proxy connection metrics.

Locally use Docker PostgreSQL with the same major version, migrations, constraints,
and seed model as AWS. Vite proxies `/api` to a small Node HTTP adapter calling the
same service code. Local test identities are enabled only in that local adapter and
cannot be included in deployed bundles. AWS tests use real Cognito authentication.

## 10. Deployment and verification workflow

Pull requests run lint, type checks, unit/component tests, PostgreSQL integration tests,
frontend/backend builds, and CDK synthesis with focused infrastructure assertions.
Use a pnpm lockfile and supported runtime versions for reproducible builds.

A manually triggered GitHub Actions workflow assumes a repository- and environment-
restricted AWS role through OIDC. It deploys infrastructure, invokes the private
migration function, creates controlled Cognito identities, seeds profiles and slots,
builds/publishes the frontend using stack outputs, and verifies the deployed system.
Serialize deployments for this environment and migrations with a database lock.
SQL migrations are recorded and fail clearly; never run them on ordinary API requests.

Pre-created confirmed test users support repeatable automated managed-login tests.
Separately verify one real patient self-registration/email confirmation journey using
a controlled inbox; record that as a manual check instead of claiming automation of
email delivery. Do not commit passwords, test session storage, or token-bearing traces.

Acceptance evidence must cover:

1. Registration/email verification, real managed login, token expiry handling, logout,
   protected routes, and cache isolation when switching users.
2. Clinician publishing and withdrawing slots; rejected overlapping slots.
3. Patient browse, book, list, cancel, and rebook; clinician cancel-and-withdraw.
4. Cross-patient and cross-clinician access denial, forged identity/role rejection,
   missing/expired/incorrect-scope token rejection.
5. Two patients submitting concurrent deployed booking requests: one 201, one 409,
   and exactly one persisted active booking. Verify through authorized API reads.
6. Competing cancellation/withdrawal/booking operations and daylight-saving boundaries
   in PostgreSQL integration tests.
7. Nested frontend URL refresh, authentic API error statuses, no API response caching,
   public S3 access denial, and consistent authorization through the direct API origin.
8. Mobile and desktop journeys, keyboard-only operation, focus management and automated
   accessibility checks; no serious or critical automated accessibility violations.
9. Lighthouse production-build measurements for key screens, recording tool version,
   device profile, and results. Aim for performance >=90 and investigate misses rather
   than claiming field Core Web Vitals from a short-lived demo. Compare repeat runs
   under the same conditions; use suitable authenticated-page instrumentation.
10. CloudWatch request correlation and useful errors without credential leakage.

Unit tests cover meaningful service decisions; integration tests exercise real SQL;
Playwright covers behavior across browser, authentication, API, and database. No arbitrary
coverage percentage substitutes for this acceptance matrix. Capture sanitized screenshots,
test summaries, measurements, and a deployment commit identifier in docs/evidence.
Treat raw browser reports/traces as potentially sensitive; sanitize or omit them.

## 11. Teardown and GitHub deliverables

After evidence is captured, destroy application resources and verify their deletion.
Provide an explicit cleanup workflow and runbook usable after partial deployment or
test failure. A failed test does not justify leaving the environment indefinitely;
capture diagnostics, then clean up. Do not let automatic teardown race a live test run.

Demo removal policies must empty frontend buckets, remove logs and Cognito users/pool,
delete RDS Proxy and database, avoid final snapshots and retained automated backups,
and handle Secrets Manager deletion/recovery behavior explicitly. Verify active or
pending resources, manual snapshots, buckets, VPC endpoints, and networking remnants
using stack inventory and project tags; do not equate a successful destroy command
with proof that no billable resources remain. Record any scheduled deletion clearly.

Inventory CDK bootstrap assets/resources and GitHub deployment roles separately.
Remove project-exclusive setup after teardown, using local AWS access for the final
cleanup when the workflow can no longer assume its role. Preserve shared account-level
resources and report them explicitly. Cost reporting can lag, so use resource inventory
as immediate evidence and record billing information only when available.

The GitHub repository retains source, migrations, infrastructure, workflows, a README
with deploy/verify/destroy instructions, architecture explanations, trade-offs, and
sanitized evidence. It does not retain credentials, database exports, runtime artifacts,
or an assertion that a destroyed demo URL is still live. Repository publication and AWS
execution happen later; this document makes neither claim.

## 12. Alternatives and design rationale

- A Vite SPA fits static S3 hosting and the separate Lambda backend. Server rendering
  is unnecessary for the agreed authenticated workflows.
- One Lambda per feature area balances comprehensible deployment boundaries against
  the configuration overhead of one Lambda per endpoint.
- API Gateway HTTP API provides the JWT and Lambda features needed for a RESTful API.
- Direct RDS access is simpler, but RDS Proxy teaches connection management. Aurora
  Data API was considered; PostgreSQL driver access better matches this learning goal.
- Cognito managed login teaches standard authentication without implementing password
  handling. Database roles keep application authorization explicit.
- Parameterized SQL and transactions keep booking invariants visible. The proposed
  defaults do not add an ORM or additional client state library without a concrete need.
- Single-AZ data storage, fictional records, and destructive removal policies are
  deliberate demo choices, not production availability or retention recommendations.

## 13. Review and deployment inputs

The user approved this consolidated specification on 2026-09-05, including the
architecture, frontend stack, account model, booking rules, module structure, and
deploy/verify/destroy lifecycle. The SQL access, browser token storage, networking,
and single-AZ defaults in this spec are the baseline for implementation planning.

Execution inputs are the AWS account/profile, GitHub repository destination/visibility,
controlled email addresses, and a pre-deployment cost ceiling. These are supplied or
verified before the actions that need them; they do not change the current design.
No application implementation or cloud resources exist at the time this spec is written.

## References

- [React application setup](https://react.dev/learn/build-a-react-app-from-scratch)
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [react-oidc-context](https://github.com/authts/react-oidc-context)
- [React Hook Form validation integration](https://github.com/react-hook-form/resolvers)
- [shadcn/ui](https://ui.shadcn.com/docs)
- [Cognito authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-how-to-authenticate.html)
- [Cognito app clients and PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html)
- [API Gateway JWT authorization](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [HTTP API and REST API comparison](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
- [CloudFront origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistS3AndCustomOrigins.html)
- [Lambda with RDS](https://docs.aws.amazon.com/lambda/latest/dg/services-rds.html)
- [Secrets Manager connectivity](https://aws.amazon.com/blogs/security/how-to-centrally-manage-secrets-with-aws-secrets-manager/)
- [GitHub Actions OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [RDS deletion](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_DeleteInstance.html)
- [PostgreSQL range constraints](https://www.postgresql.org/docs/current/rangetypes.html)
- [CloudFront origin headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html)
- [CDK bootstrap resources](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
