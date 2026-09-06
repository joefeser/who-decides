/* Store selection by config: WD_STORE=sqlite (default, zero-config local
 * demo) | postgres (hosted demo; connection from WD_PG_URL / DATABASE_URL /
 * WD_PG_* — see pg-run-store.ts). The only wiring point: the engine's
 * default stores when a caller does not inject any. Engine logic never
 * branches on the backend; both adapters satisfy the same async seams.
 *
 * Each default is a separate constructor so partial injection (one store
 * supplied, the other defaulted) never builds an unused adapter that close()
 * could not reach. */
import path from 'node:path'
import type { RunStore } from './store'
import type { ReceiptStore } from './sqlite-receipt-store'
import { SqliteRunStore } from './sqlite-run-store'
import { SqliteReceiptStore } from './sqlite-receipt-store'
import { PostgresRunStore } from './pg-run-store'
import { PostgresReceiptStore } from './pg-receipt-store'

export type ConsoleStores = { runs: RunStore, receipts: ReceiptStore }

function postgresEnabled(): boolean {
  const backend = (process.env.WD_STORE ?? 'sqlite').toLowerCase()
  if (backend !== 'sqlite' && backend !== 'postgres') {
    throw new Error(`WD_STORE must be "sqlite" or "postgres", got "${process.env.WD_STORE}"`)
  }
  return backend === 'postgres'
}

export function createDefaultRunStore(dir: string): RunStore {
  if (postgresEnabled()) return new PostgresRunStore()
  return new SqliteRunStore(dir)
}

export function createDefaultReceiptStore(dir: string): ReceiptStore {
  if (postgresEnabled()) return new PostgresReceiptStore()
  // Consumption receipts live beside the run store (the SQLite adapter's
  // separate consumption.db file is a local-demo artifact, not a seam
  // requirement — the Postgres adapters share one database).
  return new SqliteReceiptStore(path.join(dir, 'consumption.db'))
}

export function createDefaultStores(dir: string): ConsoleStores {
  return {
    runs: createDefaultRunStore(dir),
    receipts: createDefaultReceiptStore(dir),
  }
}
