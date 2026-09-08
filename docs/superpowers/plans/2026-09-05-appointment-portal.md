# Appointment Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, deploy, verify, document, and destroy a reproducible patient/clinician appointment portal, retaining the project and sanitized evidence in GitHub.

**Architecture:** A Vite React SPA uses Cognito managed login and calls a CloudFront-routed HTTP API. Three Node.js feature Lambdas enforce permissions and use RDS Proxy to reach private PostgreSQL; CDK provisions the disposable environment. Database constraints and transactions enforce booking consistency.

**Tech Stack:** TypeScript, React, Vite, React Router, TanStack Query, React Hook Form, Zod, Tailwind CSS, shadcn/ui, react-oidc-context, oidc-client-ts, pg, AWS CDK, Cognito, API Gateway HTTP API, Lambda, S3, CloudFront, RDS PostgreSQL/Proxy, Secrets Manager, CloudWatch, GitHub Actions, Vitest, React Testing Library, Playwright.

**Spec:** [Approved design](../specs/2026-09-05-appointment-portal-design.md). Read both documents before execution.

**Status:** Plan written and self-reviewed; implementation steps remain unchecked.

## Global Constraints

The following requirements are copied from the approved specification:

- "Continuous hosting is not a requirement."
- "Appointments are 30 minutes."
- "Only future open slots can be booked."
- "Application roles live in PostgreSQL."
- "Do not persist tokens in localStorage."
- "All application routes are authenticated."
- "No Zustand initially."
- "Normal runtime never runs migrations or has schema-owner privileges."
- "AWS tests use real Cognito authentication."
- "Do not commit passwords, test session storage, or token-bearing traces."
- "Preserve shared account-level resources and report them explicitly."

Implement every requirement in the spec, not just the excerpts above. Use fictional
data, verified email self-registration for patients, privileged clinician provisioning,
30-minute non-overlapping clinician slots, explicit timezones, cancellation history,
and per-record permissions. Keep scope limited to the approved portal.

---

## Execution context and working conventions

The repository initially contains only `.gitignore` and the approved specification.
The local tools observed during planning are Node 22.15.0, pnpm 11.22.0, Docker CLI,
AWS CLI, and GitHub CLI. CLI presence does not establish a running Docker daemon,
AWS credentials, GitHub authentication, or cloud authorization checks.

Use Node 24 for the app, CI, and Lambda (`nodejs24.x`), and PostgreSQL 17 locally and
on RDS. Install a current Node 24 patch with the existing version manager and record
that patch in `.nvmrc`; choose the PostgreSQL 17 patch offered in eu-north-1 during
preflight and match the local Docker image. Pin dependencies and the Docker image
digest when resolved. Do not change the user's global Node default. Node 24 Lambda
and PostgreSQL 17/RDS Proxy support were checked in official AWS documentation;
recheck account/region availability before deployment.

Use one implementation branch/worktree established at execution time. Use the
worktree skill's environment checks before creating one. This plan is for one
integrated booking workflow: the frontend, identity, API, data, and deployment pieces
are dependent parts of that workflow, not separate independently useful products.

Each task ends with its focused checks and an explicit-path commit. Establish failing
behavior tests before implementing business behavior. Configuration-only changes need
their real build/synthesis checks, not artificial tests that restate configuration.
Do not commit a failing increment. No cloud creation is needed through Task 16.

All commands below run from the repository root unless a `--dir` or `--filter` changes
scope. Names such as `@portal/api` are package names established in Task 1. Commands
shown are execution instructions, not evidence that they have already run.

## File and interface map

| Location | Responsibility |
| --- | --- |
| `packages/contracts/src/{models,inputs,errors,index}.ts` | Zod API schemas and exported inferred types |
| `packages/database/{migrations,src,test}` | SQL, locked/checksummed migrations, fixtures and runner |
| `apps/api/src/shared/{types,errors,database,identity,http,logging}.ts` | Backend dependency and transport adapters |
| `apps/api/src/modules/{profiles,availability,appointments}/{service,repository,handler}.ts` | Feature-specific operations, SQL and Lambda entry points |
| `apps/api/src/local/server.ts` | Local HTTP and explicit local identity adapter |
| `apps/web/src/app/{router,providers,layout}.tsx` | Routes, app-wide providers, responsive navigation |
| `apps/web/src/lib/{api,auth,config,time}.ts` | Network, OIDC, public configuration and timezone helpers |
| `apps/web/src/features/{auth,clinicians,appointments,availability}/` | Pages, forms, query hooks, behavior tests |
| `infra/lib/{data,identity,api,web,operations}-construct.ts` | Focused CDK construct boundaries |
| `infra/lib/{portal,delivery}-stack.ts` | Application stack and optional GitHub deployment identity stack |
| `scripts/{preflight,deploy,provision,publish,cleanup,verify-cleanup}.ts` | Explicit lifecycle commands |
| `tests/e2e/` | Local UI and deployed Cognito/API journeys |
| `docs/{runbook,architecture,evidence}/` | How-to guidance, decisions, sanitized results |

Public contracts use these names throughout:

```ts
type Role = 'patient' | 'clinician';
type Page<T> = { items: T[]; nextCursor: string | null };
type PageQuery = { limit: number; cursor?: string };
type WindowQuery = PageQuery & { from: string; to: string };
type Me = { id: string; displayName: string; role: Role };
type Clinician = { id: string; displayName: string; biography: string;
  specialty: string; timezone: string };
type Slot = { id: string; clinicianId: string; startAt: string; endAt: string;
  status: 'open' | 'withdrawn'; isBooked: boolean };
type Appointment = { id: string; slotId: string; clinicianId: string;
  patientId: string; patientDisplayName: string; clinicianDisplayName: string;
  startAt: string; endAt: string; status: 'booked' | 'cancelled';
  cancelledAt: string | null; cancelledBy: string | null };
type CreateSlotInput = { startAt: string };
type BookInput = { slotId: string };
type CancelInput = { withdrawSlot: boolean };
type ApiErrorBody = { error: { code: string; message: string;
  requestId: string; fieldErrors?: Record<string, string[]> } };
```

Infer these types from Zod schemas, rather than maintaining independent definitions.
`startAt`, `endAt`, `from`, and `to` are offset-qualified ISO instants. The API computes
`endAt = startAt + 30 minutes`. Required fields are non-null except explicit nullable
properties. Appointment responses expose only caller-authorized joined names.

Backend-only interfaces, implemented in the named tasks:

```ts
import type { Pool, PoolClient } from 'pg';
type Actor = { sub: string };
type Clock = () => Date;
type ServicesDeps = { pool: Pool; clock: Clock };
type ProfilesService = {
  getMe(actor: Actor): Promise<Me>;
  listClinicians(actor: Actor, query: PageQuery): Promise<Page<Clinician>>;
  getClinician(actor: Actor, id: string): Promise<Clinician>;
};
type AvailabilityService = {
  listPublic(actor: Actor, clinicianId: string, query: WindowQuery): Promise<Page<Slot>>;
  listOwn(actor: Actor, query: WindowQuery): Promise<Page<Slot>>;
  create(actor: Actor, input: CreateSlotInput): Promise<Slot>;
  withdraw(actor: Actor, slotId: string): Promise<Slot>;
};
type AppointmentsService = {
  list(actor: Actor, query: PageQuery): Promise<Page<Appointment>>;
  book(actor: Actor, input: BookInput): Promise<Appointment>;
  cancel(actor: Actor, appointmentId: string, input: CancelInput): Promise<Appointment>;
};
```

`makeProfilesService(deps)`, `makeAvailabilityService(deps)`, and
`makeAppointmentsService(deps)` produce these interfaces. `AppError` carries HTTP
status, stable code, safe message and optional field errors. Tests inject `Clock`;
normal runtime uses `() => new Date()`. Evaluate that trusted server clock after
acquiring locks for future-time checks; tests inject a deterministic clock. Never
accept the current time from HTTP input.

