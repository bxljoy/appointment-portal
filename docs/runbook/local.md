# Run the local API

From the repository root, use the Node version recorded in `.nvmrc` and pnpm 11.22.0:

```sh
nvm use
corepack pnpm@11.22.0 --version
```

Load the repository's Compose connection string into the current shell. Keep this
shell open for migration, seed, and API commands below:

```sh
set -a
. ./.env.example
set +a
```

Start the PostgreSQL 17 container, then migrate and seed the local database at the
Compose endpoint `127.0.0.1:54329`:

```sh
docker compose up -d postgres
corepack pnpm@11.22.0 --filter @portal/database migrate
corepack pnpm@11.22.0 --filter @portal/database seed
```

The seed command creates four fictional identities for local-only authentication:

- `patient-a` — Alice Patient
- `patient-b` — Bea Patient
- `clinician-a` — Casey Clinician
- `clinician-b` — Devon Clinician

Start the loopback-only API on port 3001:

```sh
PORTAL_LOCAL_AUTH=1 NODE_ENV=development corepack pnpm@11.22.0 --filter @portal/api dev:local
```

The adapter binds `127.0.0.1` and accepts the identity only from `X-Local-Actor`.
It refuses to start unless `PORTAL_LOCAL_AUTH=1` and `NODE_ENV` is not `production`.
For example:

```sh
curl -i http://127.0.0.1:3001/api/me -H 'X-Local-Actor: patient-a'
```

Stop the process with Ctrl-C. It closes both the HTTP listener and its PostgreSQL pool.

## Run the React portal

With the API still running, start the web app in another terminal using Node 24:

```sh
nvm use
corepack pnpm@11.22.0 --filter @portal/web dev
```

Open `http://127.0.0.1:5173`. Choose a fictional development identity and select
**Sign in**. The selector can also switch identities after sign-in; private queries
and mutations are cleared before the next identity's pages mount. Vite serves local
`/config.json` only in development and proxies `/api` to port 3001.

The deployed app loads `/config.json` before mounting React. Production requires:

```json
{
  "mode": "cognito",
  "apiBaseUrl": "/api",
  "issuer": "https://cognito-idp.eu-north-1.amazonaws.com/USER_POOL_ID",
  "clientId": "PUBLIC_APP_CLIENT_ID",
  "cognitoDomain": "https://DOMAIN.auth.eu-north-1.amazoncognito.com",
  "redirectUri": "https://FRONTEND_DOMAIN/auth/callback",
  "logoutUri": "https://FRONTEND_DOMAIN/signed-out"
}
```

These are public deployment identifiers, with no client secret. The callback and
logout origins must match the frontend. Deployment creates this file from stack
outputs; the development config is never copied into the production build. Tokens
and users stay in memory; only temporary OIDC redirect transaction state uses
sessionStorage. A full reload may require sign-in again. Cognito logout uses its
`/logout?client_id=...&logout_uri=...` endpoint after local session/cache clearing.

Run `corepack pnpm@11.22.0 --filter @portal/web build` for type checking, the Vite
production build, and its local-auth artifact guard. `corepack pnpm@11.22.0 test
apps/web` runs the web tests, including a deliberately contaminated artifact fixture.
The shared UI primitives use the Radix family consistently (button/Slot, Dialog,
and form Label/Slot), with Tailwind semantic color and spacing tokens.
