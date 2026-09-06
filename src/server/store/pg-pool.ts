/* Shared connection and transaction lifecycle for the Postgres adapters. */
import { Pool, type PoolClient } from 'pg'
import type { PostgresStoreConfig } from './pg-run-store'

export function createPostgresPool(config: PostgresStoreConfig): Pool {
  const pool = new Pool({
    ...config,
    max: config.max ?? 5,
    // Advisory-lock waiters must get a new snapshot after acquiring the
    // lock; CAS losers must re-evaluate the committed row. Pin the session
    // default for pool.query's implicit transactions as well as explicit
    // ones, independent of role/database/URL isolation defaults. pg awaits
    // onConnect before lending this client (unlike the 'connect' event).
    onConnect: async client => {
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')
    },
  })
  pool.on('error', () => {
    // pg already evicted the failed idle client. A later operation can
    // reconnect; don't crash the process or log connection credentials.
    console.warn('Postgres store idle connection failed; the pool will reconnect.')
  })
  return pool
}

export async function withPostgresTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let connectionError: Error | undefined
  let discard = false
  // A disconnect BETWEEN awaited queries is a client error event, not a
  // query rejection. Keep it handled until release restores pg's listener.
  const onError = (error: Error) => { connectionError = error }
  client.on('error', onError)
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const value = await body(client)
    if (connectionError) throw connectionError
    await client.query('COMMIT')
    return value
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally {
    // A failed rollback cannot prove the session is outside its transaction.
    client.release(discard || connectionError !== undefined)
    client.removeListener('error', onError)
  }
}