## Task 1: Workspace and public request validation

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json`,
`eslint.config.js`, `vitest.config.ts`, `packages/contracts/package.json`,
`packages/contracts/tsconfig.json`, and `packages/contracts/src/{models,inputs,errors,index}.ts`.
Test: `packages/contracts/test/inputs.test.ts`. Modify `.gitignore`.

**Interfaces:** Produce the public contracts above and `BookInputSchema`,
`CreateSlotInputSchema`, `CancelInputSchema`, `PageQuerySchema`, `WindowQuerySchema`.
Each workspace gets its own package/tsconfig when first introduced.
Also export `encodeCursor(value:{sortValue:string;id:string}):string` and
`decodeCursor(raw:string,kind:'name'|'time'):{sortValue:string;id:string}`. Validate
UUID IDs and offset-qualified timestamps for time cursors; directory names are
bounded nonempty strings. A cursor selects SQL values, never identifiers or syntax.

- [ ] Select Node 24 and create pnpm workspaces for `apps/*`, `packages/*`, and `infra`.
  Set package names to `@portal/contracts`, `@portal/database`, `@portal/api`,
  `@portal/web`, `@portal/infra` as introduced. Root scripts: `test = vitest run`,
  `typecheck = pnpm -r typecheck`, `lint = eslint .`, `build = pnpm -r build`,
  `dev = pnpm --parallel --filter @portal/web --filter @portal/api dev`.
  Use strict TypeScript and explicit package exports; resolve workspace packages in
  source during development and bundle them into Lambda artifacts.
- [ ] Write tests for injected identity, offsetless timestamps, oversized pagination,
  malformed cursors, and date windows beyond 31 days. For example:

  ```ts
  import { expect, it } from 'vitest';
  import { BookInputSchema, CreateSlotInputSchema } from '../src/index';
  it('rejects caller-supplied patient identity', () => {
    expect(BookInputSchema.safeParse({
      slotId: '11111111-1111-4111-8111-111111111111', patientId: 'another-user',
    }).success).toBe(false);
  });
  it('requires an explicit timezone offset', () => {
    expect(CreateSlotInputSchema.safeParse({ startAt: '2030-06-02T09:00:00' }).success)
      .toBe(false);
  });
  ```
- [ ] Run `pnpm test packages/contracts/test/inputs.test.ts`; expect failure because
  exported validators do not exist yet. Then define schemas, including these rules:

  ```ts
  import { z } from 'zod';
  export const BookInputSchema = z.strictObject({ slotId: z.uuid() });
  export const CreateSlotInputSchema = z.strictObject({
    startAt: z.iso.datetime({ offset: true }),
  });
  export const CancelInputSchema = z.strictObject({
    withdrawSlot: z.boolean().default(false),
  });
  export const PageQuerySchema = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(1024).optional(),
  });
  ```
  Decode cursors as base64url JSON with strictly validated sort fields; reject invalid
  encoding/content with 400, never interpolate cursor content into SQL. Validate
  `from < to` and `to - from <= 31 days`; handlers supply the seven-day default using
  their clock when no bounds are supplied. Reject partial bounds.
- [ ] Add model/error schemas matching the interface map; export types with `z.infer`.
  Use a deterministic `(sortValue,id)` cursor; date sorting uses `(startAt,id)`,
  clinician directory uses `(displayName,id)`. Configure ESLint without suppressions.
  Export `MeSchema`, `ClinicianSchema`, `SlotSchema`, `AppointmentSchema` and generic
  `PageSchema(itemSchema)` for validated frontend responses.
- [ ] Run focused tests, `pnpm typecheck`, and `pnpm lint`; expect all to pass. Ignore
  `.runtime/`, `cdk.context.json` account lookups, local reports, and credentials while
  preserving sanitized `docs/evidence/`. Commit: `feat: establish typed portal contracts`.

## Task 2: PostgreSQL constraints and repeatable migrations

**Files:** Create `compose.yaml`, `packages/database/package.json`,
`packages/database/tsconfig.json`, `packages/database/migrations/001_initial.sql`,
`packages/database/src/{migrate,seed,index}.ts`, `packages/database/test/{harness,schema.test,migrate.test}.ts`.

**Interfaces:** Produce `migrate(pool: Pool, directory: string,
afterMigrate?: (client: PoolClient) => Promise<void>): Promise<string[]>` and
`seedDemo(pool: Pool, users: SeedUser[], now: Date): Promise<void>`.
`SeedUser = { sub: string; displayName: string; role: Role; timezone?: string }`.
Test helper `withTestDb(run: (pool: Pool) => Promise<void>): Promise<void>` creates an
isolated test database, migrates it, invokes the callback and drops it in finally.
`seedScenario(pool)` returns `patient`, `secondPatient`, `clinician`, `otherClinician`
as `Actor & { id: string }`, plus `slot: Slot`; seed dates start at 2030-06-02T09:00Z.

- [ ] Configure Docker PostgreSQL 17 bound only to localhost, a health check, and an
  ephemeral test database. Local credentials are disposable values in `.env.example`,
  never reused in AWS. Add database scripts `migrate`, `seed`, and `test:integration`.
- [ ] Write constraint tests: 30-minute duration, foreign keys, same-clinician overlaps,
  different-clinician overlaps allowed, adjacent ranges allowed, and one active booking.
  Write migration tests for reruns, two concurrent migrators, and checksum mismatch.

  ```ts
  it('allows adjacent slots and rejects overlap for the same clinician', async () => {
    await withTestDb(async pool => {
      const { clinician } = await seedScenario(pool);
      await pool.query(`INSERT INTO availability_slots(clinician_id,start_at,end_at)
        VALUES ($1,'2030-06-02T09:30Z','2030-06-02T10:00Z')`, [clinician.id]);
      await expect(pool.query(`INSERT INTO availability_slots(clinician_id,start_at,end_at)
        VALUES ($1,'2030-06-02T09:15Z','2030-06-02T09:45Z')`, [clinician.id]))
        .rejects.toMatchObject({ code: '23P01' });
    });
  });
  ```
- [ ] Run `docker compose up -d --wait` then `pnpm test packages/database/test`; expect
  missing tables/functions to fail before schema implementation.
- [ ] Create all four tables from the spec using UUID defaults, NOT NULL fields,
  role/status checks, foreign keys, timestamps and these critical constraints:

  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE availability_slots ADD CONSTRAINT slot_duration
    CHECK (end_at = start_at + interval '30 minutes');
  ALTER TABLE availability_slots ADD CONSTRAINT clinician_slot_overlap
    EXCLUDE USING gist
    (clinician_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
    WHERE (status = 'open');
  CREATE UNIQUE INDEX one_active_booking_per_slot
    ON appointments(slot_id) WHERE status = 'booked';
  ```
  Cancellation checks require both cancelled_at/cancelled_by for cancelled rows and
  neither for booked rows. Do not delete bookings or maintain an occupied column.
- [ ] Implement migrations on one checked-out connection: acquire advisory lock
  `pg_advisory_lock(71024001)`, ensure a ledger `(name,checksum,applied_at)`, compare
  SHA-256 file hashes, run each pending file and ledger insert in one transaction,
  invoke the optional afterMigrate callback on that same locked connection, then
  unlock/release in finally. Return the names applied by this invocation. Roll back
  failed transactions and fail on changed applied SQL; wrap afterMigrate in its own
  transaction so role/grant setup can be retried atomically.
- [ ] Implement fixtures/seeding with parameterized SQL and conflict-safe upserts by
  Cognito sub. Provisioning may set roles; ordinary API code may not. Seed demo slots
  relative to supplied `now`; tests use fixed dates and per-test isolated databases.
- [ ] Run migration and schema tests twice; expect the same passing results. Commit:
  `feat: enforce appointment invariants in PostgreSQL`.

## Task 3: Profiles, identity mapping and backend errors

**Files:** Create `apps/api/package.json`, `apps/api/tsconfig.json`,
`apps/api/src/shared/{types,errors}.ts`,
`apps/api/src/modules/profiles/{service,repository}.ts`,
`apps/api/test/profiles.test.ts`.

**Interfaces:** Produce `makeProfilesService(deps): ProfilesService`,
`AppError(status, code, message, fieldErrors?)`, and internal
`ensureUser(pool, actor): Promise<Me>`. All feature services reuse `ensureUser`.

- [ ] Write a test for concurrent first-use creation and preservation of a provisioned
  clinician role, plus directory pagination and missing clinician handling:

  ```ts
  it('creates a new identity once as a patient', async () => {
    await withTestDb(async pool => {
      const service = makeProfilesService({ pool, clock: () => new Date('2030-06-01T09:00Z') });
      const actor = { sub: 'new-cognito-sub' };
      const [a, b] = await Promise.all([service.getMe(actor), service.getMe(actor)]);
      expect(a.id).toBe(b.id);
      expect(a.role).toBe('patient');
    });
  });
  ```
- [ ] Run `pnpm test apps/api/test/profiles.test.ts`; expect missing service failure.
- [ ] Implement idempotent creation: `INSERT INTO users(cognito_sub,display_name)
  VALUES ($1,$2) ON CONFLICT (cognito_sub) DO NOTHING`, then SELECT by sub.
  The database default role is patient; use fictional default display name `Patient`
  if no controlled seed name exists. Never copy request role claims into that row.
- [ ] Implement directory SQL with joins restricted to clinician profiles, a validated
  `(display_name,id)` cursor, `limit + 1` fetching, and public DTO mapping. Implement
  get-by-id with safe 404. No email/password/token fields appear in these DTOs.
- [ ] Define AppError codes `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`,
  `NOT_FOUND`, `SLOT_UNAVAILABLE`, `SLOT_OVERLAP`, `APPOINTMENT_STARTED`,
  `INTERNAL_ERROR`; tests assert code and status, not stack traces.
- [ ] Run profiles and database tests, API typecheck. Commit:
  `feat: map authenticated identities to application profiles`.

## Task 4: Clinician availability with ownership checks

**Files:** Create `apps/api/src/modules/availability/{service,repository}.ts`,
`apps/api/test/availability.test.ts`.

**Interfaces:** Produce `makeAvailabilityService(deps): AvailabilityService`.
Consume `ensureUser`, `AppError`, the database and contracts from Tasks 1–3.

- [ ] Test patient rejection, another clinician's withdrawal returning 404, future-time
  validation, overlap rejection, private listing, and withdrawn/booked slots excluded
  from patient availability. Use `seedScenario` and the fixed pre-slot clock.

  ```ts
  it('rejects a patient publishing availability', async () => {
    await withTestDb(async pool => {
      const { patient } = await seedScenario(pool);
      const service = makeAvailabilityService({ pool, clock: () => new Date('2030-06-01T09:00Z') });
      await expect(service.create(patient, { startAt: '2030-06-03T09:00:00Z' }))
        .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });
  });
  ```
- [ ] Run `pnpm test apps/api/test/availability.test.ts`; confirm the expected failure.
- [ ] Implement clinician role check, server-derived clinician ID, 30-minute end time,
  future validation after locking as needed, and parameterized insertion. Map `23P01`
  to `SLOT_OVERLAP`/409. Reject nonzero seconds so published slots start on a minute.
- [ ] Public listing selects open future slots with NOT EXISTS booked appointment.
  Private listing returns the clinician's own slots with computed isBooked. Apply
  validated bounded window and `(start_at,id)` cursor; do not expose patient details.
- [ ] Withdrawal begins a transaction, locks the slot, checks owner and future time,
  rejects active bookings with 409, and changes open to withdrawn. Repeated withdrawal
  of one's already withdrawn slot returns it; another clinician still receives 404.
- [ ] Run focused and prior service tests. Commit:
  `feat: add clinician availability management`.

## Task 5: Atomic booking, cancellation and role-specific listings

**Files:** Create `apps/api/src/modules/appointments/{service,repository}.ts`,
`apps/api/test/{appointments,booking-races}.test.ts`.

**Interfaces:** Produce `makeAppointmentsService(deps): AppointmentsService`.
The transaction helper introduced here is
`inTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T>`
in `apps/api/src/shared/database.ts`, with rollback/release on every error path.

- [ ] Write the simultaneous booking test before business implementation:

  ```ts
  it('persists exactly one active booking for competing patients', async () => {
    await withTestDb(async pool => {
      const { patient, secondPatient, slot } = await seedScenario(pool);
      const service = makeAppointmentsService({ pool, clock: () => new Date('2030-06-01T09:00Z') });
      const result = await Promise.allSettled([
        service.book(patient, { slotId: slot.id }),
        service.book(secondPatient, { slotId: slot.id }),
      ]);
      expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      expect(result.filter(x => x.status === 'rejected')).toHaveLength(1);
      expect(result.find(x => x.status === 'rejected')).toMatchObject({
        reason: { status: 409, code: 'SLOT_UNAVAILABLE' },
      });
      const count = await pool.query(
        "SELECT count(*)::int AS n FROM appointments WHERE slot_id=$1 AND status='booked'",
        [slot.id]);
      expect(count.rows[0].n).toBe(1);
    });
  });
  ```
- [ ] Add tests for own/other-patient/other-clinician visibility, started appointments,
  cancel-rebook history, repeated cancellation, patient attempting withdrawSlot=true,
  and cancellation plus withdrawal racing a new booking. Run both files and confirm RED.
- [ ] Implement booking with patient role resolved from PostgreSQL, then a transaction:

  ```sql
  SELECT id, clinician_id, start_at, end_at, status
  FROM availability_slots WHERE id = $1 FOR UPDATE;
  -- Service checks open/future state using trusted server time.
  INSERT INTO appointments(slot_id,patient_id) VALUES ($1,$2)
  RETURNING id;
  ```
  Reject missing slots with 404; closed/past/occupied with 409. Map the named unique
  index violation `23505` to SLOT_UNAVAILABLE. Do not map unrelated unique errors.
- [ ] Implement cancel by reading immutable slot ID, locking the slot first, then
  locking/re-reading the appointment. Verify owner/assigned clinician before returning
  any representation; patients cannot withdraw. Update cancellation metadata and slot
  withdrawal atomically. Already-cancelled returns history without withdrawing a
  subsequently rebooked slot; that repeat call cannot change a new patient's booking.
- [ ] Implement role-specific joined listings with descending `(start_at,id)` cursor,
  bounded limit, names, and cancellation metadata. Get joined mutation response using
  the same transaction. Evaluate `deps.clock()` after locks are acquired, so lock waits
  do not permit booking a slot based on a timestamp captured before the wait.
- [ ] Run race/service/database tests and typecheck. Commit:
  `feat: make appointment booking and cancellation atomic`.

## Task 6: Lambda HTTP adapters, error mapping and structured logs

**Files:** Create `apps/api/src/shared/{http,identity,logging}.ts`,
`apps/api/src/modules/{profiles,availability,appointments}/{routes,handler}.ts`,
`apps/api/test/{http,logging}.test.ts`; modify `shared/database.ts`.

**Interfaces:** Produce
`HttpRequest = { method: string; path: string; query: Record<string,string>;
body: unknown; actor: Actor; requestId: string }` and
`HttpResponse = { statusCode: number; headers: Record<string,string>; body: string }`.
Each module exports `handleProfiles(req,service)`, `handleAvailability(req,service)`
or `handleAppointments(req,service): Promise<HttpResponse>` from its routes file,
plus a Lambda `handler` from handler.ts. Shared `respond(status,data,requestId)` and
`respondError(error,requestId)` return HttpResponse. Shared `readActor(event)` reads
only `event.requestContext.authorizer.jwt.claims.sub` and rejects its absence.

- [ ] Write route tests for every spec route, JSON/body/path validation, role-injection
  rejection, missing identity, unknown routes, and safe error responses. Fixture
  `lambdaEvent(routeKey, sub, body?)` in `apps/api/test/events.ts` creates an HTTP API v2
  JWT-authorized event without external SDK calls. Example behavioral assertion:

  ```ts
  it('does not expose database failures', () => {
    const response = respondError(new Error('SQL password=private'), 'request-1');
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: {
      code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId: 'request-1',
    } });
  });
  ```
- [ ] Run `pnpm test apps/api/test/http.test.ts apps/api/test/logging.test.ts` and
  confirm failure, then implement strict parsing and route-to-service calls. Enforce
  a 16 KiB body limit in both adapters; return 413 before parsing oversized input.
  Non-JSON or malformed JSON is 400. Unknown routes/methods return 404/405 respectively.
- [ ] Responses include `Content-Type: application/json`, `Cache-Control: no-store`,
  and `X-Request-Id`. Parse Zod issues into fieldErrors; never return raw SQL exceptions.
  API Gateway's own 401/403/429 responses may use AWS's envelope; frontend normalization
  must accept both this service envelope and gateway-generated errors.
- [ ] Log only allowlisted fields `{requestId,operation,status,durationMs,errorCode}`
  with one completion event per request. Do not stringify events, headers, bodies,
  query strings, raw exceptions or connection configuration. Test that sentinel
  password/token values never appear in captured log output.
- [ ] Implement module-specific Lambda initialization with a cached pg Pool promise.
  Read only the application secret using a bundled AWS SDK v3 Secrets Manager client;
  runtime pool max=2, TLS `rejectUnauthorized:true`, explicit CA bundle for direct
  RDS and suitable trusted CA chain for proxy. Use DB connect timeout 5s, statement
  timeout 5s, idle transaction timeout 5s; always release checked-out connections.
  Failed initialization resets the cached promise to permit recovery.
- [ ] Add esbuild package scripts that bundle each handler independently with target
  node24 and an analyzed metafile; exclude test and local identity code. Run focused
  tests, build, and typecheck. Commit: `feat: expose validated Lambda HTTP endpoints`.

## Task 7: Working local API against PostgreSQL

**Files:** Create `apps/api/src/local/{server,identity}.ts`,
`apps/api/test/local-api.test.ts`, `.env.example`, `docs/runbook/local.md`;
modify API package scripts and `compose.yaml` as needed.

**Interfaces:** Produce `startLocalServer({pool,port}): Promise<{baseUrl:string;close():Promise<void>}>`
on port 3001, binding 127.0.0.1. Consume feature route handlers from Task 6.
Local-only identity header is `X-Local-Actor` with allowlisted values patient-a,
patient-b, clinician-a, clinician-b, mapped to seeded subs, never arbitrary roles.

- [ ] Write a real HTTP test that starts the server on an ephemeral port, posts a
  booking as patient-a, and verifies patient-b's list excludes it. Also test missing
  local identity, a bogus identity, and payload size enforcement.
  Set `fixture = await seedScenario(pool)` and obtain baseUrl from the ephemeral
  server in test setup. seedScenario uses the four fixed local identity subs.

  ```ts
  const response = await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Local-Actor': 'patient-a',
    }, body: JSON.stringify({ slotId: fixture.slot.id }),
  });
  expect(response.status).toBe(201);
  ```
- [ ] Run `pnpm test apps/api/test/local-api.test.ts`; expect connection/adapter failure.
- [ ] Implement Node's HTTP adapter, sharing body parsing, route matching, service
  factories and response mapping. Local identities are enabled only when
  `PORTAL_LOCAL_AUTH=1` and `NODE_ENV !== 'production'`; fail startup otherwise.
  The Lambda adapter never imports this module or trusts X-Local-Actor.
- [ ] Document commands to start Docker, migrate, seed four fictional users, and run
  the local API. Add an artifact check for local identity marker strings and local
  module paths in all production Lambda bundles. Its failing case must prove detection.
- [ ] Run real local HTTP tests plus `pnpm --filter @portal/api build`. Verify shutdown
  closes the server and pg pool. Commit: `feat: run portal services through a local API`.

## Task 8: React shell, authentication provider and network client

**Files:** Create web package/Vite/TypeScript config, `apps/web/index.html`,
`apps/web/src/{main.tsx,index.css}`, `app/{router,providers,layout}.tsx`,
`lib/{config,auth,api}.ts`, `features/auth/{auth-provider,require-session,sign-in-page}.tsx`,
`features/auth/auth.test.tsx`, `lib/api.test.ts`, and `components/ui/button.tsx`.

**Interfaces:** `PublicConfig = { mode:'local'|'cognito'; apiBaseUrl:string;
issuer?:string; clientId?:string; cognitoDomain?:string; redirectUri?:string;
logoutUri?:string }` is parsed with discriminated Zod validation. `useSession()`
returns `{ sub:string|null; accessToken:string|null; isLoading:boolean;
signIn(returnPath?:string):Promise<void>; signOut():Promise<void> }`.
`apiRequest<T>(path,options,schema): Promise<T>` validates JSON using the supplied Zod
schema and throws `ApiClientError` with status/code/message/fieldErrors. It uses the
session adapter for headers; components never manually attach tokens.
Export `createApiClient(getHeaders:()=>Record<string,string>)` to produce that
apiRequest function; options is RequestInit, path is relative to `/api`, and schema
is `z.ZodType<T>`. The auth provider supplies getHeaders through an API context;
`useApiClient()` returns the current function to query hooks. No mutable global token
variable is used. Local getHeaders supplies X-Local-Actor; Cognito getHeaders supplies
the current Bearer token.

- [ ] Install the agreed web libraries, Tailwind Vite integration and initial shadcn
  button/dialog/form primitives; choose one supported shadcn primitive family and
  retain it consistently. Create React Testing Library setup with jsdom and cleanup.
- [ ] Test that sign-out and identity changes remove private query data, a protected
  route preserves a safe relative return path, 401 displays sign-in, and malformed
  gateway JSON becomes a safe error. No real token is needed in unit fixtures:

  ```ts
  it('normalizes gateway authentication errors', async () => {
    const apiRequest = createApiClient(() => ({}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Unauthorized' }), { status: 401 })));
    await expect(apiRequest('/me', { method: 'GET' }, MeSchema))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
  ```
- [ ] Run `pnpm test apps/web/src/features/auth apps/web/src/lib/api.test.ts` to RED.
- [ ] Create Cognito OIDC configuration with code+PKCE, `openid profile portal/access`,
  no client secret, and library-provided in-memory user storage. Store only redirect
  transaction state in sessionStorage. Remove callback code/state from the URL via
  `history.replaceState`; preserve only validated same-origin relative return paths.
  Explicitly configure issuer discovery/endpoint metadata if Cognito's logout differs
  from generic OIDC end-session behavior; sign-out calls Cognito `/logout` with
  client_id and logout_uri and clears tokens/query state before redirecting.
- [ ] Load `/config.json` before rendering; production must require mode=cognito and
  reject missing issuer/client ID. Local mode uses a development-only session provider
  selectable among the four seeded identities. Guard its dynamic import with Vite's
  build-time `import.meta.env.DEV`; verify it is absent from the production bundle.
- [ ] Configure Vite port 5173 and proxy `/api` to 127.0.0.1:3001. Implement a responsive
  navigation shell, auth loading/error screens and role navigation based on `/api/me`.
  Expose routes `/clinicians`, `/clinicians/:id`, `/appointments`,
  `/clinician/availability`, `/clinician/appointments`, `/auth/callback`, `/signed-out`.
- [ ] Implement fetch wrapper: same-origin `/api`, JSON parsing, validated success
  DTOs, AbortSignal support, no automatic mutation retry, and generic gateway error
  fallback. TanStack queries retry at most once for transient 5xx and never 401/403/409.
- [ ] Run web focused tests, typecheck and production build. Commit:
  `feat: add authenticated React application shell`.

## Task 9: Patient browsing, booking and cancellation screens

**Files:** Create `apps/web/src/features/clinicians/{queries,directory-page,detail-page}.tsx`,
`features/appointments/{queries,patient-page,booking-form,cancel-dialog}.tsx`,
`features/appointments/patient.test.tsx`, `features/clinicians/directory.test.tsx`;
modify `app/router.tsx`. Non-JSX query modules may use `.ts` instead of `.tsx`.

**Interfaces:** Export `useClinicians`, `useClinician`, `useSlots`,
`useAppointments`, `useBookAppointment`, `useCancelAppointment` hooks. All private
query keys begin `[sub,...]`; shared appointment hooks consume the same API contracts
for patient and clinician views. Cancellation input defaults withdrawSlot=false.

- [ ] Write accessible UI behavior tests: loading/empty/error states, filter changes,
  pending submit disables a second action, successful booking updates both lists,
  conflict refreshes availability, and cancellation requires dialog confirmation.

  ```tsx
  expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
  await screen.findByText('This slot was just booked. Please choose another.');
  expect(screen.queryByText('Appointment confirmed')).not.toBeInTheDocument();
  ```
  Test setup renders actual pages inside MemoryRouter, QueryClientProvider and a
  local test session; use deterministic fetch fixtures with deferred promises for
  pending states. Define `renderPortalPage` in `apps/web/src/test/render.tsx`.
- [ ] Run `pnpm test apps/web/src/features/clinicians apps/web/src/features/appointments`
  and establish failure before page implementation.
- [ ] Implement clinician directory cards and profile page with paginated available
  slots. URL query parameters retain selected date; compute an explicit UTC query
  window from viewer timezone and validate the URL before issuing API requests.
- [ ] Implement booking form with React Hook Form/Zod, the selected slot ID, clear
  timezone label and server-confirmed status. Mutation success invalidates `[sub,'slots']`
  and `[sub,'appointments']`; failure 409 refreshes slots; network ambiguity refetches
  bookings before presenting another attempt. Do not optimistically confirm a booking.
- [ ] Implement appointments view with future and cancelled history, names/timestamps,
  cancel dialog, keyboard focus restoration and per-row pending states. Hide the cancel
  action for started appointments while retaining authoritative server validation.
- [ ] Run focused tests and web build. Commit: `feat: complete patient appointment journeys`.

## Task 10: Clinician screens and timezone-safe slot entry

**Files:** Create `apps/web/src/features/availability/{queries,clinician-page,slot-form}.tsx`,
`features/appointments/clinician-page.tsx`, `lib/time.ts`,
`lib/time.test.ts`, `features/availability/clinician.test.tsx`;
modify `app/router.tsx` and shared cancellation UI.

**Interfaces:** Produce `localMinuteToInstant(local:string,zone:string): string` and
`formatAppointmentTime(instant:string,zone:string): string`. Use
`@js-temporal/polyfill` explicitly for IANA/DST disambiguation; native Date parsing of
timezone-less input is not acceptable. Add `useOwnSlots`, `useCreateSlot`, `useWithdrawSlot`.

- [ ] Write DST cases for Europe/Stockholm, valid conversion, and user-visible overlap
  errors. Verify patient access is rejected and a clinician can cancel-and-withdraw:

  ```ts
  it('rejects skipped and repeated local times', () => {
    expect(() => localMinuteToInstant('2026-03-29T02:30', 'Europe/Stockholm')).toThrow();
    expect(() => localMinuteToInstant('2026-10-25T02:30', 'Europe/Stockholm')).toThrow();
    expect(localMinuteToInstant('2026-09-05T10:00', 'Europe/Stockholm'))
      .toBe('2026-09-05T08:00:00Z');
  });
  ```
- [ ] Run `pnpm test apps/web/src/lib/time.test.ts apps/web/src/features/availability`
  to RED, then implement conversion:

  ```ts
  import { Temporal } from '@js-temporal/polyfill';
  export function localMinuteToInstant(local: string, zone: string): string {
    return Temporal.PlainDateTime.from(local)
      .toZonedDateTime(zone, { disambiguation: 'reject' }).toInstant().toString();
  }
  ```
- [ ] Build a labelled date/time form in the clinician profile's timezone, show the
  30-minute end preview, reject seconds and past instants, and submit only startAt.
  Present an agenda list, avoiding a complex drag/drop calendar dependency.
- [ ] Implement open/booked/withdrawn slot indicators, withdrawal only on open unbooked
  future slots, and clinician appointment table with fictional patient display names.
  Cancellation dialog offers an explicit "Withdraw this slot too" checkbox for
  clinicians; its default is false. Invalidate clinician availability and appointments.
- [ ] Run DST/component tests, all web tests and production build. Commit:
  `feat: add clinician scheduling with explicit timezones`.

## Task 11: Private database infrastructure and removal policies

**Files:** Create `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`,
`infra/bin/portal.ts`, `infra/lib/{config,data-construct,portal-stack}.ts`,
`infra/test/{data,config}.test.ts`.

**Interfaces:** `PortalConfig = { account:string; region:string; postgresVersion:string;
phase:'bootstrap'|'ready'; frontendUrl?:string; qualifier:string }`.
`DataConstruct` exposes `vpc`, `database`, `proxy`, `adminSecret`, `applicationSecret`,
`apiSecurityGroup`, `migrationSecurityGroup`. `PortalStack(scope,id,{env,config})`
composes constructs; physical project tag is `Project=appointment-portal`.

- [ ] Write CDK assertions for zero NAT gateways, two isolated subnets, no public RDS,
  encrypted storage, TLS proxy, separate secrets, and Delete removal policies:

  ```ts
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    PubliclyAccessible: false, StorageEncrypted: true, MultiAZ: false,
    DeletionProtection: false,
  });
  template.hasResourceProperties('AWS::RDS::DBProxy', { RequireTLS: true });
  ```
  Construct test stack with concrete fake account `111111111111`, region eu-north-1,
  and two concrete test AZs via CDK context; no AWS lookup/network is needed for tests.
- [ ] Run `pnpm test infra/test/data.test.ts infra/test/config.test.ts` to RED, then
  configure a VPC with `maxAzs:2`, `natGateways:0`, isolated `/24` subnets, a PostgreSQL
  17 engine from `PostgresEngineVersion.of(config.postgresVersion,'17')`, db.t4g.small,
  20 GiB encrypted gp3 storage, single-AZ, no storage autoscaling, and no final snapshot.
  Set backup retention zero and delete automated backups for the disposable database.
- [ ] Create independent generated secrets for the admin and fixed `portal_app`
  username. Secrets Manager interface endpoint uses private DNS and an endpoint SG
  accepting port 443 only from API and migration SGs. API-to-proxy and proxy-to-RDS
  allow port 5432; migration-to-RDS allows port 5432. Do not allow API-to-RDS directly.
- [ ] Configure proxy TLS, maxConnectionsPercent=60, maxIdleConnectionsPercent=30,
  borrow timeout 5s, and no debug SQL logging. Final ready mode attaches only the
  application secret. For initial bootstrap mode attach only the admin secret so
  target health can stabilize before portal_app exists; API functions never receive
  that credential. Task 14 provisions portal_app, and Task 17 switches the proxy to
  application-only credentials before any browser verification or publication.
- [ ] Assert ready mode proxy permissions exclude admin-secret access, application
  SGs lack public ingress, and resources have project tags. Record the temporary
  bootstrap credential behavior in `docs/architecture/deployment.md` when created.
- [ ] Run CDK tests and typecheck. Commit:
  `feat: define private PostgreSQL and proxy infrastructure`.

## Task 12: Cognito managed login and JWT identity infrastructure

**Files:** Create `infra/lib/identity-construct.ts`, `infra/test/identity.test.ts`;
modify `infra/lib/portal-stack.ts`.

**Interfaces:** `IdentityConstruct(scope,id,{config})` exposes `userPool`, `appClient`,
`domain`, `issuer`, and `apiScope='portal/access'`. It does not import WebConstruct.

- [ ] Test self-sign-up, email verification, no client secret, code flow only, the API
  scope, explicit callback URLs, managed login branding, and user-pool removal:

  ```ts
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
    AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: Match.arrayWith(['openid', 'profile', 'portal/access']),
  });
  template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
    UseCognitoProvidedValues: true,
  });
  ```
- [ ] Run `pnpm test infra/test/identity.test.ts` to RED. Implement a Cognito Essentials
  user pool for newer managed login, email sign-in, self-registration, auto-verified
  email, email account recovery, and a domain prefix unique to account/region/project.
  Use `ManagedLoginVersion.NEWER_MANAGED_LOGIN` plus `CfnManagedLoginBranding` tied to
  the app client with `useCognitoProvidedValues:true`.
- [ ] Define resource server `portal` and scope `access`. App client includes openid,
  profile, portal/access, code flow, supported Cognito identity provider, access token
  validity five minutes and refresh validity one day. User MFA is optional for this
  demo; do not introduce an SMS dependency. No identity pool is created.
- [ ] Avoid a CloudFormation cycle: config.frontendUrl is a literal from deployment
  outputs, never a reference to the CloudFront resource. Bootstrap callbacks include
  only `http://localhost:5173/auth/callback`; ready mode adds the deployed callback and
  `/signed-out` logout URL. Reject non-HTTPS deployed URLs or missing ready-mode URL.
  Existing ready deployments must never revert to bootstrap mode.
- [ ] Add assertions that callbacks contain no CloudFront Ref/GetAtt, and user pool
  ID/app client ID stay stable between bootstrap and ready synthesis. Run tests and
  typecheck. Commit: `feat: configure Cognito managed login for the portal`.

## Task 13: Feature Lambdas, API routing, CloudFront and operations

**Files:** Create `infra/lib/{api,web,operations}-construct.ts`,
`infra/functions/spa-rewrite.js`, `infra/test/{api,web,operations}.test.ts`;
modify PortalStack and add `scripts/check-bundles.ts`.

**Interfaces:** ApiConstruct consumes DataConstruct and IdentityConstruct and exposes
`httpApi`, `functions`, `apiUrl`. WebConstruct consumes apiUrl and exposes `bucket`,
`distribution`, `frontendUrl`. OperationsConstruct consumes functions/httpApi/database/
proxy and creates log/metric resources. Stack outputs are exact names:
`FrontendUrl`, `ApiUrl`, `DistributionId`, `WebBucketName`, `UserPoolId`, `ClientId`,
`Issuer`, `CognitoDomain`, `ProxyName`, `DatabaseId`, `MigrationFunctionName` (Task 14).

- [ ] Write assertions that all ten spec routes require JWT and portal/access, API
  Lambdas use Node 24, no admin secret is granted to them, and CloudFront disables API
  caching. Unit-test frontend rewriting preserves API/asset paths:

  ```ts
  expect(rewrite('/appointments')).toBe('/index.html');
  expect(rewrite('/api/appointments')).toBe('/api/appointments');
  expect(rewrite('/assets/app.js')).toBe('/assets/app.js');
  ```
  Export a pure rewrite test helper alongside the deployable CloudFront function
  source, or evaluate that source in a restricted JS context for tests.
- [ ] Run `pnpm test infra/test/api.test.ts infra/test/web.test.ts infra/test/operations.test.ts`
  to RED. Create three NodejsFunctions from the Task 6 entry points, 512 MiB, 15s
  timeout, ARM64, reservedConcurrency=5 each, isolated subnets and API SG. Bundle AWS
  SDK clients explicitly; add CA assets and grant read of applicationSecret only.
- [ ] Configure HTTP API JWT authorizer issuer/client ID, scope portal/access on each
  route, conservative stage throttling rate=2 and burst=3, and JSON access logs. Same-origin web
  traffic needs no permissive CORS. If localhost uses the deployed API, allow only
  the explicit localhost origin and Authorization/Content-Type, never wildcard origins.
- [ ] Configure S3 block-public-access, enforceSSL, versioning off, destroy policy and
  autoDeleteObjects. CloudFront uses `S3BucketOrigin.withOriginAccessControl(bucket)`
  for default behavior and HttpOrigin for `/api/*`, HTTPS-only origin transport,
  CachePolicy.CACHING_DISABLED, OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER and
  AllowedMethods.ALLOW_ALL. Explicitly cover `/api` itself with the API behavior.
- [ ] Add frontend-only SPA function, default root index.html, HTTPS redirection,
  security headers and an application CSP with only the required Cognito connect
  origins and same-origin assets. Use no global 403/404-to-index response mapping.
  Keep config.json/index.html revalidated and hashed assets immutable at publication.
- [ ] Create named one-week retention log groups with destroy policy, Lambda error/
  throttle and API 5xx alarms, and a dashboard for latency, errors, connections and
  proxy borrow latency. No email notification subscription is required. Set missing
  alarm data to notBreaching. Capture API stage request IDs and Lambda's passed ID.
- [ ] Define `pnpm --filter @portal/infra synth` and root `check:bundles`. Run the
  ready/boot CDK assertions, synth, build, and bundle guard. Commit:
  `feat: connect the portal through CloudFront and API Gateway`.

## Task 14: Private migration execution and controlled identity provisioning

**Files:** Create `packages/database/src/{lambda,provision-role}.ts`,
`packages/database/test/provision-role.test.ts`, `scripts/{invoke-migration,provision}.ts`,
`scripts/test/provision.test.ts`; modify DataConstruct/PortalStack and DB package build.

**Interfaces:** Migration Lambda accepts only
`{action:'migrate'} | {action:'seed';users:SeedUser[];now:string}` and returns
`{ok:true;appliedMigrations:string[]}` or safe failure. `invokeMigration(name,payload)`
checks SDK FunctionError and payload.ok; HTTP 200 from Lambda Invoke alone is not success.
`provisionUsers(userPoolId, accounts): Promise<SeedUser[]>` consumes controlled email/
displayName/role entries. Passwords are generated in memory or supplied through a
protected input channel and stored only in `.runtime/` with mode 0600 for browser tests.
`provisionAppRole(client: PoolClient, password: string): Promise<void>` is the
afterMigrate callback implementation from Task 2, operating on the same connection.

- [ ] Test repeated role provisioning, quoted password safety, migration rollback,
  and least-privilege SQL: portal_app cannot CREATE TABLE, change a user's role, or
  insert clinician profiles; ordinary app CRUD succeeds with the app credential.
  Test seeded role mapping against Cognito sub, not email or a guessed username.

  ```ts
  await expect(appPool.query('CREATE TABLE forbidden_table(id int)'))
    .rejects.toMatchObject({ code: '42501' });
  await expect(appPool.query("UPDATE users SET role='clinician' WHERE id=$1", [patient.id]))
    .rejects.toMatchObject({ code: '42501' });
  ```
- [ ] Run DB provisioning tests to RED. Implement a fixed role name portal_app,
  LOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE, and grants for SELECT plus required INSERT/
  UPDATE columns only. Users INSERT grants include cognito_sub/display_name, not role;
  slot/appointment mutations have their needed columns. Revoke CREATE on public from
  PUBLIC. Grant the database CONNECT and schema USAGE privileges. Use pg-format `%L`
  for the generated password in role DDL; identifiers are fixed, never user-supplied.
- [ ] Implement migration Lambda using admin secret/direct database TLS and application
  secret for role password only. Acquire the migration lock, execute migrations, then
  provision grants before releasing; avoid taking the same lock on a second connection.
  Bundle SQL and RDS CA files. Give it reserved concurrency 1, memory 512 MiB, timeout
  120s, migration SG and a separate log group. There is no public API route to this function.
- [ ] Implement provisioning with AdminCreateUser MessageAction=SUPPRESS, controlled
  verified email attributes, and AdminSetUserPassword Permanent=true for demo accounts.
  Explicitly record these as pre-confirmed test accounts; manual registration tests
  follow normal verification. Query UserAttributes for sub and invoke seed with it.
  Retries reuse existing controlled users without downgrading roles or duplicating rows.
- [ ] Write `scripts/test/provision.test.ts` using injected AWS SDK clients to check
  request sequence, no credential logging, partial failure recovery, and Lambda
  FunctionError propagation. Root script `db:setup:aws` invokes migrate then seed;
  actual execution remains Task 17.
- [ ] Run SQL privilege tests, script tests and CDK migration assertions; ensure API
  functions cannot read adminSecret. Commit:
  `feat: provision schema and demo users through private setup functions`.

## Task 15: Browser journeys, accessibility and pull-request checks

**Files:** Create `playwright.config.ts`, `tests/e2e/{fixtures,patient,clinician,accessibility}.ts`,
`tests/e2e/local-auth.setup.ts`, `.github/workflows/checks.yml`,
`scripts/check-artifacts.ts`, `docs/runbook/testing.md`.
Use `.spec.ts` suffixes for executable Playwright suites, keeping fixtures.ts separate.

**Interfaces:** Playwright projects are `local-desktop`, `local-mobile`, and `aws`.
`signIn(page,account)` uses local identity selection for local projects and Cognito
managed login for aws. `account` is one of patient-a/patient-b/clinician-a/clinician-b;
fixtures supply secrets at runtime, never through committed test source.

- [ ] Write local end-to-end tests for patient booking/cancellation and clinician slot
  publication/withdrawal before running a real browser. Include stable role selectors:

  ```ts
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByRole('status')).toHaveText('Appointment confirmed');
  await page.getByRole('link', { name: 'My appointments' }).click();
  await expect(page.getByText('Upcoming appointment')).toBeVisible();
  ```
- [ ] Run `pnpm exec playwright test --project=local-desktop`; diagnose any failing
  integration behavior, then make the smallest fixes in the responsible app modules.
  Do not change selectors to conceal incorrect UI or replace real API calls with mocks.
- [ ] Add fixtures that reset an isolated E2E database, seed four users and future slots,
  and launch local API + Vite. Use one worker initially for stateful shared fixtures;
  racing-booking tests explicitly create parallel clients against their own slot.
- [ ] Add keyboard journeys for slot selection, dialog open/close/confirm, focus return,
  invalid form focus and live error announcements. Add axe checks using
  `@axe-core/playwright`, failing on serious/critical violations; manually review
  contrast, labels, screen widths and focus behavior. Check 390px and 1280px viewports.
- [ ] Define checks.yml for pull_request and push with read-only contents permission, Node 24, pinned pnpm,
  frozen lockfile install, a PostgreSQL 17 service, lint/typecheck/unit/integration,
  production builds, CDK synthesis/assertions, bundle guards and local Playwright.
  Pin third-party action revisions to verified commit SHAs during implementation.
  No AWS credentials or production secrets are available to pull-request jobs.
- [ ] Implement artifact guard to reject local auth code and known test credential
  sentinels in production output. Scope scans to generated artifacts and sensitive
  files rather than interpreting documentation examples as credentials. Keep traces
  and storage state out of Git and disable traces for real-auth tests by default.
- [ ] Run the complete local checks once, fix real failures, and commit:
  `test: verify portal journeys and automate pull request checks`.

## Task 16: Repeatable deployment, OIDC delivery and verified cleanup tools

**Files:** Create `infra/lib/delivery-stack.ts`, `infra/test/delivery.test.ts`,
`scripts/{preflight,deploy,publish,cleanup,verify-cleanup,lifecycle-types}.ts`,
`scripts/test/{lifecycle,cleanup}.test.ts`, `.github/workflows/{demo,destroy}.yml`,
`docs/runbook/{deploy,destroy}.md`, `docs/architecture/deployment.md`.
Modify root scripts, PortalStack outputs and `infra/bin/portal.ts`.

**Interfaces:** `DeploymentManifest = { account:string; region:string; projectTag:string;
appStack:string; deliveryStack?:string; toolkitStack:string; qualifier:string;
phase:'bootstrap'|'ready'; outputs:Record<string,string>;
resources:Array<{type:string;id:string;arn?:string;owned:boolean}> }`.
Persist the manifest without credentials to `.runtime/deployment.json` after every
successful phase and before destruction. `runDemo(deps)` coordinates preflight,
CDK commands, migration, provisioning, publication and tests using injected adapters.
`cleanup(manifest,deps)` deletes only owned resources; `verifyCleanup(manifest,deps)`
returns `{remaining:ResourceRecord[];scheduled:ResourceRecord[];shared:ResourceRecord[]}`.
Define `ResourceRecord` as the resource item shape above.

- [ ] Write unit tests for deployment phase order, migration errors stopping publication,
  resumed ready deployments never resetting bootstrap auth, account mismatch refusing
  cleanup, partial stack creation, retained snapshots, versioned S3 objects, pagination,
  and shared resource preservation. Example:

  ```ts
  it('does not claim cleanup while a project snapshot remains', async () => {
    const result = await verifyCleanup(manifest, fakeInventory({
      snapshots: [{ type: 'AWS::RDS::DBSnapshot', id: 'demo-final', owned: true }],
    }));
    expect(result.remaining).toHaveLength(1);
  });
  ```
  Define fakeInventory and its paginated SDK response adapters in
  `scripts/test/fakes.ts`; manifest is a fixed safe test-account fixture.
- [ ] Run `pnpm test scripts/test/lifecycle.test.ts scripts/test/cleanup.test.ts infra/test/delivery.test.ts`
  to RED. Implement read-only preflight: STS account match, region/engine/class support,
  RDS Proxy availability, Lambda quota headroom for 16 total reserved executions,
  Docker/runtime versions, Git cleanliness and cost estimate against user-supplied cap.
  Include database, proxy minimum charges, endpoint per-AZ hours, Cognito, logging,
  storage and transfer; quote current prices and duration assumptions in a local report.
  A cap is an execution check, not an AWS-enforced spending limit.
- [ ] Use project-specific CDK bootstrap stack `AppointmentPortalToolkit` and qualifier
  `apptdemo`, with DefaultStackSynthesizer using the same qualifier. Inspect before
  creation; never adopt/delete an existing stack merely because its name matches.
  Mark resources owned only when created by this project or ownership is established.
  Record bootstrap S3/ECR/SSM/IAM assets for final cleanup.
- [ ] Define DeliveryStack with a GitHub OIDC role restricted by exact audience
  sts.amazonaws.com and subject `repo:OWNER/REPOSITORY:environment:demo`; configure
  the GitHub environment to allow the intended branch. OWNER/REPOSITORY here is a
  runtime value supplied from the selected repository, not a literal in the policy.
  Reuse an existing GitHub OIDC provider if present and mark it shared. Grant only
  required bootstrap role assumptions plus project-scoped upload, migration invoke,
  controlled Cognito provisioning and inventory permissions. Restrict iam:PassRole
  to project/qualifier roles with service conditions; document CloudFormation's
  provisioning authority separately from runtime least-privilege roles.
- [ ] Implement deployment with shell-free subprocess argument arrays and SDK calls:
  first bootstrap-mode CDK deploy, save outputs/inventory, invoke migration/role setup,
  provision/seed users, then ready-mode CDK deploy with literal FrontendUrl and
  application-only proxy secret. Wait for proxy target health, rerun idempotent migration
  verification, and publish frontend only after the ready configuration is confirmed.
  On updates start from saved ready config and migrate compatible schema changes before
  publication. Treat function invocation errors and unhealthy proxy targets as failures.
- [ ] Publish by uploading hashed assets first with immutable cache headers, then
  validated public config.json and index.html with no-cache, then invalidate shell/config
  paths and wait for completion. Do not delete old assets until verification completes.
  Inject only public Cognito identifiers, origin URLs and mode=cognito into config.
  Compare deployed callback URL with actual CloudFront URL before browser tests.
- [ ] Create manual demo/destroy workflows with OIDC permission `id-token:write` and
  contents:read, concurrency group `appointment-portal-demo`, cancel-in-progress=false,
  and time-bounded jobs. demo runs checks/deploy/automated verification and captures
  sanitized artifacts; on failure it captures diagnostics and attempts app cleanup.
  A successful demo remains only for the immediately following manual registration
  and inspection in Task 17, then Task 18 destroys it. Provide local cleanup for a
  cancelled runner where an always step cannot execute; do not rely on it as a guarantee.
- [ ] Implement cleanup from saved inventory plus live CloudFormation resources and
  project tags: delete app stack, wait, inspect residual DBs/proxies/snapshots/backups,
  S3 current versions/delete markers, secrets, log groups, interfaces and VPC endpoints.
  Use service-specific paginated inventory because tags alone are incomplete. Handle
  Secrets Manager pending deletion explicitly; only force-delete recorded disposable
  project secrets when the runbook calls for immediate cleanup. Never log secret values.
- [ ] Implement a dry-run mode producing exact owned resource IDs without deletion.
  Post-cleanup checks return nonzero for active owned leftovers and separately report
  scheduled deletion and shared resources. Archive the application inventory before
  deleting deployment roles; bootstrap/delivery cleanup is local and last. Never delete
  shared OIDC providers or bootstrap infrastructure used by other projects.
- [ ] Define root scripts `demo:preflight`, `demo:deploy`, `demo:verify`, `demo:destroy`,
  `demo:verify-cleanup` backed by the scripts above; `demo:verify` runs the aws Playwright
  project and Task 17 deployed API tests. Add safe examples using `.runtime/` config
  files instead of passwords or secret payloads in shell arguments.
- [ ] Run lifecycle/cleanup/CDK tests, lint, typecheck, builds and synthesis. Commit:
  `feat: automate disposable AWS deployment and cleanup`.
  This task writes and tests the AWS-operation code using injected clients; actual
  bootstrap, repository publication and deployment are performed only in Task 17.

## Task 17: Real AWS verification and sanitized portfolio evidence

**Files:** Create `tests/e2e/{aws-auth,aws-api,aws-races}.spec.ts`,
`scripts/{verify-aws,measure-web}.ts`, `docs/evidence/verification.md`,
`docs/evidence/performance.md`; modify `docs/runbook/deploy.md`.
Generated sanitized screenshots go to `docs/evidence/screenshots/`.

**Interfaces:** `verifyAws(manifest): Promise<VerificationSummary>` records scenario,
pass/fail, timestamp, commit and request ID, without tokens or personal data.
`VerificationSummary = { commit:string; checkedAt:string;
checks:Array<{name:string;status:'passed'|'failed'|'manual-passed';detail:string}> }`.
The manual registration result cannot be populated by an automated test assumption.

- [ ] Obtain missing execution inputs: selected AWS account/profile, GitHub destination
  and visibility, controlled email addresses and a temporary-environment cost ceiling.
  Inspect existing configured resources before creating duplicates. Use authenticated
  local AWS access for bootstrap/setup; use the repository OIDC workflow for deployment.
  Do not publish the repository until destination and visibility are known.
- [ ] Write deployed auth tests using real managed-login browser redirects and PKCE.
  Keep tokens only in worker memory when needed for API tests; observe the outgoing
  Authorization header in a controlled test callback without printing/storing it.
  Disable traces/video during credential entry and token acquisition. A new page reload
  with in-memory tokens may require a login redirect; assert correct return navigation.
- [ ] Write real concurrent requests through CloudFront, using two signed-in patients:

  ```ts
  const [a, b] = await Promise.all([
    patientA.post('/api/appointments', { data: { slotId } }),
    patientB.post('/api/appointments', { data: { slotId } }),
  ]);
  expect([a.status(), b.status()].sort()).toEqual([201, 409]);
  ```
  Verify the owning clinician's authorized listing shows one active booking for that
  slot. Also test cancellation reopening, clinician cancel-withdraw, cross-user access,
  forged body IDs, malformed tokens, missing scope, ID-token rejection, and actual
  access-token expiry using the short demo lifetime. Ensure test traffic is within
  configured throttling except a separate controlled throttling check.
- [ ] Run all local required checks before cloud creation. Then preflight, provision
  repository/bootstrap/delivery setup, and launch the manual deployment workflow.
  Observe completion through purpose-built CLI/API status, diagnosing failures from
  request-correlated logs. Fix proven causes and rerun affected checks; do not broaden
  permissions or remove assertions to turn a failure green.
- [ ] Execute the aws Playwright project at desktop/mobile sizes against the real
  CloudFront origin. Verify API has no cache hits/stale private responses, direct
  API Gateway enforces JWT, S3 is private, nested UI refresh works, and a missing asset
  is not returned as index.html. Retrieve CloudWatch metrics/logs with request IDs,
  distinguishing warm/cold observations without claiming a load-test SLA.
- [ ] Complete one normal self-registration with a controlled inbox, email verification,
  initial patient role, sign-in, sign-out and password recovery. If email access needs
  user action, ask for that specific action and continue independent verification;
  never claim the registration check passed from provisioned-user tests.
- [ ] Measure production frontend performance on three repeat runs at a recorded
  mobile profile; target median Lighthouse performance >=90 and investigate misses.
  For authenticated routes preserve the active in-memory session using Lighthouse
  user-flow instrumentation or measure while explicitly re-authenticating; do not
  accidentally benchmark the sign-in page as the appointments page. Report which
  metrics each measurement mode supplies and avoid field Core Web Vitals claims.
- [ ] Capture fictional-user screenshots after login, keyboard/mobile results,
  redacted request IDs and test summaries. Scan evidence for credential/token patterns
  and manually inspect screenshots before adding explicit files. Record failures
  honestly. If any required check remains failed or incomplete, proceed to cleanup
  but do not label the portfolio verified; a later deploy cycle must finish the check.
- [ ] Commit sanitized evidence: `docs: record verified AWS portal behavior` only when
  all required checks passed; otherwise use `docs: record AWS verification findings`.
  Do not run new unrelated work while the disposable environment is still active.

## Task 18: Destroy, verify removal, and finish the GitHub portfolio

**Files:** Create `README.md`, `docs/architecture/{overview,decisions}.md`,
`docs/evidence/cleanup.md`; update deploy/destroy/testing runbooks and evidence index.

**Interfaces:** Consume DeploymentManifest and Task 16 cleanup/verification functions.
Produce a README runnable from a fresh checkout, final sanitized resource inventory,
and a GitHub repository link at the approved destination.

- [ ] Save cloud diagnostics and screenshot/test evidence before deletion. Run the
  cleanup dry-run, check each target against account/region/project inventory, then
  invoke the destroy workflow or equivalent local cleanup for the app stack. Wait for
  deletion completion and inspect failed-delete events rather than repeatedly issuing
  destructive commands without diagnosis.
- [ ] Run `pnpm demo:verify-cleanup` and inspect active/scheduled/shared results.
  Resolve project-owned leftovers with narrowly targeted deletes, then verify again
  only where new actions require it. Do not delete unrelated snapshots, buckets,
  user pools, networks or secrets merely because they share a region.
- [ ] From local authenticated AWS access remove project-exclusive delivery stack,
  bootstrap asset versions/ECR images/toolkit stack and recorded retained resources.
  Preserve shared provider/bootstrap resources and identify them in cleanup evidence.
  Run inventory verification again; report scheduled deletion separately from full
  physical removal. A zero active-owned-resource result is immediate cleanup evidence;
  delayed cost reporting is not evidence of an active resource by itself.
- [ ] Stop only the project's Docker services and volumes with
  `docker compose down --volumes`; remove ignored local credential/session files via
  explicit paths from the run manifest. Keep source and sanitized evidence.
- [ ] Write README with purpose, stack, architecture, local startup, required accounts,
  current runtime versions, deploy/migrate/verify/destroy commands, tests, limitations,
  evidence links and teardown status. Include a small repository Mermaid diagram of
  frontend/auth/API/data flow and explain the two-pass deployment, SQL constraints,
  temporary proxy bootstrap credential and final least-privilege state.
- [ ] Verify documented local commands from a clean checkout using lockfile install,
  migrations, build and the relevant tests. Do not redeploy just to check documentation
  if those cloud commands already have recorded successful evidence and are unchanged.
  Run `git diff --check`, inspect the staged files for sensitive data, and commit
  `docs: publish reproducible portal setup and teardown evidence`.
- [ ] Push the final commits to the approved GitHub destination. Confirm remote HEAD
  matches the intended local commit and checks pass. Share the repository and evidence
  links, noting that the demo resources were destroyed and any shared/scheduled
  resources explicitly accounted for. No completion claim if required verification
  or owned-resource cleanup remains unresolved.

## Spec coverage and checkpoints

| Approved requirement | Implementing tasks | Evidence |
| --- | --- | --- |
| Scope and 30-minute appointment rules | 1–5, 9–10 | Contract, SQL and service tests |
| Frontend stack and monorepo boundaries | 1, 6–10 | Typecheck, build, bundle guard |
| Cognito registration, identity and roles | 3, 6, 8, 12, 14, 17 | Real login and manual registration |
| Server-side ownership and safe errors | 3–6, 17 | Negative API tests |
| Atomic booking and cancellation history | 2, 4–5, 17 | PostgreSQL and deployed races |
| Timezones and DST rejection | 4, 10, 15 | Fixed DST fixtures and browser UI |
| Private RDS, proxy, TLS and migrations | 11, 13–14 | CDK assertions and deployed connectivity |
| CloudFront routing and static hosting | 13, 16–17 | Refresh, header, S3 and cache checks |
| Accessibility and performance | 9–10, 15, 17 | Keyboard, axe, mobile and measured results |
| CI/CD, OIDC and logs/metrics | 6, 13, 15–17 | Workflow results and CloudWatch evidence |
| Deploy, verify, destroy and GitHub deliverable | 16–18 | Manifest, cleanup report, remote commit |

Checkpoints: after Task 7 the local backend works; after Task 10 the local portal
works; after Task 16 cloud deployment tooling is tested without cloud creation;
Tasks 17–18 are one short-lived deploy/verify/cleanup cycle. Use meaningful progress
updates at these boundaries; they are not requests to reapprove the agreed design.

## Plan self-review

Before handoff verify requirement coverage above, scan for incomplete instructions,
check function/type names across tasks, and inspect deployment lifecycle dependencies.
During execution keep checkboxes accurate; examples in this plan are planned tests,
not passing results. Runtime inputs in Task 17 are deliberately collected before
external actions, not guessed during planning.

## Primary references for implementation

- [Lambda Node.js runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [RDS Proxy engine/region support](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RDS_Fea_Regions_DB-eng.Feature.RDSProxy.html)
- [CDK PostgreSQL versions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.PostgresEngineVersion.html)
- [Cognito managed login versions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.ManagedLoginVersion.html)
- [Cognito branding resource](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cognito.CfnManagedLoginBranding.html)
- [CloudFront S3 origin access control](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront_origins.S3BucketOrigin.html)
- [CDK bootstrap options](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html)
- [Temporal timezone conversion](https://tc39.es/proposal-temporal/docs/plaindatetime.html)
- The approved spec's reference list for API Gateway, Cognito PKCE, GitHub OIDC,
  PostgreSQL range constraints and AWS removal behavior.
