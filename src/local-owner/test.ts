import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { ConsumptionStore } from '../consumption/store'
import { LocalOwnerVerifier } from './verifier'
import { FIXED_ACTION, OBSERVATION_DIGEST_VALUE } from './contracts'
import { PROFILE_ID, PROFILE_VERSION, digestEnvelope, recordDigest } from './jcs'
import { deriveProofInventory, EVIDENCE_INTEGRITY_DEFECT } from './evidence'
import { bootstrapOwnerAdmittedStore, LEGACY_CONSUMPTION_WRITER_VERSION, LOCAL_OWNER_WRITER_VERSION, type WriterAdmission } from '../store-admission'

const TOKEN='synthetic-fixture-credential-0001'
const PIN='bc02b5972c2ac1184637062b3dabf7a655ae442cb6fa22940d8d119f678483ec'
const CASES:Record<string,string[]>={
  'JCS known vectors and profile selection':['profile-declaration-status'],
  'digest vectors reject omitted domains changed domains and alternate preimages':['digest-known-answer-and-domain-mismatch'],
  'authentication precedes disclosure and human act/base companion binding':['missing-or-wrong-authentication','authenticated-without-human-act','unrelated-or-reused-human-act','base-decision-companion-digest'],
  'fixed action, expiry and exact claim replay bindings':['unsupported-action-or-parameter'],
  'changed bindings conflict on occupied claim replay paths':['changed-binding-replay'],
  'exact claim retry is read-only before and after start':['exact-claim-retry'],
  'issuer namespace is separate while legacy decision id blocks without rewrite':['legacy-id-collision'],
  'same candidate decision id under two issuers: separate slots, no cross-issuer access (review P1)':['same-id-different-issuer'],
  'happy guarded start persists intent/result and never reexecutes':['authenticated-happy-path','completed-start-replay'],
  'status revocation fails closed and remains terminal':['claim-revoked-decision-active','revoked-status-reset'],
  'status corruption and missing durable readback deny observation':['missing-or-corrupt-durable-readback','absent-or-corrupt-status'],
  'status history rejects validly hashed gaps forks truncation and wrong heads':['status-gap-fork-truncation-or-wrong-head'],
  'independent clock rollbacks and unavailable time retain uncertainty without retry':['clock-rollback-or-unknown-time'],
  'expiry between intent and handoff retains uncertainty without retry':['expiry-between-intent-and-handoff'],
  'monotonic deadline denies a stalled wall clock at equality':['wall-clock-stall-crosses-monotonic-deadline'],
  'closed base record validates without candidate extension fields':['closed-base-record-remains-unchanged'],
  'closed clock shape and unknown clock fail before observation':['clock-sample-shape'],
  'malformed scope and extra start context produce typed stops without reserving intent':['unknown-profile-or-stripped-context'],
  'base approval without start_work is not authority':['base-approve-without-start-work'],
  'invalid base transition is rejected before candidate mutation':['invalid-base-transition-or-target'],
  'caller cannot override configured actor or issuer':['caller-forged-issuer-or-actor'],
  'decision and claim expiry are independently enforced':['decision-expired-claim-active','claim-expired-decision-active'],
  'decision revocation blocks an otherwise active claim':['decision-revoked-claim-active'],
  'missing and malformed expiry fail for decision and claim admission':['missing-or-malformed-expiry'],
  'claim expiry cannot exceed decision expiry':['claim-expiry-exceeds-decision'],
  'expiry is sampled after serialization guard wait':['expiry-after-lock-wait'],
  'completed and uncertain observations carry outcome-specific digests':['lost-response-or-ambiguous-observation','observation-digest-completed-or-uncertain'],
  'unavailable database returns a typed denial from every mutation':['store-unavailable'],
  'production surfaces cannot import the candidate verifier':['unsupported-surface-no-fallback'],
}
function test(name:string,fn:()=>void|Promise<void>){nodeTest(name,async()=>{await fn();const output=process.env.LOCAL_OWNER_CASE_RECEIPTS;if(output)for(const id of CASES[name]??[])appendFileSync(output,JSON.stringify({id,test:name,status:'passed'})+'\n')})}
const base=(decisionId='d1',packet='packet-1')=>({hacp_version:'v0.1-draft',record_kind:'hacp.human_decision_gate',decision_id:`human-${decisionId}`,packet_id:packet,profile_id:'hacp-base-draft',profile_version:'v0.1-draft',decision_matrix_version:'0.1',from_status:'approved',to_status:'in_progress',decision:'start_work',reason:'fixture human start act',created_at:'2026-09-05T00:00:00.000Z',actor_id:'fixture-human',actor_kind:'human',actor_verification_source:'signed_human_attestation',authentication_context:{interaction_channel:'cli',auth_event_ref:`event-${decisionId}`,secret_material_present:false},forbidden_effects_confirmed:[],evidence:[`candidate-decision:${decisionId}`,`candidate-action:${recordDigest('action',FIXED_ACTION as any).value}`]})
const candidateWriter:WriterAdmission={role:'local-owner-verifier',version:LOCAL_OWNER_WRITER_VERSION,insertionPath:'LocalOwnerVerifier.recordDecision'}
const legacyWriter:WriterAdmission={role:'legacy-consumption-writer',version:LEGACY_CONSUMPTION_WRITER_VERSION,insertionPath:'ConsumptionStore.claim'}
const filesystemType=(dir:string)=>statfsSync(dir,{bigint:true}).type.toString()
function setup(issuer='fixture-issuer',clock?:()=>{wallTime:string,monotonicNanoseconds:string},testConfig:Record<string,unknown>={},trustedHumanDecisions=[base(),base('legacy','packet-legacy')]){const dir=mkdtempSync(path.join(tmpdir(),'lo-'));const storeAdmission=bootstrapOwnerAdmittedStore({dbPath:path.join(dir,'store.db'),configGeneration:'fixture-generation-1',writers:[candidateWriter],approvedFilesystemTypes:[filesystemType(dir)]});const dbPath=storeAdmission.canonicalPath;const test=clock||Object.keys(testConfig).length?{...testConfig,...(clock?{clock}:{})}:undefined;const config={dbPath,storeAdmission,issuerId:issuer,actorId:'fixture-human',credential:TOKEN,selectedProfile:{id:PROFILE_ID,version:PROFILE_VERSION,status:'active',pin:PIN},trustedHumanDecisions,test};return{dir,dbPath,config,v:new LocalOwnerVerifier(config as any)}}
function setupWithLegacy(issuer='fixture-issuer'){const dir=mkdtempSync(path.join(tmpdir(),'lo-shared-'));const storeAdmission=bootstrapOwnerAdmittedStore({dbPath:path.join(dir,'store.db'),configGeneration:'fixture-shared-generation-1',writers:[candidateWriter,legacyWriter],approvedFilesystemTypes:[filesystemType(dir)]});const dbPath=storeAdmission.canonicalPath;const legacy=new ConsumptionStore(dbPath,{admission:storeAdmission,writer:legacyWriter});const config={dbPath,storeAdmission,issuerId:issuer,actorId:'fixture-human',credential:TOKEN,selectedProfile:{id:PROFILE_ID,version:PROFILE_VERSION,status:'active',pin:PIN},trustedHumanDecisions:[base(),base('legacy','packet-legacy')]};return{dir,dbPath,config,legacy,v:new LocalOwnerVerifier(config)}}
function decision(id='d1'){const b=base(id,id==='d1'?'packet-1':`packet-${id}`);return{decisionId:id,humanEventRef:b.decision_id,baseDecisionRef:b.packet_id,baseDecisionDigest:digestEnvelope(`${PROFILE_ID}.base-decision-reference.0.1-candidate`,b),requestRef:'request-1',action:FIXED_ACTION,approvedAt:'2026-09-05T00:00:00.000Z',expiresAt:'2100-01-01T00:00:00.000Z'}}
function claim(d:any,id='c1'){return{decisionId:d.decisionId,decisionDigest:d.digest,claimId:id,attemptKey:'attempt-1',successorId:'successor-1',requestRef:'request-1',action:FIXED_ACTION,claimedAt:'2026-09-05T00:00:01.000Z',expiresAt:'2099-01-01T00:00:00.000Z'}}
function admitted(s=setup()){const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const c=s.v.admitClaim(TOKEN,claim(d.value));assert(c.ok);return{s,d:d.value,c:c.value}}

