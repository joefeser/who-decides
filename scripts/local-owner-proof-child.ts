import { LocalOwnerVerifier } from '../src/local-owner/verifier'
import { existsSync } from 'node:fs'

const config=JSON.parse(process.env.PROOF_CONFIG!)
// sampleClock runs inside revoke's serialization guard and transaction. Hold
// that point until the parent has observed the competing start request.
if (process.env.PROOF_REVOKE_RELEASE) {
  const releasePath = process.env.PROOF_REVOKE_RELEASE
  config.test = { ...config.test, clock: () => {
    process.send?.({ kind: 'revokeGuardHeld', pid: process.pid, monotonicNanoseconds: process.hrtime.bigint().toString() })
    const deadline = process.hrtime.bigint() + 10_000_000_000n
    while (!existsSync(releasePath)) {
      if (process.hrtime.bigint() >= deadline) throw Error('revoke barrier timed out')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
    return { wallTime: new Date().toISOString(), monotonicNanoseconds: process.hrtime.bigint().toString() }
  } }
}
const verifier=new LocalOwnerVerifier(config)
const finish=()=>{verifier.close();process.disconnect?.()}
process.send?.({kind:'ready',pid:process.pid})
process.once('message',()=>{
  const beganAt=new Date().toISOString()
  process.send?.({kind:'began',pid:process.pid,beganAt})
  const mode=process.env.PROOF_MODE
  if(mode==='claim'){
    const result=verifier.admitClaim(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!))
    process.send?.({kind:'result',pid:process.pid,beganAt,endedAt:new Date().toISOString(),result})
    if(!result.ok)return finish()
    process.once('message',(message)=>{const startedAt=new Date().toISOString();process.send?.({kind:'startBegan',pid:process.pid,beganAt:startedAt,monotonicNanoseconds:process.hrtime.bigint().toString()});const startResult=verifier.guardedStart(process.env.PROOF_TOKEN!,message as any);process.send?.({kind:'startResult',pid:process.pid,beganAt:startedAt,endedAt:new Date().toISOString(),result:startResult});finish()})
    return
  }
  const result=mode==='start'?verifier.guardedStart(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!)):verifier.revoke(process.env.PROOF_TOKEN!,process.env.PROOF_DECISION!,'decision')
  process.send?.({kind:'result',pid:process.pid,beganAt,endedAt:new Date().toISOString(),monotonicNanoseconds:process.hrtime.bigint().toString(),result});finish()
})
