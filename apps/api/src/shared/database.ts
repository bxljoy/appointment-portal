import type { Pool, PoolClient } from 'pg';

export const inTransaction = async <T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
};