test('JCS known vectors and profile selection',()=>{assert.equal(recordDigest('decision',{recordKind:'decision',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:'issuer-example',decisionId:'decision-example-001'}).value,'9de745ae777609863f309450a0455da5ad7a1d166f8f29734d8a2d35d569f014');assert.equal(digestEnvelope(`${PROFILE_ID}.observation.0.1-candidate`,{operationId:'observe_fixed_payload',payload:'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1'}).value,OBSERVATION_DIGEST_VALUE)
  // Every profile-declaration variant is exercised: missing (omitted field),
  // changed id/version, changed pin, and non-active status — all rejected.
  for(const variant of [
    (p:any)=>{delete p.selectedProfile},
    (p:any)=>{p.selectedProfile={...p.selectedProfile,id:'org.other'}},
    (p:any)=>{p.selectedProfile={...p.selectedProfile,version:'9.9'}},
    (p:any)=>{p.selectedProfile={...p.selectedProfile,pin:'0'.repeat(64)}},
    (p:any)=>{p.selectedProfile={...p.selectedProfile,status:'deprecated'}},
    (p:any)=>{p.selectedProfile={...p.selectedProfile,status:'revoked'}},
  ]){const cfg=structuredClone(setup().config);variant(cfg);assert.throws(()=>new LocalOwnerVerifier(cfg),/PROFILE_NOT_SELECTED|INVALID_OWNER_CONFIGURATION/,'profile declaration must be rejected: '+JSON.stringify(cfg.selectedProfile))}
})
test('digest vectors reject omitted domains changed domains and alternate preimages',()=>{const published=recordDigest('decision',{recordKind:'decision',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:'issuer-example',decisionId:'decision-example-001'});assert.equal(published.value,'9de745ae777609863f309450a0455da5ad7a1d166f8f29734d8a2d35d569f014');assert.notEqual(recordDigest('decision',{recordKind:'decision',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:'issuer-example',decisionId:'alternate-preimage'}).value,published.value);for(const variant of ['omitted','changed-domain','alternate-preimage'] as const){const s=setup(`digest-${variant}`);try{const input:any=decision();if(variant==='omitted')delete input.baseDecisionDigest;else if(variant==='changed-domain')input.baseDecisionDigest.domain='wrong';else input.baseDecisionDigest=digestEnvelope(`${PROFILE_ID}.base-decision-reference.0.1-candidate`,{...base(),reason:'alternate preimage'});assert.equal(s.v.recordDecision(TOKEN,input).ok,false,variant);assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}}})
test('authentication precedes disclosure and human act/base companion binding',()=>{const s=setup();try{assert.deepEqual(s.v.inspect('wrong','missing'),{ok:false,stop:'MISSING_AUTHORITY',detail:'access denied'});for(const mutate of [(x:any)=>{x.humanEventRef='caller-invented'},(x:any)=>{x.baseDecisionRef='untrusted-packet'},(x:any)=>{x.baseDecisionDigest.value='0'.repeat(64)},(x:any)=>{x.issuerId='forged'}]){const x:any=structuredClone(decision());mutate(x);const r=s.v.recordDecision(TOKEN,x);assert.equal(r.ok,false)}assert.equal(s.v.inspect(TOKEN,'d1').ok,false);const noAct=new LocalOwnerVerifier({...s.config,issuerId:'no-act',trustedHumanDecisions:[]});assert.equal((noAct.recordDecision(TOKEN,decision()) as any).stop,'MISSING_AUTHORITY');noAct.close();const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);assert.equal((s.v.recordDecision(TOKEN,decision()) as any).stop,'MISSING_AUTHORITY','consumed human act cannot be reused');const c=s.v.admitClaim(TOKEN,claim(d.value));assert(c.ok);for(const operation of [()=>s.v.recordDecision('wrong',decision('legacy')),()=>s.v.admitClaim('wrong',claim(d.value)),()=>s.v.revoke('wrong','d1','claim'),()=>s.v.guardedStart('wrong',startInput())])assert.equal((operation() as any).stop,'MISSING_AUTHORITY');assert.equal((s.v.inspect(TOKEN,'d1') as any).value.start_intent_digest,null)}finally{s.v.close();rmSync(s.dir,{recursive:true})}})
test('fixed action, expiry and exact claim replay bindings',()=>{const s=setup();try{const bad:any=decision();bad.action={...FIXED_ACTION,parameters:{payload:'evil'}};assert.equal((s.v.recordDecision(TOKEN,bad) as any).stop,'SCOPE_CONFLICT');const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const ci=claim(d.value);assert.equal((s.v.admitClaim(TOKEN,{...ci,decisionDigest:{...ci.decisionDigest,domain:'wrong'}}) as any).stop,'SCOPE_CONFLICT');const c=s.v.admitClaim(TOKEN,ci);assert(c.ok);assert.equal((s.v.admitClaim(TOKEN,ci) as any).value.digest.value,(c.value.digest as any).value);for(const key of ['successorId','attemptKey','requestRef'] as const){const changed={...ci,[key]:'changed'};assert.equal((s.v.admitClaim(TOKEN,changed) as any).stop,'SCOPE_CONFLICT')}assert.equal((s.v.admitClaim(TOKEN,{...ci,claimId:'c2'}) as any).stop,'SCOPE_CONFLICT');const evilStart:any={decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:{...FIXED_ACTION,parameters:{payload:'evil'}}};assert.equal((s.v.guardedStart(TOKEN,evilStart) as any).stop,'SCOPE_CONFLICT','start boundary rejects an unsupported action')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('changed bindings conflict on occupied claim replay paths',()=>{
  const variants:Array<[string,(input:any)=>void]>=[
    ['digest',input=>{input.decisionDigest={...input.decisionDigest,value:'0'.repeat(64)}}],
    ['request',input=>{input.requestRef='changed-request'}],
    ['action',input=>{input.action={...FIXED_ACTION,parameters:{payload:'changed'}}}],
    ['expiry',input=>{input.expiresAt='2098-01-01T00:00:00.000Z'}],
    ['successor',input=>{input.successorId='changed-successor'}],
  ]
  for(const replayPath of ['same-record-id','alternate-record-id'] as const)for(const [label,mutate] of variants){
    const a=admitted()
    try{const input:any=claim(a.d);if(replayPath==='alternate-record-id')input.claimId='c2';mutate(input)
      assert.equal((a.s.v.admitClaim(TOKEN,input) as any).stop,'SCOPE_CONFLICT',`${replayPath}:${label}`)
      const slot=(a.s.v.inspect(TOKEN,'d1') as any).value;assert.equal(slot.claim_digest,(a.c.digest as any).value);assert.equal(slot.start_intent_digest,null)
    }finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}
  }
  for(const profileVersion of ['changed-profile','']){const a=admitted();try{
    const db=new Database(a.s.dbPath);const changed={...a.c,profileVersion};const digest=recordDigest('claim',changed);db.prepare("UPDATE local_owner_records SET digest=?,record_json=? WHERE kind='claim'").run(digest.value,JSON.stringify({...changed,digest}));db.close()
    assert.equal(a.s.v.admitClaim(TOKEN,claim(a.d)).ok,false,`stored profile ${JSON.stringify(profileVersion)}`)
    assert.equal(a.s.v.guardedStart(TOKEN,startInput()).ok,false);assert.equal((a.s.v.inspect(TOKEN,'d1') as any).value.start_intent_digest,null)
  }finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}}
})

test('exact claim retry is read-only before and after start',()=>{const a=admitted();try{
  const snapshot=()=>{const db=new Database(a.s.dbPath,{readonly:true});const value={records:db.prepare('select kind,record_id,digest,record_json from local_owner_records order by kind,record_id').all(),statuses:db.prepare('select target_kind,sequence,digest,record_json from local_owner_status order by target_kind,sequence').all()};db.close();return value}
  const before=snapshot(),firstRetry=a.s.v.admitClaim(TOKEN,claim(a.d));assert(firstRetry.ok);assert.deepEqual(firstRetry.value,a.c);assert.deepEqual(snapshot(),before)
  const started=a.s.v.guardedStart(TOKEN,startInput());assert(started.ok);const afterStart=snapshot(),secondRetry=a.s.v.admitClaim(TOKEN,claim(a.d));assert(secondRetry.ok);assert.deepEqual(secondRetry.value,a.c);assert.equal(secondRetry.value.expiresAt,a.c.expiresAt);assert.deepEqual(snapshot(),afterStart)
  assert.equal((a.s.v.guardedStart(TOKEN,startInput()) as any).stop,'HUMAN_DECISION_REQUIRED');const db=new Database(a.s.dbPath,{readonly:true});assert.equal((db.prepare("select count(*) n from local_owner_records where kind='start-intent'").get() as any).n,1);assert.equal((db.prepare("select count(*) n from local_owner_records where kind='start-result'").get() as any).n,1);db.close()
}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})
test('issuer namespace is separate while legacy decision id blocks without rewrite',()=>{const s=setupWithLegacy('issuer-a');try{s.legacy.claim({decisionId:'legacy',chosenOption:'x',rationale:'x',decidedAt:'2026-09-05T00:00:00.000Z',decisionRequestId:'r',permittedAction:'x'},'old');const db=new Database(s.dbPath);const bytes=(db.prepare('select receipt_json from consumption_receipts where decision_id=?').get('legacy') as any).receipt_json;db.close();assert.equal((s.v.recordDecision(TOKEN,decision('legacy')) as any).stop,'MISSING_AUTHORITY');const db2=new Database(s.dbPath);assert.equal((db2.prepare('select receipt_json from consumption_receipts where decision_id=?').get('legacy') as any).receipt_json,bytes);db2.close();const other=new LocalOwnerVerifier({...s.config,issuerId:'issuer-b'});assert(other.recordDecision(TOKEN,decision()).ok);other.close()}finally{s.v.close();s.legacy.close();rmSync(s.dir,{recursive:true})};const reverse=setupWithLegacy();try{assert(reverse.v.recordDecision(TOKEN,decision()).ok);const r=reverse.legacy.claim({decisionId:'d1',chosenOption:'x',rationale:'x',decidedAt:'2026-09-05T00:00:00.000Z',decisionRequestId:'r',permittedAction:'x'},'old');assert.equal(r.status,'rejected');if(r.status==='rejected')assert.equal(r.reason,'profile_slot_conflict')}finally{reverse.v.close();reverse.legacy.close();rmSync(reverse.dir,{recursive:true})}})
test('happy guarded start persists intent/result and never reexecutes',()=>{const a=admitted();try{const input={decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION};const r=a.s.v.guardedStart(TOKEN,input);assert(r.ok);assert.deepEqual(r.value.observation,{operationId:'observe_fixed_payload',payload:'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1'});assert.equal(r.value.result.observationDigest.value,OBSERVATION_DIGEST_VALUE);assert.equal(r.value.intent.admittedAt,r.value.intent.clockSample.wallTime);assert.equal(r.value.result.observedAt,r.value.result.observationClockSample.wallTime);assert.equal((a.s.v.guardedStart(TOKEN,input) as any).stop,'HUMAN_DECISION_REQUIRED')}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})
test('status revocation fails closed and remains terminal',()=>{const b=admitted();try{
  const original=(b.s.v.inspect(TOKEN,'d1') as any).value;const revoked=b.s.v.revoke(TOKEN,'d1','claim');assert(revoked.ok)
  const afterRevoke=(b.s.v.inspect(TOKEN,'d1') as any).value;assert.equal(afterRevoke.decision_digest,original.decision_digest);assert.equal(afterRevoke.claim_digest,original.claim_digest);assert.equal(afterRevoke.start_intent_digest,null);assert.notEqual(afterRevoke.claim_status_head,original.claim_status_head)
  const db=new Database(b.s.dbPath,{readonly:true});const statuses=(db.prepare("select sequence,digest,record_json from local_owner_status where target_kind='claim' order by sequence").all() as any[]).map(row=>({...row,record:JSON.parse(row.record_json)}));assert.equal(statuses.length,2);assert.deepEqual(statuses.map(row=>row.sequence),[0,1]);assert.equal(statuses[1].record.previousDigest,statuses[0].digest);assert.equal(statuses[1].record.state,'revoked');assert.equal(statuses[1].digest,afterRevoke.claim_status_head);db.close()
  assert.equal((b.s.v.guardedStart(TOKEN,startInput()) as any).stop,'STALE_PACKET');assert.equal((b.s.v.revoke(TOKEN,'d1','claim') as any).stop,'STALE_PACKET')
  const final=(b.s.v.inspect(TOKEN,'d1') as any).value;assert.equal(final.decision_digest,original.decision_digest);assert.equal(final.claim_digest,original.claim_digest);assert.equal(final.claim_status_head,afterRevoke.claim_status_head);assert.equal(final.start_intent_digest,null);const verify=new Database(b.s.dbPath,{readonly:true});assert.equal((verify.prepare("select count(*) n from local_owner_records where kind in ('start-intent','start-result')").get() as any).n,0);assert.equal((verify.prepare("select count(*) n from local_owner_status where target_kind='claim'").get() as any).n,2);verify.close()
}finally{b.s.v.close();rmSync(b.s.dir,{recursive:true})}})
test('status corruption and missing durable readback deny observation',()=>{for(const sql of ["delete from local_owner_records where kind='claim'","update local_owner_records set record_json='{' where kind='claim'","update local_owner_records set record_json=json_set(record_json,'$.digest.domain','wrong') where kind='claim'","update local_owner_slots set claim_status_head='bad'","update local_owner_status set record_json='{' where target_kind='claim'","update local_owner_status set record_json=json_set(record_json,'$.digest.domain','wrong') where target_kind='claim'","update local_owner_status set sequence=4 where target_kind='claim'","delete from local_owner_status where target_kind='claim'","insert into local_owner_status select issuer_id,decision_id,target_kind,sequence+1,digest,record_json from local_owner_status where target_kind='claim'"]){const a=admitted();try{new Database(a.s.dbPath).exec(sql);const r=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal(r.ok,false);assert(['UNVERIFIED_ASSUMPTION','MISSING_AUTHORITY'].includes((r as any).stop))}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}}})
test('status history rejects validly hashed gaps forks truncation and wrong heads', () => {
  for (const target of ['decision', 'claim'] as const) {
    for (const defect of ['gap', 'fork', 'truncation', 'wrong-head'] as const) {
      const a = admitted()
      try {
        assert(a.s.v.revoke(TOKEN, 'd1', target).ok)
        const db = new Database(a.s.dbPath)
        try {
          const rows = db.prepare('select sequence,digest,record_json from local_owner_status where target_kind=? order by sequence').all(target) as any[]
          assert.equal(rows.length, 2)
          if (defect === 'gap') {
            db.prepare('delete from local_owner_status where target_kind=? and sequence=0').run(target)
          } else if (defect === 'truncation') {
            // Retain the slot's committed head while removing its revoked suffix.
            db.prepare('delete from local_owner_status where target_kind=? and sequence=1').run(target)
          } else if (defect === 'fork') {
            // Keep a valid digest so only the broken predecessor link can deny it.
            const record = { ...JSON.parse(rows[1].record_json), previousDigest: '0'.repeat(64) }
            const digest = recordDigest('status-event', record)
            db.prepare('update local_owner_status set digest=?,record_json=? where target_kind=? and sequence=1')
              .run(digest.value, JSON.stringify({ ...record, digest }), target)
            db.prepare(`update local_owner_slots set ${target}_status_head=?`).run(digest.value)
          } else {
            db.prepare(`update local_owner_slots set ${target}_status_head=?`).run(rows[0].digest)
          }
          for (const row of db.prepare('select digest,record_json from local_owner_status where target_kind=?').all(target) as any[]) {
            const record = JSON.parse(row.record_json)
            assert.deepEqual(record.digest, recordDigest('status-event', record))
            assert.equal(row.digest, record.digest.value)
          }
          const result = a.s.v.guardedStart(TOKEN, startInput())
          assert(!result.ok)
          assert.equal(result.stop, 'UNVERIFIED_ASSUMPTION', `${target}:${defect}`)
          assert.equal((a.s.v.inspect(TOKEN, 'd1') as any).value.start_intent_digest, null)
          assert.equal((db.prepare("select count(*) n from local_owner_records where kind in ('start-intent','start-result')").get() as any).n, 0)
        } finally { db.close() }
      } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
    }
  }
})

