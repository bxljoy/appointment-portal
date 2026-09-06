# Private schema and controlled demo identities

This setup code is implemented and tested offline. Actual AWS execution belongs to
the later deployment verification step; no environment was created by Task 14.

The migration Lambda has no HTTP route or function URL. An authorized deployment
runner invokes its `MigrationFunctionName` output with exactly `{ "action": "migrate" }`
or `{ "action": "seed", "users": [...], "now": "2030-06-01T09:00:00Z" }`. A seed user
has a real Cognito `sub`, fictional `displayName`, `patient` or `clinician` role, and
optionally a valid IANA `timezone`. Unknown fields, invalid timestamps, duplicate
subjects, and batches outside 1–20 users are rejected before secret access.

The function uses the administrator secret through direct private RDS with the
bundled public RDS CA and certificate verification. It reads the application secret
only during migration, only to install `portal_app`'s password. One connection holds
the migration advisory lock, schema ledger, pending SQL and role grants in one
transaction. Any failed SQL or grant rolls back the entire batch, including password
and privilege changes. API functions retain application-secret-only IAM and can
reach the proxy, with no direct RDS network access.

`portal_app` is a login without superuser, database creation, role creation,
replication, or RLS bypass privileges. It receives CONNECT and schema USAGE,
SELECT on the four application tables, and only these write columns:

| Table | INSERT | UPDATE |
| --- | --- | --- |
| users | cognito_sub, display_name | none |
| clinician_profiles | none | none |
| availability_slots | clinician_id, start_at, end_at | status |
| appointments | slot_id, patient_id, status | status, cancelled_at, cancelled_by |

Provisioning grants no DELETE, schema ledger access, or future-object privileges.
It revokes database CREATE and TEMPORARY from both PUBLIC and `portal_app` before
granting CONNECT. Revoking schema CREATE alone would still allow temporary tables
through PostgreSQL's [default PUBLIC TEMPORARY grant](https://www.postgresql.org/docs/17/ddl-priv.html). It also removes PUBLIC's
CREATE on `public`, and revokes existing direct and PUBLIC table, column, and
sequence grants before applying the allowlist. UUID defaults require no sequences.
Roles in application rows remain enforced by the services.

This setup assumes a **fresh, disposable, dedicated portal database** owned by the
migration administrator. The same administrator owns every migrated object in
`public`; tests assert the known four application tables plus the migration ledger,
no sequences, and no custom table/sequence default privileges on a fresh database.
Retries reconcile existing table and sequence privileges throughout that dedicated
schema, including the ledger. PostgreSQL's table revocations also remove the
corresponding column grants; setup explicitly resets the known application columns.
Do not reuse this procedure for a shared database or schema.

Setup also revokes PUBLIC table and sequence defaults for the current migration
owner, both globally within this database and specifically in `public`. PostgreSQL
adds schema defaults to global defaults, so a schema-only revocation cannot undo a
global grant ([ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html)). These statements need no superuser privilege and run in the same
locked transaction as migrations and the other grants. New tables or sequences
require an explicit privilege review; setup gives `portal_app` no blanket default
DML. The fresh-database assumption excludes pre-existing custom defaults granting
directly to `portal_app`. Defaults belonging to other object-creating roles, other
schemas' specific defaults, other databases, and subsequent external administrator
changes are outside this setup's reconciliation scope.

Creation sets the safe role flags explicitly. Retries refuse an unexpectedly
privileged role or role membership, then update only attributes an RDS administrator
may change: RDS administrators are not PostgreSQL SUPERUSERs, and even an explicit
`ALTER ROLE ... NOSUPERUSER` would require that privilege.

For the later authorized deployment, create a local JSON configuration with exactly
the fields below, using actual stack outputs and **email addresses you control**.
Names must be fictional; email addresses must be canonical lowercase. Do not put
passwords or tokens in this configuration, shell arguments, or environment variables.
Set `now` to the actual setup time as an offset-qualified timestamp, then keep that
same value for all retries so that the seeded slot times remain stable.

```json
{
  "userPoolId": "eu-north-1_ReplaceWithOutput",
  "migrationFunctionName": "ReplaceWithMigrationFunctionNameOutput",
  "now": "2030-06-01T09:00:00Z",
  "accounts": [
    { "email": "controlled-clinician@example.com", "displayName": "Casey Clinician", "role": "clinician" },
    { "email": "controlled-patient@example.com", "displayName": "Alice Patient", "role": "patient" }
  ]
}
```

After the bootstrap deployment, the command is `pnpm db:setup:aws path/to/setup.json`
under the pinned Node 24 / pnpm 11.22 environment and the intended AWS region/profile.
It migrates first, provisions all identities, then seeds only the subjects returned
by Cognito. A synchronous Lambda invocation must return status 200, no FunctionError,
valid JSON, and the exact `{ok:true,appliedMigrations:[...]}` shape. A transport 200 by
itself is insufficient. The ready deployment switches the proxy to the application
credential after setup succeeds.

These are **pre-confirmed demo test accounts**, created with `AdminCreateUser`,
`MessageAction=SUPPRESS`, a controlled verified email and no alias transfer. The
runner queries `AdminGetUser.UserAttributes` for `sub`, verifies the email and its
verification status, and calls `AdminSetUserPassword` with `Permanent=true`. It never
guesses the subject from email or Cognito's generated username. Existing verified
accounts in this explicit controlled list are intentionally reused and have the
stored demo password applied. Do not include someone else's account or the account
reserved for the separate manual self-registration/email-verification journey.

Passwords are generated in memory. Before any remote mutation, each is saved to an
atomically replaced, fsynced mode-0600 JSON file in the ignored mode-0700 `.runtime/`
directory, keyed by pool ID and an email hash. The file includes the email, role,
display name, password and, after provisioning, the verified Cognito subject for
browser tests. Symlinked or publicly readable credential files are refused. Treat
these files as secrets, keep them local, and remove them after browser verification.
No raw AWS errors, secret contents or account payloads are printed. Do not upload
`.runtime/`, test sessions, or token-bearing traces as CI artifacts.

Use one setup runner at a time. If Cognito creation, permanent-password assignment,
or seeding fails, rerun the same configuration with `.runtime/` intact: the runner
reuses the stored password and verified subject, and database upserts preserve an
existing clinician role. It does not delete accounts as compensation. Invalid
identity attributes or a changed stored subject stop the run before a password is
assigned. Investigate those failures instead of deleting the credential record.

The migration artifact includes SQL, the public CA and its AWS SDK. The pinned
`pg-format@1.0.4` patch changes only a dynamic reserved-word-table require to a static
require, allowing esbuild to include it; `%L` still quotes password literals.
`pnpm build` produces the migration artifact and `pnpm check:bundles` imports it and
verifies its SQL, CA, dependencies and absence of local identities.

Dependency review on 2026-09-06: pnpm's full audit reports the existing Vitest 3.2.4
[UI/API-server advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).
Its affected path is unused: project commands run `vitest run`, with no Vitest UI,
browser mode, or exposed API server, and test tooling is absent from Lambda bundles.
The new setup dependencies have no reported findings. Review and update the test
runner in Task 15, before enabling any test UI/server or by 2026-09-07.

Primary API references: [Cognito AdminCreateUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html),
[AdminGetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html),
[AdminSetUserPassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html),
[Lambda Invoke](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html), and
[PostgreSQL 17 GRANT](https://www.postgresql.org/docs/17/sql-grant.html).
