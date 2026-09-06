import { existsSync } from 'node:fs'
import { ConsumptionStore } from '../src/consumption/store'
import { LocalOwnerVerifier } from '../src/local-owner/verifier'

const waitForRelease = (releasePath: string) => {
  const deadline = process.hrtime.bigint() + 10_000_000_000n
  while (!existsSync(releasePath)) {
    if (process.hrtime.bigint() >= deadline) throw Error('race barrier timed out')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

const mode = process.env.PROOF_RACE_MODE!
const config = JSON.parse(process.env.PROOF_RACE_CONFIG!)
const releasePath = process.env.PROOF_RACE_RELEASE ?? ''
let worker: ConsumptionStore | LocalOwnerVerifier
if (mode === 'legacy') {
  worker = new ConsumptionStore(config.dbPath, {
    admission: config.storeAdmission,
    writer: config.writer,
    test: {
      beforeBeginImmediate: () => process.send?.({ kind: 'beforeBeginImmediate', pid: process.pid, monotonicNanoseconds: process.hrtime.bigint().toString() }),
      afterBeginImmediate: releasePath ? () => {
        process.send?.({ kind: 'writeLockHeld', pid: process.pid, monotonicNanoseconds: process.hrtime.bigint().toString() })
        waitForRelease(releasePath)
      } : undefined,
    },
  })
} else {
  config.test = {
    ...config.test,
    beforeDecisionBeginImmediate: () => process.send?.({ kind: 'beforeBeginImmediate', pid: process.pid, monotonicNanoseconds: process.hrtime.bigint().toString() }),
    ...(releasePath ? { clock: () => {
      process.send?.({ kind: 'writeLockHeld', pid: process.pid, monotonicNanoseconds: process.hrtime.bigint().toString() })
      waitForRelease(releasePath)
      return { wallTime: new Date().toISOString(), monotonicNanoseconds: process.hrtime.bigint().toString() }
    } } : {}),
  }
  worker = new LocalOwnerVerifier(config)
}
process.send?.({ kind: 'ready', pid: process.pid })
process.once('message', input => {
  const beganAt = new Date().toISOString()
  const result = mode === 'legacy'
    ? (worker as ConsumptionStore).claim((input as any).decision, (input as any).successor)
    : (worker as LocalOwnerVerifier).recordDecision(process.env.PROOF_RACE_TOKEN!, input as any)
  const endedAt = new Date().toISOString()
  process.send?.({ kind: 'result', pid: process.pid, beganAt, endedAt, result })
  worker.close()
  process.disconnect?.()
})