function assertUncertainStart(s: ReturnType<typeof setup>, expectedStop: string) {
  const result = s.v.guardedStart(TOKEN, startInput())
  assert(!result.ok)
  assert.equal(result.stop, expectedStop)
  assert.equal(Object.hasOwn(result, 'observation'), false)
  const slot = (s.v.inspect(TOKEN, 'd1') as any).value
  assert(slot.start_intent_digest)
  const db = new Database(s.dbPath, { readonly: true })
  try {
    const snapshot = () => db.prepare("select kind,digest,record_json from local_owner_records where kind in ('start-intent','start-result') order by kind").all() as any[]
    const before = snapshot()
    assert.deepEqual(before.map(row => row.kind), ['start-intent', 'start-result'])
    assert.equal(before[0].digest, slot.start_intent_digest)
    const durableResult = JSON.parse(before[1].record_json)
    assert.equal(durableResult.outcome, 'uncertain')
    assert.equal(durableResult.observationDigest, null)
    assert.equal(durableResult.intentDigest.value, slot.start_intent_digest)
    const retry = s.v.guardedStart(TOKEN, startInput())
    assert(!retry.ok)
    assert.equal(retry.stop, 'HUMAN_DECISION_REQUIRED')
    assert.deepEqual(snapshot(), before, 'retry must not write another intent or result')
    assert.deepEqual((s.v.inspect(TOKEN, 'd1') as any).value, slot)
  } finally { db.close() }
}

