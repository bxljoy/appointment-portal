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
