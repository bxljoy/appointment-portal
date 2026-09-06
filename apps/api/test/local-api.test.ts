import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

import { seedScenario, withTestDb } from '../../../packages/database/test/harness.js';
import { startLocalServer } from '../src/local/server.js';

const originalLocalAuth = process.env.PORTAL_LOCAL_AUTH;
const originalNodeEnv = process.env.NODE_ENV;

const restoreEnvironment = (): void => {
  if (originalLocalAuth === undefined) delete process.env.PORTAL_LOCAL_AUTH;
  else process.env.PORTAL_LOCAL_AUTH = originalLocalAuth;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
};

const withLocalServer = async (
  run: (context: Awaited<ReturnType<typeof seedScenario>> & {
    baseUrl: string;
    close: () => Promise<void>;
    pool: Parameters<typeof seedScenario>[0];
  }) => Promise<void>,
): Promise<void> => {
  await withTestDb(async (pool) => {
    const fixture = await seedScenario(pool);
    const endPool = pool.end.bind(pool);
    let poolEndPromise: Promise<void> | undefined;
    pool.end = vi.fn(() => {
      poolEndPromise ??= endPool();
      return poolEndPromise;
    });
    const server = await startLocalServer({ pool, port: 0 });
    try {
      await run({ ...fixture, baseUrl: server.baseUrl, close: server.close, pool });
    } finally {
      await server.close();
    }
  });
};

describe('local API', () => {
  beforeEach(() => {
    process.env.PORTAL_LOCAL_AUTH = '1';
    process.env.NODE_ENV = 'test';
  });

  afterEach(restoreEnvironment);

  it('books as patient-a without exposing the appointment to patient-b', async () => {
    await withLocalServer(async ({ baseUrl, slot }) => {
      const booking = await fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Local-Actor': 'patient-a',
        },
        body: JSON.stringify({ slotId: slot.id }),
      });

      expect(booking.status).toBe(201);

      const listing = await fetch(`${baseUrl}/api/appointments?limit=10`, {
        headers: { 'X-Local-Actor': 'patient-b' },
      });
      expect(listing.status).toBe(200);
      await expect(listing.json()).resolves.toMatchObject({ items: [] });
    });
  });

  it('rejects missing and unrecognized local identities', async () => {
    await withLocalServer(async ({ baseUrl }) => {
      const missing = await fetch(`${baseUrl}/api/me`);
      const bogus = await fetch(`${baseUrl}/api/me`, {
        headers: { 'X-Local-Actor': 'administrator' },
      });

      expect(missing.status).toBe(401);
      await expect(missing.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(bogus.status).toBe(401);
      await expect(bogus.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });
  });

  it('rejects inherited property names as local identities', async () => {
    await withLocalServer(async ({ baseUrl }) => {
      for (const value of ['constructor', 'toString', '__proto__']) {
        const response = await fetch(`${baseUrl}/api/me`, {
          headers: { 'X-Local-Actor': value },
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
        });
      }
    });
  });

  it('accepts each fixed local identity', async () => {
    await withLocalServer(async ({ baseUrl }) => {
      const responses = await Promise.all(
        ['patient-a', 'patient-b', 'clinician-a', 'clinician-b'].map((value) => fetch(`${baseUrl}/api/me`, {
          headers: { 'X-Local-Actor': value },
        })),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    });
  });

  it('keeps a matched profile resource-not-found response intact', async () => {
    await withLocalServer(async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/api/clinicians/00000000-0000-4000-8000-000000000000`,
        { headers: { 'X-Local-Actor': 'patient-a' } },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'NOT_FOUND', message: 'Clinician not found.' },
      });
    });
  });

  it('enforces the 16 KiB body limit before route parsing', async () => {
    await withLocalServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Local-Actor': 'patient-a',
        },
        body: 'x'.repeat(16 * 1024 + 1),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });
  });

  it('closes both the listening socket and database pool', async () => {
    await withLocalServer(async ({ baseUrl, close, pool }) => {
      await close();

      expect(pool.end).toHaveBeenCalledOnce();
      await expect(fetch(`${baseUrl}/api/me`)).rejects.toThrow();
    });
  });

  it('refuses startup without the local-auth gate or in production', async () => {
    const pool = new Pool();
    try {
      process.env.PORTAL_LOCAL_AUTH = '0';
      await expect(startLocalServer({ pool, port: 0 })).rejects.toThrow('PORTAL_LOCAL_AUTH=1');

      process.env.PORTAL_LOCAL_AUTH = '1';
      process.env.NODE_ENV = 'production';
      await expect(startLocalServer({ pool, port: 0 })).rejects.toThrow('outside production');
    } finally {
      await pool.end();
    }
  });
});