test('independent clock rollbacks and unavailable time retain uncertainty without retry', () => {
  for (const variant of ['wall', 'monotonic', 'unavailable'] as const) {
    let index = 0
    const s = setup(`clock-${variant}`, () => {
      if (index < 3) {
        const value = index++
        return { wallTime: `2026-09-05T00:00:0${value}.000Z`, monotonicNanoseconds: String(value) }
      }
      if (variant === 'unavailable') throw Error('clock unavailable')
      return { wallTime: variant === 'wall' ? '2026-09-05T00:00:01.000Z' : '2026-09-05T00:00:03.000Z', monotonicNanoseconds: variant === 'monotonic' ? '1' : '3' }
    })
    try {
      admitted(s)
      assertUncertainStart(s, 'UNVERIFIED_ASSUMPTION')
    } finally { s.v.close(); rmSync(s.dir, { recursive: true }) }
  }
})

test('expiry between intent and handoff retains uncertainty without retry', () => {
  const samples = [
    { wallTime: '2026-09-05T00:00:00.000Z', monotonicNanoseconds: '0' },
    { wallTime: '2026-09-05T00:00:01.000Z', monotonicNanoseconds: '1' },
    { wallTime: '2026-09-05T00:00:02.000Z', monotonicNanoseconds: '2' },
    { wallTime: '2026-09-05T00:00:03.000Z', monotonicNanoseconds: '3' },
  ]
  let index = 0
  const s = setup('handoff-expiry', () => samples[Math.min(index++, 3)])
  try {
    const d = s.v.recordDecision(TOKEN, { ...decision(), expiresAt: '2026-09-05T00:00:04.000Z' })
    assert(d.ok)
    assert(s.v.admitClaim(TOKEN, { ...claim(d.value), expiresAt: '2026-09-05T00:00:03.000Z' }).ok)
    assertUncertainStart(s, 'STALE_PACKET')
  } finally { s.v.close(); rmSync(s.dir, { recursive: true }) }
})

