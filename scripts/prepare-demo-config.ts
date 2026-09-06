import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  AWS_ACCOUNT_ID: z.string().regex(/^\d{12}$/), AWS_REGION: z.string().min(1), POSTGRES_VERSION: z.string().regex(/^17\.[1-9]\d*$/),
  MAX_COST_USD: z.coerce.number().positive(), DEMO_DURATION_HOURS: z.coerce.number().positive().max(24),
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), GITHUB_REF_NAME: z.string().min(1),
  DEMO_PATIENT_EMAIL: z.email(), DEMO_CLINICIAN_EMAIL: z.email(), PRICE_REPORT_JSON: z.string().min(2),
});
const env = envSchema.parse(process.env);
const runtime = resolve('.runtime');
await mkdir(runtime, { recursive: true, mode: 0o700 });
const accountsFile = resolve(runtime, 'accounts.json');
const priceReport = resolve(runtime, 'prices.json');
await writeFile(accountsFile, `${JSON.stringify([
  { email: env.DEMO_PATIENT_EMAIL.toLowerCase(), displayName: 'Demo Patient', role: 'patient' },
  { email: env.DEMO_CLINICIAN_EMAIL.toLowerCase(), displayName: 'Demo Clinician', role: 'clinician' },
], null, 2)}\n`, { mode: 0o600 });
await writeFile(priceReport, `${JSON.stringify(JSON.parse(env.PRICE_REPORT_JSON), null, 2)}\n`, { mode: 0o600 });
await writeFile(resolve(runtime, 'demo-config.json'), `${JSON.stringify({
  account: env.AWS_ACCOUNT_ID, region: env.AWS_REGION, postgresVersion: env.POSTGRES_VERSION,
  durationHours: env.DEMO_DURATION_HOURS, maxCostUsd: env.MAX_COST_USD,
  repository: env.GITHUB_REPOSITORY, branch: env.GITHUB_REF_NAME, accountsFile, priceReport,
}, null, 2)}\n`, { mode: 0o600 });
