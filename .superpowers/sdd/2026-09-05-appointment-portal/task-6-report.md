# Task 6 report: Lambda HTTP adapters, error mapping and structured logs

## Status

DONE

Commit: `0ca5426 feat: expose validated Lambda HTTP endpoints`

## What I implemented

- Added the shared `HttpRequest`/`HttpResponse` transport boundary, safe JSON response
  envelopes, required no-store/correlation headers, Zod issue-to-field error mapping,
  strict no-body/no-query validation, and 404 versus 405 routing responses.
- Added the ten approved profile, availability, and appointment routes. Query coercion,
  UUID paths, and strict mutation bodies are validated before service calls; creation
  returns 201 and other successful operations return 200. Caller identity and roles
  are never accepted from request data.
- Added an HTTP API v2 Lambda adapter that reads only JWT `sub`, rejects missing identity,
  rejects non-JSON or malformed bodies, and enforces the 16 KiB decoded/UTF-8 body limit
  before parsing. Duplicate query keys are rejected before service initialization.
- Added one allowlisted completion log per request with exactly request ID, normalized
  operation, status, duration, and safe error code. Dynamic record IDs, headers, bodies,
  queries, raw exceptions, tokens, passwords, and connection details are not logged.
- Added a cached, recoverable application-pool provider and module-specific cached
  service initialization. It fetches exactly the configured application secret with
  AWS SDK v3, enforces the fixed `portal_app` username, supports credentials-only proxy
  secrets, limits each pool to two clients, uses 5-second connection/statement/idle-
  transaction timeouts, and releases the initialization client. Failed initialization
  closes and discards its pool and clears both cache layers for later recovery.
- Configured certificate verification with Node's standard trusted ACM chain for RDS
  Proxy and a required explicit RDS CA bundle for direct RDS connections. This follows
  AWS's current RDS TLS guidance and node-postgres's documented `ssl`/timeout/pool APIs:
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html,
  https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html,
  https://node-postgres.com/apis/client, and https://node-postgres.com/apis/pool.
- Added pinned AWS Secrets Manager, Zod, and esbuild dependencies plus independent
  profiles/availability/appointments Node 24 ESM bundle scripts, analyzed metafiles,
  and the aggregate Lambda build. AWS SDK v3 is included in every bundle.

## TDD evidence

### Initial RED

Tests were written first, then deliberately incomplete 501/not-implemented exports
made every test importable and runnable before behavior was added.

Command:

```text
PATH=/Users/bxl/.nvm/versions/node/v24.0.1/bin:$PATH corepack pnpm@11.22.0 --config.verify-deps-before-run=false test apps/api/test/http.test.ts apps/api/test/logging.test.ts -- --reporter=verbose
```

Relevant result:

```text
Test Files  2 failed (2)
Tests       21 failed (21)
```

Representative behavioral failures were expected 200/201/400/401/404/405/413/500
responses receiving the deliberate 501, profile/availability/appointment payloads
receiving not-implemented bodies, unsafe fields appearing in a completion log, and
pool requests rejecting with `Application pool initialization is not implemented`.
This established that the suite detected absent dispatch, validation, transport,
redaction, and initialization behavior rather than failing only at module collection.

### Additional RED/GREEN cycles

- Duplicate query keys initially produced 400 only after `loadService` had run; the
  focused regression failed on one unexpected loader call, then passed after moving
  query parsing ahead of initialization.
- An `admin` database username initially reached the pool factory; the regression
  expected a safe invalid-application-secret rejection and no pool creation, then
  passed after enforcing `portal_app`.
- A credentials-only application secret initially failed validation; the regression
  passed after proxy host/port/database configuration was allowed from explicit env.
- A concrete clinician UUID initially appeared in the operation field; the regression
  showed the raw ID, then passed after canonicalizing it to `/api/clinicians/{id}`.

### GREEN

The initial focused command after the full implementation and later focused rerun:

```text
Test Files  2 passed (2)
Tests       26 passed (26)
Duration    389ms
```

Output was clean with no request logs or warnings.

## Final verification

- Full suite: `... corepack pnpm@11.22.0 --config.verify-deps-before-run=false test -- --reporter=verbose`
  — 10 files passed, 80 tests passed, exit 0.
- Lint: `... corepack pnpm@11.22.0 --config.verify-deps-before-run=false lint`
  — exit 0, no findings.
- Workspace typecheck: `... corepack pnpm@11.22.0 --config.verify-deps-before-run=false -r typecheck`
  — contracts, database, and API passed, exit 0.
