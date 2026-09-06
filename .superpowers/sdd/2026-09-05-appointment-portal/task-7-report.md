# Task 7 report: Working local API against PostgreSQL

## Status

DONE

Commit: `feat: run portal services through a local API`

## What I implemented

- Added a loopback-only Node HTTP server with `startLocalServer({ pool, port })`.
  It defaults to port 3001, supports an ephemeral port for integration tests, maps
  all responses through the existing HTTP envelope, and closes both listener and
  injected PostgreSQL pool exactly once.
- Reused the Task 6 JSON parser, query parser, feature route handlers, and feature
  service factories. The local adapter therefore has the same validation, 404/405,
  response headers, 16 KiB limit, and safe error response behavior as Lambda.
- Added local identity mapping only under `apps/api/src/local/`: the exact
  `X-Local-Actor` values `patient-a`, `patient-b`, `clinician-a`, and
  `clinician-b` map to the four fixed seeded subjects. Missing, repeated, and
  unrecognized values receive the standard 401 envelope. Startup requires
  `PORTAL_LOCAL_AUTH=1` and refuses production mode.
- Changed the scenario fixture and local seed CLI to use Alice Patient, Bea
  Patient, Casey Clinician, and Devon Clinician under those fixed subjects. Updated
  existing fixture assertions that deliberately expose display names.
- Added the `dev:local` and Lambda artifact-check scripts. The aggregate Node 24
  Lambda build scans every generated `.mjs` bundle for the local identity marker or
  local module paths. Its negative fixture writes the marker into a temporary fake
  bundle and proves the guard rejects it. The marker is intentionally held in the
  local identity module, so accidentally bundling that module is detectable.
- Documented explicit Node 24.0.1/pnpm 11.22.0 Docker, migration, seed, API start,
  identity, loopback, and shutdown commands. Extended the existing `.env.example`
  rather than replacing its database setting.

## TDD evidence

### Initial setup failure (not behavioral TDD evidence)

The real ephemeral-port HTTP and contaminated-artifact tests were added before any
local server, identity adapter, or artifact checker existed.

```text
PATH=/Users/bxl/.nvm/versions/node/v24.0.1/bin:$PATH corepack pnpm@11.22.0 --config.verify-deps-before-run=false test apps/api/test/local-api.test.ts apps/api/test/lambda-artifact-guard.test.ts -- --reporter=verbose
```

Result before implementation:

```text
Failed Suites 2
Cannot find module '../src/local/server.js'
Cannot find module '../scripts/check-lambda-artifacts.mjs'
```

This only demonstrated missing modules. It was not an executable behavioral RED and
is not used as TDD evidence for the implementation. The review-round regression
evidence below records a real HTTP RED against a working baseline.

### GREEN

After implementation, the focused real HTTP/PostgreSQL and guard suite passed:

```text
Test Files  2 passed (2)
Tests       5 passed (5)
```

The final full suite, after the artifact marker review fix, passed 12 files and 88
tests. It includes five local API tests and the artifact guard’s negative fixture.

## Verification

All commands used the explicit Node 24.0.1 path and pnpm 11.22.0.

```text
pnpm test -- --reporter=dot                         12 files, 88 tests passed
pnpm lint                                            passed
pnpm -r typecheck                                   contracts, database, and API passed
pnpm --filter @portal/api build                     passed
pnpm --filter @portal/api build:lambdas             passed, including artifact guard
```

The database-backed commands required the local PostgreSQL container. The sandbox
blocked its loopback socket, so those test runs were executed with the approved
local-container permission.

## Files changed

- `.env.example`
- `apps/api/package.json`
- `apps/api/scripts/check-lambda-artifacts.mjs`
- `apps/api/src/local/identity.ts`
- `apps/api/src/local/server.ts`
- `apps/api/src/shared/http.ts`
- `apps/api/test/local-api.test.ts`
- `apps/api/test/lambda-artifact-guard.test.ts`
- `apps/api/test/appointments.test.ts`
- `apps/api/test/profiles.test.ts`
- `docs/runbook/local.md`
- `packages/database/src/seed.ts`
- `packages/database/test/harness.ts`
- `packages/database/test/seed.test.ts`
- `pnpm-lock.yaml`

## Self-review

- Confirmed every Lambda handler imports only shared code and feature modules; no
  Lambda bundle contains the local marker or local module path.
- Confirmed the HTTP server binds only `127.0.0.1`, startup gates execute before it
  listens, and repeated `close()` returns one shared close promise.
- Confirmed the scenario seed and CLI seed use the same four identity subjects.
- During review, I found the identity implementation had normalized the header name
  to lowercase, which would make an accidental local-module bundle less reliably
  detectable. I changed it to retain the canonical marker literal and rebuilt all
  Lambda bundles before final verification.

## Concerns

None.

## Review round 1 fixes

### What changed

- Replaced object-property local identity lookup with a typed `Map`, so inherited
  names such as `constructor`, `toString`, and `__proto__` cannot become subjects.
  The real HTTP test also confirms each of the four fixed identities remains valid.
- Made local dispatch select the owning feature route from explicit route-match
  predicates. A resource-specific 404 now remains the response from its matched
  feature handler instead of falling through to a generic route 404.
- Reworked the runbook for a fresh shell: it uses `nvm use` from the repository
  `.nvmrc`, exports `.env.example` through `set -a`, and keeps that environment for
  Compose, migration, seed, and local API commands. No machine-specific path remains.

### Behavioral TDD evidence

RED was run against implementation commit `81903de`, with only the new regression
tests added. No production code had changed.

```text
PATH=/Users/bxl/.nvm/versions/node/v24.0.1/bin:$PATH corepack pnpm@11.22.0 --config.verify-deps-before-run=false test apps/api/test/local-api.test.ts -- --reporter=verbose
```

Relevant failure output:

```text
8 tests | 2 failed
expected 200 to be 401
expected message "Clinician not found."
received message "Route not found."
```

GREEN after the typed allowlist and route-ownership dispatch:

```text
pnpm test apps/api/test/local-api.test.ts apps/api/test/lambda-artifact-guard.test.ts
Test Files  2 passed (2)
Tests       9 passed (9)
```

### Runbook validation

I loaded the documented environment in a clean command context, confirmed
`DATABASE_URL` exactly equals `postgres://portal:portal@127.0.0.1:54329/portal`,
recreated the Compose PostgreSQL service, then ran the documented migration and seed
commands. Migration applied `001_initial.sql` and `002_default_patient_role.sql`; the
fictional-user seed completed successfully.

### Final verification

```text
pnpm test -- --reporter=dot                         12 files, 91 tests passed
pnpm lint                                            passed
pnpm -r typecheck                                   contracts, database, and API passed
pnpm --filter @portal/api build                     passed
pnpm --filter @portal/api build:lambdas             passed, including artifact guard
```

### Review-round files changed

- `apps/api/src/local/identity.ts`
- `apps/api/src/local/server.ts`
- `apps/api/src/modules/{profiles,availability,appointments}/routes.ts`
- `apps/api/test/local-api.test.ts`
- `docs/runbook/local.md`
- `.superpowers/sdd/2026-09-05-appointment-portal/task-7-report.md`

### Review-round self-review

- The `Map` lookup has no inherited-property surface and returns only a string
  subject from the four literal entries.
- The profile, availability, and appointment route owners are mutually distinct;
  unknown paths use the shared generic 404 only after no feature owns the path.
- The runbook environment is exported before all commands that read `DATABASE_URL`.

### Review-round concerns

None.
