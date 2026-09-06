/* Store selection by config: WD_STORE=sqlite (default, zero-config local
 * demo) | postgres (hosted demo; connection from WD_PG_URL / DATABASE_URL /
 * WD_PG_* — see pg-run-store.ts). The only wiring point: the engine's
 * default stores when a caller does not inject any. Engine logic never
 * branches on the backend; both adapters satisfy the same async seams. */
import path from 'node:path'
import type { RunStore } from './store'
import type { ReceiptStore } from './sqlite-receipt-store'
import { SqliteRunStore } from './sqlite-run-store'
import { SqliteReceiptStore } from './sqlite-receipt-store'
import { PostgresRunStore } from './pg-run-store'
import { PostgresReceiptStore } from './pg-receipt-store'

export type ConsoleStores = { runs: RunStore, receipts: ReceiptStore }

export function createDefaultStores(dir: string): ConsoleStores {
  const backend = (process.env.WD_STORE ?? 'sqlite').toLowerCase()
  if (backend === 'postgres') {
    // Consumption receipts live in the SAME Postgres database as the runs
    // (the SQLite adapter's separate consumption.db file is a local-demo
    // artifact, not a seam requirement).
    return {
      runs: new PostgresRunStore(),
      receipts: new PostgresReceiptStore(),
    }
  }
  if (backend !== 'sqlite') {
    throw new Error(`WD_STORE must be "sqlite" or "postgres", got "${process.env.WD_STORE}"`)
  }
  return {
    runs: new SqliteRunStore(dir),
    receipts: new SqliteReceiptStore(path.join(dir, 'consumption.db')),
  }
}
