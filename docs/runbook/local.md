# Run the local API

Use Node 24.0.1 and pnpm 11.22.0:

```sh
export PATH=/Users/bxl/.nvm/versions/node/v24.0.1/bin:$PATH
corepack pnpm@11.22.0 --version
```

Start the PostgreSQL 17 container, then migrate and seed the local database:

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
