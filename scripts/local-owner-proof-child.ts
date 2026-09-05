import { LocalOwnerVerifier } from '../src/local-owner/verifier'

const config=JSON.parse(process.env.PROOF_CONFIG!)
const verifier=new LocalOwnerVerifier(config)
const finish=()=>{verifier.close();process.disconnect?.()}
process.send?.({kind:'ready',pid:process.pid})
process.once('message',()=>{
  const beganAt=new Date().toISOString()
  const mode=process.env.PROOF_MODE
  if(mode==='claim'){
    const result=verifier.admitClaim(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!))
    process.send?.({kind:'result',pid:process.pid,beganAt,endedAt:new Date().toISOString(),result})
    if(!result.ok)return finish()
    process.once('message',(message)=>{const startedAt=new Date().toISOString();const startResult=verifier.guardedStart(process.env.PROOF_TOKEN!,message as any);process.send?.({kind:'startResult',pid:process.pid,beganAt:startedAt,endedAt:new Date().toISOString(),result:startResult});finish()})
    return
  }
  const result=mode==='start'?verifier.guardedStart(process.env.PROOF_TOKEN!,JSON.parse(process.env.PROOF_INPUT!)):verifier.revoke(process.env.PROOF_TOKEN!,process.env.PROOF_DECISION!,'decision')
  process.send?.({kind:'result',pid:process.pid,beganAt,endedAt:new Date().toISOString(),result});finish()
})
