// Local fixture identities are deliberately outside the migration Lambda import graph.
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool, fileURLToPath(new URL('../migrations', import.meta.url)));
  await seedDemo(pool, [
    { sub: 'patient-a', displayName: 'Alice Patient', role: 'patient' },
    { sub: 'patient-b', displayName: 'Bea Patient', role: 'patient' },
    { sub: 'clinician-a', displayName: 'Casey Clinician', role: 'clinician' },
    { sub: 'clinician-b', displayName: 'Devon Clinician', role: 'clinician' },
  ], new Date());
} finally { await pool.end(); }