test('monotonic deadline denies a stalled wall clock at equality',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1000000000'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'2000000000'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'5000000000'}];let i=0;const s=setup('fixture-issuer',()=>samples[Math.min(i++,3)]);try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:06.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:05.000Z'});assert(c.ok);const r=s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal((r as any).stop,'STALE_PACKET')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('all five closed candidate record schemas validate emitted records and exact digest domains',()=>{const a=admitted();try{const start=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert(start.ok);const db=new Database(a.s.dbPath,{readonly:true});const rows=db.prepare('select kind,record_json from local_owner_records').all() as any[];const statuses=db.prepare('select record_json from local_owner_status').all() as any[];db.close();const ajv=new Ajv2020({strict:false});addFormats(ajv);for(const kind of ['decision','claim','status-event','start-intent','start-result']){const schema=JSON.parse(readFileSync(path.resolve(`schemas/local-owner/${kind}.schema.json`),'utf8'));const validate=ajv.compile(schema);const records=kind==='status-event'?statuses.map(x=>JSON.parse(x.record_json)):rows.filter(x=>x.kind===kind).map(x=>JSON.parse(x.record_json));assert(records.length>0,kind);for(const record of records){assert(validate(record),`${kind}: ${ajv.errorsText(validate.errors)}`);const wrong:any=structuredClone(record);wrong.digest.domain='wrong';assert.equal(validate(wrong),false,`${kind} own digest domain`)}}for(const [kind,field] of [['decision','baseDecisionDigest'],['claim','decisionDigest'],['start-intent','claimDigest'],['start-result','intentDigest']] as const){const schema=JSON.parse(readFileSync(path.resolve(`schemas/local-owner/${kind}.schema.json`),'utf8'));const validator=new Ajv2020({strict:false});addFormats(validator);const validate=validator.compile(schema);const record=rows.find(x=>x.kind===kind);assert(record);const wrong=JSON.parse(record.record_json);wrong[field].domain='wrong';assert.equal(validate(wrong),false,`${kind} ${field} domain`)}const resultSchema=JSON.parse(readFileSync(path.resolve('schemas/local-owner/start-result.schema.json'),'utf8'));const resultAjv=new Ajv2020({strict:false});addFormats(resultAjv);const validateResult=resultAjv.compile(resultSchema),completed=JSON.parse(rows.find(x=>x.kind==='start-result').record_json);completed.observationDigest=null;assert.equal(validateResult(completed),false);completed.outcome='uncertain';completed.observationDigest={algorithm:'sha256',canonicalization:'json-rfc8785-jcs',domain:`${PROFILE_ID}.observation.0.1-candidate`,value:OBSERVATION_DIGEST_VALUE};assert.equal(validateResult(completed),false)}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})

test('closed base record validates without candidate extension fields',()=>{const record=base();const schema=JSON.parse(readFileSync(path.resolve('schemas/hacp/v0.1-draft/human-decision.schema.json'),'utf8'));const ajv=new Ajv2020({strict:false});addFormats(ajv);const validate=ajv.compile(schema);assert(validate(record),ajv.errorsText(validate.errors));for(const field of ['candidateDecisionDigest','baseDecisionDigest','issuerId','expiresAt'])assert.equal(Object.hasOwn(record,field),false,field);const extended:any={...record,candidateDecisionDigest:{value:'0'.repeat(64)}};assert.equal(validate(extended),false,'closed base schema rejects candidate extension')})

