import { LocalOwnerVerifier } from '../src/local-owner/verifier'
import { FIXED_ACTION } from '../src/local-owner/contracts'

const config=JSON.parse(process.env.PROOF_CONFIG!)
const verifier=new LocalOwnerVerifier(config)
process.send?.({kind:'ready',pid:process.pid})
process.once('message',()=>{
  const beganAt=new Date().toISOString();let result
  if(process.env.PROOF_MODE==='claim')result=verifier.admitClaim(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!))
  else if(process.env.PROOF_MODE==='start')result=verifier.guardedStart(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!))
  else result=verifier.revoke(process.env.PROOF_TOKEN!,process.env.PROOF_DECISION!,'decision')
  process.send?.({kind:'result',pid:process.pid,beganAt,endedAt:new Date().toISOString(),result})
  verifier.close();process.disconnect?.()
})