- API TypeScript build: `... corepack pnpm@11.22.0 --config.verify-deps-before-run=false --filter @portal/api build`
  — exit 0.
- Lambda build: `... corepack pnpm@11.22.0 --config.verify-deps-before-run=false --filter @portal/api build:lambdas`
  — all three analyzed Node 24 bundles built, exit 0.
- Bundle inspection/import: profiles 619 inputs, availability 620, appointments 621;
  each exported a function handler and each had zero test/local inputs.
- `git diff --check` — exit 0.

## Files changed

- `apps/api/package.json`
- `apps/api/src/shared/{database,errors,http,identity,logging}.ts`
- `apps/api/src/modules/{profiles,availability,appointments}/{routes,handler}.ts`
- `apps/api/test/{events,http.test,logging.test}.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

## Self-review

- Rechecked all ten approved route/method/status mappings and strict query/path/body
  branches, including forged identity/role fields and default pagination/cancellation.
- Rechecked every response path supplies JSON, no-store, and request-ID headers and
  that unknown errors expose neither messages nor stack/database details.
- Rechecked decoded byte-size ordering, malformed and non-JSON handling, duplicate
  query rejection, and that identity comes only from the authorizer JWT claim.
- Rechecked exactly one completion log attempt per success/error request, exact field
  allowlisting, canonical dynamic operations, and sentinel password/token absence.
- Rechecked secret selection, fixed application role, direct/proxy TLS trust behavior,
  pool/time limits, client release, failed-pool disposal, and cache recovery.
- Rechecked bundle scripts use Node 24, bundle the AWS SDK, emit separate metafiles,
  and contain neither test code nor a local identity adapter.
- Rechecked the diff contains only Task 6 implementation, dependencies, tests, and
  pnpm's esbuild postinstall allowlist.

No remaining correctness concerns found. Gateway-generated 401/403/429 normalization
belongs to the Task 8 frontend API wrapper, which does not exist yet; Task 6 preserves
the service envelope and does not pre-empt that later boundary.

## Fix round 1

### Findings addressed

- Availability GET routes now derive `from` and `to` from an injectable trusted clock
  when both are absent. The derived interval is exactly seven days; supplying only one
  bound still reaches the required-window schema and returns a validation 400. The
  production availability Lambda uses the same trusted server clock for its service and
  route adapter.
- Zod issue aggregation now uses a null-prototype field-error record, so unknown fields
  named `constructor` or `toString` cannot resolve inherited functions and throw during
  `.push()`.

### TDD evidence

#### RED

Added focused route and Lambda request tests before production changes, then ran:

```text
PATH=/Users/bxl/.nvm/versions/node/v24.0.1/bin:$PATH corepack pnpm@11.22.0 --config.verify-deps-before-run=false test apps/api/test/http.test.ts apps/api/test/logging.test.ts -- --reporter=verbose
```

Relevant expected failures against `0ca5426`:

```text
availability HTTP routes > uses a trusted seven-day clock window when availability bounds are both omitted
  expected 400 to be 200
shared HTTP response and Lambda event adapter > returns validation errors for prototype-named unknown body and query fields
  expected 500 to be 400
Test Files  1 failed | 1 passed (2)
Tests       2 failed | 26 passed (28)
```

#### GREEN

After the minimal route/default-clock and null-prototype fixes, the same focused suite
passed:

```text
Test Files  2 passed (2)
Tests       28 passed (28)
```

### Verification

- Focused HTTP/logging suite: 28/28 passed.
- Full suite: 10 files, 82 tests passed. The initial sandboxed run could not access the
  local PostgreSQL test service (`connect EPERM 127.0.0.1:54329`); the authorized rerun
  completed successfully.
- `pnpm lint`: passed with no findings.
- `pnpm -r typecheck`: contracts, database, and API passed.
- `pnpm --filter @portal/api build`: passed.
- `pnpm --filter @portal/api build:lambdas`: all three Node 24 Lambda bundles passed.
- `git diff --check`: passed.

### Files changed

- `apps/api/src/modules/availability/{handler,routes}.ts`
- `apps/api/src/shared/http.ts`
- `apps/api/test/http.test.ts`

### Self-review

- Confirmed both public and self availability routes use one clock-derived seven-day
  interval only when neither bound is present, preserve query pagination, and continue
  to reject partial bounds.
- Confirmed production wiring supplies the same trusted clock to availability service
  creation and request routing.
- Confirmed the regression exercises actual Lambda body and query parsing with
  `constructor` and `toString`, observes field errors, and asserts `VALIDATION_ERROR`.
- No remaining concerns.
