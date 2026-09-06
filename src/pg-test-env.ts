/* Shared setup for the WD_TEST_PG_URL-gated Postgres suites.
 * When the variable is unset the suites register a single skipped test and
 * exit green (mirrors how live tests skip without a provider), so the
 * default `npm test` path never needs a Postgres server. */
import { test } from 'node:test'
import type { PostgresStoreConfig } from './server/store/pg-run-store'

export const WD_TEST_PG_URL = process.env.WD_TEST_PG_URL

/** Register one visibly skipped test when the gate is closed. */
export function skipWhenNoPostgres(suiteName: string): boolean {
  if (WD_TEST_PG_URL) return true
  test(`${suiteName} (skipped: WD_TEST_PG_URL is not set)`, { skip: true }, () => {})
  return false
}

export function pgConfig(max = 5): PostgresStoreConfig {
  return { connectionString: WD_TEST_PG_URL, max }
}

/** Raw helper for test-side row probes (the pg counterpart of the sqlite
 * suite's direct better-sqlite3 access). */
export async function pgQuery(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: WD_TEST_PG_URL })
  try {
    return await pool.query(sql, values)
  } finally {
    await pool.end()
  }
}
