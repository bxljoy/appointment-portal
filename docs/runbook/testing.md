# Local browser journeys and pull request checks

Use Node **24.0.1** from `.nvmrc` and **pnpm 11.22.0** throughout. From a fresh
checkout, start the PostgreSQL 17 container and build the contracts before running
tests: other workspace packages resolve its generated exports.

```sh
nvm use
corepack pnpm@11.22.0 install --frozen-lockfile --ignore-scripts
docker compose up -d postgres
corepack pnpm@11.22.0 --filter @portal/contracts build
corepack pnpm@11.22.0 exec playwright install chromium
corepack pnpm@11.22.0 exec playwright test --project=local-desktop --project=local-mobile
```

The default `DATABASE_URL` is the Compose endpoint. An override must point to a
loopback PostgreSQL administrator connection with permission to create databases.
Only `postgres:`/`postgresql:` URLs with an explicit user/database, a normal port,
and host `127.0.0.1`, `localhost` or `[::1]` are accepted. Query parameters, fragments,
encoded/socket hosts and remote hosts are rejected before constructing a pool.
Both pools receive explicit validated fields; no connection string is reparsed by
`pg`, and an empty password cannot inherit an unrelated `PGPASSWORD`. Startup
settings pin the public search path, replication off, UTF-8 and the application
name `portal-e2e`; query results use text mode. These settings override inherited
`PGOPTIONS`, `PGREPLICATION`, `PGCLIENT_ENCODING`, `PGAPPNAME` and connection defaults
without changing the caller's environment. Empty/false startup options are insufficient
for several fields in the pinned `pg` release because its parser uses truthy fallbacks.
The browser fixture creates a new `portal_e2e_<random UUID>` database for each
worker, applies the real migrations, and resets only that database between tests.
It seeds Alice Patient, Bea Patient, Casey Clinician and Devon Clinician, with two
30-minute slots per clinician at a fixed UTC hour seven days ahead. The anchor is
captured once per worker; browsers and the API use real current time.

One worker runs at a time. The explicit race creates two independent HTTP clients
for the two patients and a dedicated additional slot, requiring one 201, one 409,
one visible authorized booking and exactly one active database row. It does not
share that slot with other journeys. All browser API calls use real HTTP and
PostgreSQL; there are no route mocks.

Each worker owns an API listener and a Vite child process on ephemeral loopback
ports. The development-only proxy accepts `PORTAL_LOCAL_API_URL` so these listeners
can coexist with the usual development ports. Readiness checks validate Vite's
local config; output parsing handles ANSI colors and split chunks. Normal failure
and completion close Vite, the API and its pool, then drop the owned database.
Startup failures take the same cleanup path. Vite shutdown escalates from TERM to
KILL after five seconds. A machine crash or an interrupted/killed worker during
startup can leave an isolated database: inspect its name and connections before removing
it; never use a wildcard cleanup against a development database.

