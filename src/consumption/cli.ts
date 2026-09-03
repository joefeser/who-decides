/* Cross-process claim CLI — used by the race test to prove atomicity between
 * genuinely concurrent OS processes, not just in-process connections. */
import { readFileSync } from 'node:fs'
import { ConsumptionStore, decisionDigest } from './store'
import type { DecisionRecord } from './store'

function main(): void {
  const [dbPath, decisionPath, successorId, expectedDigest] = process.argv.slice(2)
  if (!dbPath || !decisionPath || !successorId) {
    throw new Error('usage: tsx src/consumption/cli.ts <db> <decision.json> <successorInvocationId> [expectedDigest]')
  }
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8')) as DecisionRecord
  const store = new ConsumptionStore(dbPath)
  try {
    const result = store.claim(decision, successorId, expectedDigest)
    console.log(JSON.stringify({ ...result, computedDigest: decisionDigest(decision) }))
    process.exitCode = result.status === 'rejected' ? 2 : 0
  } finally {
    store.close()
  }
}

main()