test('candidate schemas reject non-UTC, missing-millisecond and invalid-calendar timestamps',()=>{const a=admitted();try{const db=new Database(a.s.dbPath,{readonly:true});const row=db.prepare("select record_json from local_owner_records where kind='claim'").get() as any;db.close();const schema=JSON.parse(readFileSync(path.resolve('schemas/local-owner/claim.schema.json'),'utf8'));const ajv=new Ajv2020({strict:false});addFormats(ajv);const validate=ajv.compile(schema);for(const value of ['', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00.000+00:00', '2026-02-30T00:00:00.000Z']){const record=JSON.parse(row.record_json);record.expiresAt=value;assert.equal(validate(record),false,value)}}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})
test('closed clock shape and unknown clock fail before observation',()=>{for(const sample of [{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'01'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'1',extra:true},null]){let i=0;const s=setup('fixture-issuer',()=>{if(i++<2)return{wallTime:`2026-09-05T00:00:0${i-1}.000Z`,monotonicNanoseconds:String(i)};if(sample===null)throw Error('clock unavailable');return sample as any});const a=admitted(s);try{const r=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal((r as any).stop,'UNVERIFIED_ASSUMPTION')}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}}})

test('same candidate decision id under two issuers: separate slots, no cross-issuer access (review P1)',()=>{const s=setup('issuer-a');try{
  // BOTH issuers admit the SAME decision id in the SAME database file.
  const b=s.v.recordDecision(TOKEN,decision('d1'));assert(b.ok)
  const other=new LocalOwnerVerifier({...s.config,issuerId:'issuer-b',trustedHumanDecisions:[base('d1','packet-1')]});try{
    const b2=other.recordDecision(TOKEN,decision('d1'));assert(b2.ok)
    const db=new Database(s.dbPath)
    const slots=db.prepare('select issuer_id,decision_id from local_owner_slots order by issuer_id').all()
    db.close()
    assert.deepEqual(slots,[{issuer_id:'issuer-a',decision_id:'d1'},{issuer_id:'issuer-b',decision_id:'d1'}],'two independent slots for the same id')
    // No cross-issuer access: issuer-a cannot see issuer-b's slot and vice versa.
    assert.equal((s.v.inspect(TOKEN,'d1') as any).value.issuer_id,'issuer-a')
    assert.equal((other.inspect(TOKEN,'d1') as any).value.issuer_id,'issuer-b')
    // The digests differ (different issuers bound into the records).
    assert.notEqual((b.value.digest as any).value,(b2.value.digest as any).value)
  }finally{other.close()}
}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('durable clock checkpoint never moves backwards (review P1)',()=>{const s=setup('clock-race');try{
  // The reachable interleaving: guardedStart samples its second clock OUTSIDE
  // the result transaction — another process may commit a later durable time
  // before the slower writer persists. persistClock must never regress it.
  const persist=(v:LocalOwnerVerifier,wall:string)=>(v as unknown as {persistClock(sample:{wallTime:string,monotonicNanoseconds:string}):void}).persistClock({wallTime:wall,monotonicNanoseconds:'1'})
  const read=()=>{const db=new Database(s.dbPath);const row=db.prepare('select wall_time from local_owner_clock where issuer_id=?').get('clock-race') as {wall_time:string}|undefined;db.close();return row?.wall_time}
  persist(s.v,'2026-09-05T10:00:00.000Z');assert.equal(read(),'2026-09-05T10:00:00.000Z','forward write applies')
  // A concurrent process commits a later accepted time…
  const db=new Database(s.dbPath);db.prepare('update local_owner_clock set wall_time=? where issuer_id=?').run('2026-09-05T12:00:00.000Z','clock-race');db.close()
  // …then the slower writer persists its earlier sample: must be a no-op.
  persist(s.v,'2026-09-05T11:00:00.000Z');assert.equal(read(),'2026-09-05T12:00:00.000Z','earlier sample cannot drag the checkpoint back')
  persist(s.v,'2026-09-05T12:30:00.000Z');assert.equal(read(),'2026-09-05T12:30:00.000Z','forward writes still apply after a blocked regression')
}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('empty identifiers are rejected before any admission (review P2)',()=>{const s=setup();try{
  const emptyDec:any=decision();emptyDec.decisionId='';assert.equal((s.v.recordDecision(TOKEN,emptyDec) as any).stop,'MISSING_AUTHORITY')
  const d=s.v.recordDecision(TOKEN,decision());assert(d.ok)
  for(const key of ['claimId','attemptKey','successorId','requestRef'] as const){const c:any=claim(d.value);c[key]='';assert.equal((s.v.admitClaim(TOKEN,c) as any).stop,'MISSING_AUTHORITY',key)}
  const badStart:any={decisionId:'d1',claimId:'',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION}
  assert.equal((s.v.guardedStart(TOKEN,badStart) as any).stop,'MISSING_AUTHORITY')
}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

const startInput = () => ({ decisionId: 'd1', claimId: 'c1', intentId: 'i1', successorId: 'successor-1', action: structuredClone(FIXED_ACTION) })

test('start rejects a rehashed decision that no longer matches its reserved slot', () => {
  const a = admitted()
  try {
    const db = new Database(a.s.dbPath)
    const changed = { ...a.d, expiresAt: '2101-01-01T00:00:00.000Z' }
    const digest = recordDigest('decision', changed)
    db.prepare("UPDATE local_owner_records SET digest=?, record_json=? WHERE kind='decision'")
      .run(digest.value, JSON.stringify({ ...changed, digest }))
    db.close()
    const result = a.s.v.guardedStart(TOKEN, startInput())
    assert.equal(result.ok, false)
    assert.equal((a.s.v.inspect(TOKEN, 'd1') as any).value.start_intent_digest, null)
  } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
})

test('invalid or missing durable clock checkpoint denies start before intent', () => {
  for (const sql of ["UPDATE local_owner_clock SET wall_time='broken'", 'DELETE FROM local_owner_clock']) {
    const a = admitted()
    try {
      const db = new Database(a.s.dbPath)
      db.exec(sql)
      db.close()
      const result = a.s.v.guardedStart(TOKEN, startInput())
      assert.equal(result.ok, false, sql)
      assert.equal((a.s.v.inspect(TOKEN, 'd1') as any).value.start_intent_digest, null)
    } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
  }
})

test('returned action and observation cannot change the fixed operation for later calls', () => {
  const a = admitted()
  const payload = (a.d.action as any).parameters.payload
  try {
    assert.equal(Reflect.set((a.d.action as any).parameters, 'payload', 'changed'), false)
    const result = a.s.v.guardedStart(TOKEN, startInput())
    assert(result.ok)
    assert.equal(Reflect.set(result.value.observation, 'payload', 'changed'), false)
    assert.equal(result.value.observation.payload, 'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1')
  } finally {
    Reflect.set((a.d.action as any).parameters, 'payload', payload)
    a.s.v.close(); rmSync(a.s.dir, { recursive: true })
  }
})

test('malformed scope and extra start context produce typed stops without reserving intent', () => {
  const a = admitted()
  try {
    const stripped:any=startInput();delete stripped.decisionId
    for (const input of [stripped, { ...startInput(), recovery: true }]) {
      const result = a.s.v.guardedStart(TOKEN, input as any)
      assert.equal((result as any).stop, 'MISSING_AUTHORITY')
      assert.equal((a.s.v.inspect(TOKEN, 'd1') as any).value.start_intent_digest, null)
    }
  } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
  const unknown=setup('unknown-profile');try{const config:any=structuredClone(unknown.config);config.selectedProfile.id='org.unknown';assert.throws(()=>new LocalOwnerVerifier(config),/PROFILE_NOT_SELECTED/);assert.equal((unknown.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{unknown.v.close();rmSync(unknown.dir,{recursive:true})}
})

test('exact claim retry rejects a rehashed receipt outside the reserved binding', () => {
  const a = admitted()
  try {
    const db = new Database(a.s.dbPath)
    const changed = { ...a.c, successorId: 'different-successor' }
    const digest = recordDigest('claim', changed)
    db.prepare("UPDATE local_owner_records SET digest=?, record_json=? WHERE kind='claim'")
      .run(digest.value, JSON.stringify({ ...changed, digest }))
    db.close()
    assert.equal(a.s.v.admitClaim(TOKEN, claim(a.d)).ok, false)
  } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
})

test('base approval without start_work is not authority',()=>{const human={...base(),decision:'approve_next_packet'};const s=setup('base-approval',undefined,{},[human]);try{const r=s.v.recordDecision(TOKEN,decision());assert.equal((r as any).stop,'MISSING_AUTHORITY');assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('invalid base transition is rejected before candidate mutation',()=>{
  const variants: Array<[string, Record<string, unknown>]> = [
    ['from_status', { from_status: 'draft' }],
    ['to_status', { to_status: 'completed' }],
    ['decision target', { decision: 'mark_complete' }],
  ]
  for(const [label, patch] of variants){
    const human = { ...base(), ...patch } as any
    const s = setup('bad-transition-' + label, undefined, {}, [human])
    try{const r=s.v.recordDecision(TOKEN,decision());assert.equal((r as any).stop,'MISSING_AUTHORITY',label);assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY',label)}finally{s.v.close();rmSync(s.dir,{recursive:true})}
  }})

test('caller cannot override configured actor or issuer',()=>{const s=setup();try{for(const field of ['actorId','issuerId']){const input:any=decision();input[field]='caller-forged';assert.equal((s.v.recordDecision(TOKEN,input) as any).stop,'MISSING_AUTHORITY')}assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('decision and claim expiry are independently enforced',()=>{for(const variant of ['decision','claim'] as const){const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:03.000Z',monotonicNanoseconds:'2'}];let i=0;const s=setup(`expiry-${variant}`,()=>samples[Math.min(i++,2)]);try{
  const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:variant==='decision'?'2026-09-05T00:00:03.000Z':'2026-09-05T00:00:06.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:03.000Z'});assert(c.ok)
  if(variant==='decision'){const db=new Database(s.dbPath);const extended={...c.value,expiresAt:'2026-09-05T00:00:06.000Z'};const claimDigest=recordDigest('claim',extended);db.prepare("update local_owner_records set digest=?,record_json=? where kind='claim'").run(claimDigest.value,JSON.stringify({...extended,digest:claimDigest}));const statusRow=db.prepare("select record_json from local_owner_status where target_kind='claim' and sequence=0").get() as any;const status={...JSON.parse(statusRow.record_json),targetDigest:claimDigest.value};const statusDigest=recordDigest('status-event',status);db.prepare("update local_owner_status set digest=?,record_json=? where target_kind='claim' and sequence=0").run(statusDigest.value,JSON.stringify({...status,digest:statusDigest}));db.prepare('update local_owner_slots set claim_digest=?,claim_status_head=? where issuer_id=? and decision_id=?').run(claimDigest.value,statusDigest.value,s.config.issuerId,'d1');db.close();assert.equal((s.v as any).read('claim','c1').kind,'ok')}
  const r=s.v.guardedStart(TOKEN,startInput());assert.equal((r as any).stop,'STALE_PACKET',JSON.stringify(r));const db=new Database(s.dbPath);const records=(db.prepare("select kind,record_json from local_owner_records where kind in ('decision','claim') order by kind").all() as any[]).map(row=>({kind:row.kind,record:JSON.parse(row.record_json)}));const states=db.prepare("select target_kind,record_json from local_owner_status where sequence=0").all() as any[];const work=(db.prepare("select count(*) n from local_owner_records where kind in ('start-intent','start-result')").get() as any).n;db.close();assert(states.every(x=>JSON.parse(x.record_json).state==='active'));assert.equal(work,0);const decisionRecord=records.find(x=>x.kind==='decision')!.record,claimRecord=records.find(x=>x.kind==='claim')!.record;if(variant==='decision'){assert.equal(decisionRecord.expiresAt,'2026-09-05T00:00:03.000Z');assert.equal(claimRecord.expiresAt,'2026-09-05T00:00:06.000Z')}else{assert.equal(decisionRecord.expiresAt,'2026-09-05T00:00:06.000Z');assert.equal(claimRecord.expiresAt,'2026-09-05T00:00:03.000Z')}
}finally{s.v.close();rmSync(s.dir,{recursive:true})}}})

test('decision revocation blocks an otherwise active claim',()=>{const a=admitted();try{assert(a.s.v.revoke(TOKEN,'d1','decision').ok);assert.equal((a.s.v.guardedStart(TOKEN,startInput()) as any).stop,'STALE_PACKET');const db=new Database(a.s.dbPath);const claimStatus=JSON.parse((db.prepare("select record_json from local_owner_status where target_kind='claim' order by sequence desc limit 1").get() as any).record_json);db.close();assert.equal(claimStatus.state,'active')}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})

test('missing and malformed expiry fail for decision and claim admission',()=>{for(const target of ['decision','claim'] as const)for(const value of [undefined,'not-a-time']){const s=setup(`expiry-input-${target}-${String(value)}`);try{if(target==='decision'){const input:any=decision();if(value===undefined)delete input.expiresAt;else input.expiresAt=value;assert.equal(s.v.recordDecision(TOKEN,input).ok,false)}else{const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const input:any=claim(d.value);if(value===undefined)delete input.expiresAt;else input.expiresAt=value;assert.equal(s.v.admitClaim(TOKEN,input).ok,false)}assert.equal((s.v.inspect(TOKEN,'missing') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}}})

test('claim expiry cannot exceed decision expiry',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'}];let i=0;const s=setup('claim-deadline',()=>samples[Math.min(i++,1)]);try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:05.000Z'});assert(d.ok);const r=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:06.000Z'});assert.equal(r.ok,false);assert.equal((s.v.inspect(TOKEN,'d1') as any).value.claim_digest,null)}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('expiry is sampled after serialization guard wait',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:03.000Z',monotonicNanoseconds:'2'}];let i=0,startBegan=0;const s=setup('post-wait-expiry',()=>{if(i===2)assert(Date.now()-startBegan>=20,'start clock sampled before guarded wait completed');return samples[Math.min(i++,2)]},{holdGuardMs:25});try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:03.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:03.000Z'});assert(c.ok);startBegan=Date.now();assert.equal((s.v.guardedStart(TOKEN,startInput()) as any).stop,'STALE_PACKET');assert.equal((s.v.inspect(TOKEN,'d1') as any).value.start_intent_digest,null)}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('completed and uncertain observations carry outcome-specific digests',()=>{
  const completed=admitted();try{const r=completed.s.v.guardedStart(TOKEN,startInput());assert(r.ok);assert.equal(r.value.result.outcome,'completed');assert.deepEqual(r.value.observation,{operationId:'observe_fixed_payload',payload:'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1'});assert.deepEqual(r.value.result.observationDigest,{algorithm:'sha256',canonicalization:'json-rfc8785-jcs',domain:`${PROFILE_ID}.observation.0.1-candidate`,value:OBSERVATION_DIGEST_VALUE})}finally{completed.s.v.close();rmSync(completed.s.dir,{recursive:true})}
  const s=setup('uncertain',undefined,{uncertainObservation:true});const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const c=s.v.admitClaim(TOKEN,claim(d.value));assert(c.ok);try{const r=s.v.guardedStart(TOKEN,startInput());assert.equal((r as any).stop,'HUMAN_DECISION_REQUIRED');const db=new Database(s.dbPath);const result=JSON.parse((db.prepare("select record_json from local_owner_records where kind='start-result'").get() as any).record_json);db.close();assert.equal(result.outcome,'uncertain');assert.equal(result.observationDigest,null);assert.equal((s.v.guardedStart(TOKEN,startInput()) as any).stop,'HUMAN_DECISION_REQUIRED')}finally{s.v.close();rmSync(s.dir,{recursive:true})}
})

test('production surfaces cannot import the candidate verifier',()=>{const files:string[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir)){const file=path.join(dir,name);if(file.includes(`${path.sep}local-owner`))continue;const stat=statSync(file);if(stat.isDirectory())walk(file);else if(/\.(ts|tsx|mjs)$/.test(name))files.push(file)}};walk(path.resolve('app'));walk(path.resolve('src'));for(const file of files){const source=readFileSync(file,'utf8');assert.equal(/(?:from|import\()\s*['"][^'"]*local-owner/.test(source)||source.includes('LocalOwnerVerifier'),false,file)}})

test('owner-admitted store rejects aliases drift unsafe paths and incomplete writer inventory',()=>{
  const make=(writers=[candidateWriter])=>{const dir=mkdtempSync(path.join(tmpdir(),'lo-admission-'));const admission=bootstrapOwnerAdmittedStore({dbPath:path.join(dir,'store.db'),configGeneration:'admission-generation-1',writers,approvedFilesystemTypes:[filesystemType(dir)]});return{dir,admission}}
  const unsupportedDir=mkdtempSync(path.join(tmpdir(),'lo-unsupported-fs-'));try{assert.throws(()=>bootstrapOwnerAdmittedStore({dbPath:path.join(unsupportedDir,'store.db'),configGeneration:'g',writers:[candidateWriter],approvedFilesystemTypes:['not-this-filesystem']}),/filesystem type is not owner-approved/)}finally{rmSync(unsupportedDir,{recursive:true})}
  const configFor=(admission:any,dbPath=admission.canonicalPath)=>({dbPath,storeAdmission:admission,issuerId:'fixture-issuer',actorId:'fixture-human',credential:TOKEN,selectedProfile:{id:PROFILE_ID,version:PROFILE_VERSION,status:'active',pin:PIN},trustedHumanDecisions:[base()]})
  const relative=make();try{assert.throws(()=>new LocalOwnerVerifier(configFor(relative.admission,path.relative(process.cwd(),relative.admission.canonicalPath))),/normal startup requires/)}finally{rmSync(relative.dir,{recursive:true})}
  const symlink=make(),symlinkTarget=make();try{const alias=path.join(path.dirname(symlink.admission.canonicalPath),'alias.db');symlinkSync(symlink.admission.canonicalPath,alias);unlinkSync(alias);symlinkSync(symlinkTarget.admission.canonicalPath,alias);assert.throws(()=>new LocalOwnerVerifier(configFor(symlink.admission,alias)),/canonical admitted path/)}finally{rmSync(symlink.dir,{recursive:true});rmSync(symlinkTarget.dir,{recursive:true})}
  const hardlink=make();try{const alias=path.join(path.dirname(hardlink.admission.canonicalPath),'hard.db');linkSync(hardlink.admission.canonicalPath,alias);assert.throws(()=>new LocalOwnerVerifier(configFor(hardlink.admission,alias)),/canonical admitted path/)}finally{rmSync(hardlink.dir,{recursive:true})}
  const distinctA=make(),distinctB=make();try{assert.throws(()=>new LocalOwnerVerifier(configFor(distinctA.admission,distinctB.admission.canonicalPath)),/canonical admitted path/)}finally{rmSync(distinctA.dir,{recursive:true});rmSync(distinctB.dir,{recursive:true})}
  const missing=make();try{assert.throws(()=>new LocalOwnerVerifier(configFor({...missing.admission,canonicalPath:path.join(path.dirname(missing.admission.canonicalPath),'missing.db')},path.join(path.dirname(missing.admission.canonicalPath),'missing.db'))),/existing pinned/)}finally{rmSync(missing.dir,{recursive:true})}
  const drift=make();try{assert.throws(()=>new LocalOwnerVerifier(configFor({...drift.admission,databaseId:'00000000-0000-4000-8000-000000000000'})),/persistent database identity|canonical guard/);assert.throws(()=>new LocalOwnerVerifier(configFor({...drift.admission,configGeneration:'stale-generation'})),/persistent database identity/);assert.throws(()=>new LocalOwnerVerifier(configFor({...drift.admission,filesystemType:'unsupported'})),/physical identity/)}finally{rmSync(drift.dir,{recursive:true})}
  const replaced=make();try{const old=`${replaced.admission.canonicalPath}.old`;renameSync(replaced.admission.canonicalPath,old);copyFileSync(old,replaced.admission.canonicalPath);assert.throws(()=>new LocalOwnerVerifier(configFor(replaced.admission)),/physical identity drifted/)}finally{rmSync(replaced.dir,{recursive:true})}
  const locking=make();try{const raw=new Database(locking.admission.canonicalPath);raw.pragma('journal_mode = DELETE');raw.close();assert.throws(()=>new LocalOwnerVerifier(configFor(locking.admission)),/journal posture changed/)}finally{rmSync(locking.dir,{recursive:true})}
  const schemaDrift=make();try{const raw=new Database(schemaDrift.admission.canonicalPath);raw.exec('DROP TABLE consumption_receipts');raw.close();assert.throws(()=>new LocalOwnerVerifier(configFor(schemaDrift.admission)),/schema generation changed/)}finally{rmSync(schemaDrift.dir,{recursive:true})}
  const incomplete=make([candidateWriter,legacyWriter]);try{assert.throws(()=>new LocalOwnerVerifier(configFor(incomplete.admission)),/writer inventory is missing/);for(const writer of [{...legacyWriter,role:'unknown'},{...legacyWriter,version:'stale'},{...legacyWriter,insertionPath:'direct-sql'}])assert.throws(()=>new ConsumptionStore(incomplete.admission.canonicalPath,{admission:incomplete.admission,writer}),/unapproved/);assert.throws(()=>new ConsumptionStore(incomplete.admission.canonicalPath),/approved writer configuration/)}finally{rmSync(incomplete.dir,{recursive:true})}
  const unsafe=make();try{assert.throws(()=>new LocalOwnerVerifier(configFor(unsafe.admission,':memory:')),/existing pinned/);assert.throws(()=>new LocalOwnerVerifier(configFor(unsafe.admission,`file:${unsafe.admission.canonicalPath}?vfs=unix-none`)),/existing pinned/)}finally{rmSync(unsafe.dir,{recursive:true})}
})

test('evidence integrity never marks a case observed without its passing receipt',()=>{assert.equal(EVIDENCE_INTEGRITY_DEFECT,'EVIDENCE_INTEGRITY — proof observed labels outran test bodies');const result=deriveProofInventory([{id:'passed-case',expected:'pass'},{id:'failed-case',expected:'deny'},{id:'missing-case',expected:'unknown'}],[{id:'passed-case',test:'exact assertion',status:'passed'},{id:'failed-case',test:'failed assertion',status:'failed'}]);assert.deepEqual(result.map(x=>[x.id,x.status]),[['passed-case','observed'],['failed-case','uncovered'],['missing-case','uncovered']]);assert.throws(()=>deriveProofInventory([{id:'known',expected:'x'}],[{id:'invented',test:'bad label',status:'passed'}]),/UNKNOWN_FIXTURE_RECEIPT/)})

test('unavailable database returns a typed denial from every mutation', () => {
  const a = admitted()
  a.s.v.close()
  try {
    for (const operation of [
      () => a.s.v.recordDecision(TOKEN, decision()),
      () => a.s.v.admitClaim(TOKEN, claim(a.d)),
      () => a.s.v.revoke(TOKEN, 'd1', 'claim'),
      () => a.s.v.guardedStart(TOKEN, startInput()),
    ]) {
      assert.equal((operation() as any).stop, 'ENVIRONMENT_BLOCKED')
    }
  } finally { rmSync(a.s.dir, { recursive: true }) }
})
