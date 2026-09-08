import { resolve } from 'node:path';
import { z } from 'zod';
import { writePrivateJson } from './private-file.js';
import { deploymentExpiry } from './expiry.js';

const envSchema = z.object({
  AWS_ACCOUNT_ID: z.string().regex(/^\d{12}$/), AWS_REGION: z.string().min(1), POSTGRES_VERSION: z.string().regex(/^17\.[1-9]\d*$/),
  MAX_COST_USD: z.coerce.number().positive(), DEMO_DURATION_HOURS: z.coerce.number().positive().max(6),
  LAMBDA_CONCURRENCY_MODE: z.enum(['reserved', 'shared-unreserved']).default('reserved'),
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), GITHUB_REF_NAME: z.string().min(1),
  DEMO_REPOSITORY_OWNER_ID: z.string().regex(/^[1-9]\d{0,19}$/), DEMO_REPOSITORY_ID: z.string().regex(/^[1-9]\d{0,19}$/),
  GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/), PRICE_REPORT_JSON: z.string().min(2),
  DEMO_PATIENT_A_EMAIL: z.email(), DEMO_PATIENT_B_EMAIL: z.email(), DEMO_CLINICIAN_A_EMAIL: z.email(), DEMO_CLINICIAN_B_EMAIL: z.email(),
});
const env = envSchema.parse(process.env);
const runtime = resolve('.runtime');
const accountsFile = resolve(runtime, 'accounts.json');
const priceReport = resolve(runtime, 'prices.json');
const { createdAt, expiresAt } = deploymentExpiry(new Date(), env.DEMO_DURATION_HOURS);
await writePrivateJson(accountsFile, [
  { alias: 'patient-a', email: env.DEMO_PATIENT_A_EMAIL.toLowerCase(), displayName: 'Alice Patient', role: 'patient' },
  { alias: 'patient-b', email: env.DEMO_PATIENT_B_EMAIL.toLowerCase(), displayName: 'Bea Patient', role: 'patient' },
  { alias: 'clinician-a', email: env.DEMO_CLINICIAN_A_EMAIL.toLowerCase(), displayName: 'Casey Clinician', role: 'clinician' },
  { alias: 'clinician-b', email: env.DEMO_CLINICIAN_B_EMAIL.toLowerCase(), displayName: 'Devon Clinician', role: 'clinician' },
]);
await writePrivateJson(priceReport, JSON.parse(env.PRICE_REPORT_JSON));
await writePrivateJson(resolve(runtime, 'demo-config.json'), {
  account: env.AWS_ACCOUNT_ID, region: env.AWS_REGION, postgresVersion: env.POSTGRES_VERSION,
  durationHours: env.DEMO_DURATION_HOURS, maxCostUsd: env.MAX_COST_USD,
  lambdaConcurrencyMode: env.LAMBDA_CONCURRENCY_MODE,
  createdAt, expiresAt,
  repository: env.GITHUB_REPOSITORY, repositoryOwnerId: env.DEMO_REPOSITORY_OWNER_ID,
  repositoryId: env.DEMO_REPOSITORY_ID, branch: env.GITHUB_REF_NAME, sourceCommit: env.GITHUB_SHA, accountsFile, priceReport,
});