`local-desktop` uses 1280×900, and `local-mobile` uses 390×844 with mobile/touch
emulation. Both cover browsing, booking, patient cancellation/history/rebooking,
publication/withdrawal, clinician cancel-and-withdraw, keyboard radio selection,
dialog focus trapping/dismissal/confirmation, focus return, invalid form focus and
associated live errors, and a real stale-slot conflict. Axe checks WCAG A/AA tags
and rejects serious/critical violations. Additional browser assertions check page
width and at least 3:1 control-border contrast. See the
[Playwright accessibility guide](https://playwright.dev/docs/accessibility-testing)
for the limits of automated checks.

Local screenshots and failed-run traces live under ignored `test-results/`.
Reports, `.auth/`, `traces/`, `storage-state/` and `.runtime/` are also ignored.
Do not publish those directories. Screenshots use only the local fictional data.

## Complete local checks

After the setup above:

Run the full suite and local Playwright sequentially: the Playwright runner cleans
`test-results/`, which also holds private synthetic-regression fixtures.

```sh
corepack pnpm@11.22.0 lint
corepack pnpm@11.22.0 typecheck
corepack pnpm@11.22.0 test
corepack pnpm@11.22.0 build
corepack pnpm@11.22.0 --filter @portal/api build:lambdas
corepack pnpm@11.22.0 check:infra
corepack pnpm@11.22.0 check:bundles
corepack pnpm@11.22.0 check:artifacts
corepack pnpm@11.22.0 audit --audit-level=high
corepack pnpm@11.22.0 test:e2e
```

`check:infra` runs the actual CDK CLI for bootstrap and ready with fictional account
111111111111, cached eu-north-1 AZs and PostgreSQL 17.6. It strips inherited AWS/CDK
environment settings, disables credential files/metadata, forbids lookups and
rejects missing context. It writes `infra/cdk.out/{bootstrap,ready}` without
altering a developer's context file. No AWS service is used.

`check:bundles` verifies handler exports, complete SDK dependencies, migration SQL,
public database CA and exclusion of local/test imports. `check:artifacts` scans
only deployable frontend/Lambda outputs and both synthesized assemblies for local
authentication and known test credential sentinels. It also rejects secret literals
in generated JSON and sensitive runtime paths tracked by Git. Documentation and
source examples are outside its content scan. Negative fixtures intentionally
contaminate temporary outputs; missing builds and symlinks fail closed. The checkout
root is canonicalized; every component below it is checked before traversal/read,
including ancestors such as `apps/web`. Opened files are checked again before
their contents are read. Root `reports/`, Playwright report/results/error-context
directories and storage directories cannot be tracked; Markdown documentation
examples remain exempt. Run the guard in a checkout without concurrent writers. The guard
is targeted leak prevention, not a claim to detect every possible secret.

The GitHub `Checks / quality` job runs on PR and push with `contents: read`, no
persisted checkout credentials and no cloud/production secrets. Its PostgreSQL 17
service is an ephemeral, loopback-published test database using local trust auth.
Installation freezes the lockfile and disables dependency scripts. Chromium is
installed before the full suite, which includes a synthetic local failed-login
regression against Playwright's actual artifact recorder. No reports,
credentials or traces are uploaded. Repository branch protection can require the
check when repository administration is configured; creating this workflow does
not itself enable branch protection.

Action revisions were verified through each official repository's release and Git
ref APIs on 2026-09-06; the pnpm annotated tag was dereferenced to its commit:

| Action | Release | Commit |
| --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0) | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| [pnpm/action-setup](https://github.com/pnpm/action-setup/releases/tag/v6.1.0) | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` |

Workflow YAML and quality-gate policy tests run in Vitest. Syntax and semantics
were also checked locally with checksum-verified actionlint 1.7.12. No GitHub run
or push is implied by local validation.

## Opt-in managed login

The `aws` project is disabled unless `PORTAL_E2E_AWS=1`; it never starts the local
adapter or resets a database. Task 15 supplies four managed-login/logout smoke
tests. Full deployed acceptance, self-registration/email verification, authorization
and deployed race evidence belong to the deployment verification run.

After separately authorized provisioning, set `PORTAL_E2E_AWS_URL` to the deployed
HTTPS origin and these environment variables to the corresponding credential file
paths produced by the [provisioning runner](provisioning.md):

- `PORTAL_E2E_PATIENT_A_FILE`
- `PORTAL_E2E_PATIENT_B_FILE`
- `PORTAL_E2E_CLINICIAN_A_FILE`
- `PORTAL_E2E_CLINICIAN_B_FILE`

Keep files in the ignored mode-0700 `.runtime/` directory with mode 0600. The helper
requires a regular owned file, no symlink/hardlink, a valid verified Cognito subject
and the expected role. Paths are configuration; passwords are read into memory
from those files, never from source, command arguments or password environment
variables. `signIn(page, account)` accepts only the four exact aliases above. Local
projects use the development selector; `aws` requires Cognito runtime config and
submits the controlled credentials only at the configured Cognito managed-login
origin. The managed-login selectors must be verified against the actual deployment.

```sh
PORTAL_E2E_AWS=1 corepack pnpm@11.22.0 exec playwright test --project=aws
```

AWS traces, videos, screenshots, HARs and saved storage state are prohibited by the
automatic fixture before credentials can be entered. Only the list reporter is
accepted: HTML/JSON/blob reports can include successful credential-fill step values.
When AWS is enabled, config evaluation rejects `--debug` (including both CLI and
Inspector modes), `--ui`, `--ui-host` and `--ui-port` before browser workers or
interactive runners start. Both `--option=value` and `--option value` spellings
are checked. The same boundary rejects any nonempty `DEBUG`, `DEBUG_FILE`, `PWDEBUG`
(including `npm_config_pwdebug` and `npm_package_config_pwdebug`), `PWPAUSE`,
`PWTEST_WATCH`, Playwright implementation/runner/reporter debug switches, injected
`PW_TEST_REPORTER`, dashboard/controller debugging and module instrumentation.
The automatic fixture repeats this check before credentials can be entered.
Local-only interactive runs remain available when AWS is disabled. The hidden
`test-server` and `run-test-mcp-server` commands are also rejected when they load
this config; their server startup can precede lazy config loading.
Protocol logging can expose raw password input even when ordinary artifacts are off;
diagnostics must be disabled before controlled credentials are entered.
Config evaluation sets Playwright's `PLAYWRIGHT_NO_COPY_PROMPT=1` opt-out before
workers start whenever AWS is enabled. In pinned Playwright 1.63 this disables the
automatic failure-page ARIA snapshot independently of trace/video/screenshots;
generic `error-context.md` diagnostics can still exist. The fixture also checks that
the opt-out remains enabled. Authentication failures use a generic error.

The full suite runs a runtime-generated synthetic password through a real loopback
HTTP login that returns 401, deliberately fails after submission, scans the actual
failure outputs, and deletes the temporary data even on failure. Additional runs
prove that JSON/environment reporter overrides, protocol debug logging, a debug file,
and combined protocol/file logging fail before credential submission, with no password
in stdout/stderr or any generated file. The subprocess matrix also covers CLI debug
with both spellings, all three UI entry points, pause and watch. These runs must
reject during config import and exit without a timeout. UI regression subprocesses
use the installed runner's `PWTEST_UNDER_TEST=1` switch to keep UI Chromium headless
and avoid opening a desktop browser; the runner/config path remains real. An eight
second deadline interrupts interactive cases, followed by owned process-group
cleanup after three seconds. Output scans wait for the subprocess streams to close.
Public config-import tests cover the Inspector variants, hidden server commands and
environment aliases without starting a headed Inspector or attaching an external
client. No real account or AWS endpoint is used.
These executable regressions must pass on any Playwright
upgrade, because the opt-out is an upstream environment switch rather than a typed
public configuration option. The deployed AWS smoke project remains unexecuted.

## Dependency and manual accessibility review

The deferred [Vitest advisory GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
is fixed by the pinned Vitest 3.2.6. The advisory lists 3.2.5 as patched, but npm
marks that release corrupted and it requests an unavailable vite-node version.
[3.2.6](https://github.com/vitest-dev/vitest/releases/tag/v3.2.6) is the smallest
installable patch; its declared Node range includes Node 24 and its jsdom peer
accepts the retained jsdom 26.1.0. Vite 8's esbuild 0.28.2 peer is now explicitly
pinned in the web manifest, keeping the API's esbuild 0.25.12 separate.

Manual local review on 2026-09-06 used Chromium 153.0.8010.12 with Playwright 1.63.0,
axe 4.13.0 and both required widths. The screenshots show readable wrapping,
visible form labels/timezones, single-column mobile slots, two-column desktop
slots, fitting cancellation dialogs, visible keyboard focus and history-heading
focus after cancellation. Field-border contrast initially measured 1.30–1.39:1;
the dedicated darker control token raises the field-border ratio to 3.32:1 without
darkening decorative dividers. Body text measured 11.97:1, primary action text
9.49:1, error text 7.23:1 and the focus outline 5.50:1 against white. The full pnpm
audit reports zero findings at every severity. Browser assertions enforce control contrast and the required focus
journeys. These local checks do not replace assistive-technology testing or full
WCAG conformance assessment.
