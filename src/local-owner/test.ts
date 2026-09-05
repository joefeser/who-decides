import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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

const TOKEN='synthetic-fixture-credential-0001'
const PIN='bc02b5972c2ac1184637062b3dabf7a655ae442cb6fa22940d8d119f678483ec'
const CASES:Record<string,string[]>={
  'JCS known vectors and profile selection':['digest-known-answer-and-domain-mismatch','profile-declaration-status'],
  'authentication precedes disclosure and human act/base companion binding':['missing-or-wrong-authentication','authenticated-without-human-act','unrelated-or-reused-human-act','base-decision-companion-digest'],
  'fixed action, expiry and exact claim replay bindings':['unsupported-action-or-parameter','changed-binding-replay','exact-claim-retry'],
  'issuer namespace is separate while legacy decision id blocks without rewrite':['same-id-different-issuer','legacy-id-collision'],
  'happy guarded start persists intent/result and never reexecutes':['authenticated-happy-path','completed-start-replay','observation-digest-completed-or-uncertain'],
  'status revocation fails closed and remains terminal':['claim-revoked-decision-active','revoked-status-reset','revocation-before-handoff'],
  'status corruption and missing durable readback deny observation':['missing-or-corrupt-durable-readback','absent-or-corrupt-status','status-gap-fork-truncation-or-wrong-head'],
  'clock rollback, expiry at handoff and uncertain observation retain intent':['clock-rollback-or-unknown-time','expiry-between-intent-and-handoff'],
  'monotonic deadline denies a stalled wall clock at equality':['wall-clock-stall-crosses-monotonic-deadline'],
  'all five closed candidate record schemas validate emitted records and exact digest domains':['closed-base-record-remains-unchanged'],
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
  'uncertain observation persists uncertainty and forbids retry':['lost-response-or-ambiguous-observation'],
  'unavailable database returns a typed denial from every mutation':['store-unavailable'],
  'production surfaces cannot import the candidate verifier':['unsupported-surface-no-fallback'],
}
function test(name:string,fn:()=>void|Promise<void>){nodeTest(name,async()=>{await fn();const output=process.env.LOCAL_OWNER_CASE_RECEIPTS;if(output)for(const id of CASES[name]??[])appendFileSync(output,JSON.stringify({id,test:name,status:'passed'})+'\n')})}
const base=(decisionId='d1',packet='packet-1')=>({hacp_version:'v0.1-draft',record_kind:'hacp.human_decision_gate',decision_id:`human-${decisionId}`,packet_id:packet,profile_id:'hacp-base-draft',profile_version:'v0.1-draft',decision_matrix_version:'0.1',from_status:'approved',to_status:'in_progress',decision:'start_work',reason:'fixture human start act',created_at:'2026-09-05T00:00:00.000Z',actor_id:'fixture-human',actor_kind:'human',actor_verification_source:'signed_human_attestation',authentication_context:{interaction_channel:'cli',auth_event_ref:`event-${decisionId}`,secret_material_present:false},forbidden_effects_confirmed:[],evidence:[`candidate-decision:${decisionId}`,`candidate-action:${recordDigest('action',FIXED_ACTION as any).value}`]})
function setup(issuer='fixture-issuer',clock?:()=>{wallTime:string,monotonicNanoseconds:string},testConfig:Record<string,unknown>={},trustedHumanDecisions=[base(),base('legacy','packet-legacy')]){const dir=mkdtempSync(path.join(tmpdir(),'lo-'));const dbPath=path.join(dir,'store.db');const test=clock||Object.keys(testConfig).length?{...testConfig,...(clock?{clock}:{})}:undefined;const config={dbPath,issuerId:issuer,actorId:'fixture-human',credential:TOKEN,selectedProfile:{id:PROFILE_ID,version:PROFILE_VERSION,status:'active',pin:PIN},trustedHumanDecisions,test};return{dir,dbPath,config,v:new LocalOwnerVerifier(config as any)}}
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
test('authentication precedes disclosure and human act/base companion binding',()=>{const s=setup();try{assert.deepEqual(s.v.inspect('wrong','missing'),{ok:false,stop:'MISSING_AUTHORITY',detail:'access denied'});for(const mutate of [(x:any)=>{x.humanEventRef='caller-invented'},(x:any)=>{x.baseDecisionRef='untrusted-packet'},(x:any)=>{x.baseDecisionDigest.value='0'.repeat(64)},(x:any)=>{x.issuerId='forged'}]){const x:any=structuredClone(decision());mutate(x);const r=s.v.recordDecision(TOKEN,x);assert.equal(r.ok,false)}assert.equal(s.v.inspect(TOKEN,'d1').ok,false);const noAct=new LocalOwnerVerifier({...s.config,issuerId:'no-act',trustedHumanDecisions:[]});assert.equal((noAct.recordDecision(TOKEN,decision()) as any).stop,'MISSING_AUTHORITY');noAct.close()}finally{s.v.close();rmSync(s.dir,{recursive:true})}})
test('fixed action, expiry and exact claim replay bindings',()=>{const s=setup();try{const bad:any=decision();bad.action={...FIXED_ACTION,parameters:{payload:'evil'}};assert.equal((s.v.recordDecision(TOKEN,bad) as any).stop,'SCOPE_CONFLICT');const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const ci=claim(d.value);assert.equal((s.v.admitClaim(TOKEN,{...ci,decisionDigest:{...ci.decisionDigest,domain:'wrong'}}) as any).stop,'SCOPE_CONFLICT');const c=s.v.admitClaim(TOKEN,ci);assert(c.ok);assert.equal((s.v.admitClaim(TOKEN,ci) as any).value.digest.value,(c.value.digest as any).value);for(const key of ['successorId','attemptKey','requestRef'] as const){const changed={...ci,[key]:'changed'};assert.equal((s.v.admitClaim(TOKEN,changed) as any).stop,'SCOPE_CONFLICT')}assert.equal((s.v.admitClaim(TOKEN,{...ci,claimId:'c2'}) as any).stop,'SCOPE_CONFLICT')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})
test('issuer namespace is separate while legacy decision id blocks without rewrite',()=>{const s=setup('issuer-a');try{new ConsumptionStore(s.dbPath).claim({decisionId:'legacy',chosenOption:'x',rationale:'x',decidedAt:'2026-09-05T00:00:00.000Z',decisionRequestId:'r',permittedAction:'x'},'old');const db=new Database(s.dbPath);const bytes=(db.prepare('select receipt_json from consumption_receipts where decision_id=?').get('legacy') as any).receipt_json;db.close();assert.equal((s.v.recordDecision(TOKEN,decision('legacy')) as any).stop,'MISSING_AUTHORITY');const db2=new Database(s.dbPath);assert.equal((db2.prepare('select receipt_json from consumption_receipts where decision_id=?').get('legacy') as any).receipt_json,bytes);db2.close();const other=new LocalOwnerVerifier({...s.config,issuerId:'issuer-b'});assert(other.recordDecision(TOKEN,decision()).ok);other.close()}finally{s.v.close();rmSync(s.dir,{recursive:true})};const reverse=setup();try{assert(reverse.v.recordDecision(TOKEN,decision()).ok);const legacy=new ConsumptionStore(reverse.dbPath);const r=legacy.claim({decisionId:'d1',chosenOption:'x',rationale:'x',decidedAt:'2026-09-05T00:00:00.000Z',decisionRequestId:'r',permittedAction:'x'},'old');assert.equal(r.status,'rejected');if(r.status==='rejected')assert.equal(r.reason,'profile_slot_conflict');legacy.close()}finally{reverse.v.close();rmSync(reverse.dir,{recursive:true})}})
test('happy guarded start persists intent/result and never reexecutes',()=>{const a=admitted();try{const input={decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION};const r=a.s.v.guardedStart(TOKEN,input);assert(r.ok);assert.deepEqual(r.value.observation,{operationId:'observe_fixed_payload',payload:'HACP_LOCAL_OWNER_CONTINUATION_PROBE_V1'});assert.equal(r.value.result.observationDigest.value,OBSERVATION_DIGEST_VALUE);assert.equal(r.value.intent.admittedAt,r.value.intent.clockSample.wallTime);assert.equal(r.value.result.observedAt,r.value.result.observationClockSample.wallTime);assert.equal((a.s.v.guardedStart(TOKEN,input) as any).stop,'HUMAN_DECISION_REQUIRED')}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})
test('status revocation fails closed and remains terminal',()=>{const b=admitted();try{assert(b.s.v.revoke(TOKEN,'d1','claim').ok);assert.equal((b.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION}) as any).stop,'STALE_PACKET');assert.equal((b.s.v.revoke(TOKEN,'d1','claim') as any).stop,'STALE_PACKET')}finally{b.s.v.close();rmSync(b.s.dir,{recursive:true})}})
test('status corruption and missing durable readback deny observation',()=>{for(const sql of ["delete from local_owner_records where kind='claim'","update local_owner_records set record_json='{' where kind='claim'","update local_owner_records set record_json=json_set(record_json,'$.digest.domain','wrong') where kind='claim'","update local_owner_slots set claim_status_head='bad'","update local_owner_status set record_json='{' where target_kind='claim'","update local_owner_status set record_json=json_set(record_json,'$.digest.domain','wrong') where target_kind='claim'","update local_owner_status set sequence=4 where target_kind='claim'","delete from local_owner_status where target_kind='claim'","insert into local_owner_status select issuer_id,decision_id,target_kind,sequence+1,digest,record_json from local_owner_status where target_kind='claim'"]){const a=admitted();try{new Database(a.s.dbPath).exec(sql);const r=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal(r.ok,false);assert(['UNVERIFIED_ASSUMPTION','MISSING_AUTHORITY'].includes((r as any).stop))}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}}})
test('clock rollback, expiry at handoff and uncertain observation retain intent',()=>{for(const samples of [[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'2'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'4'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'3'}],[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'2'},{wallTime:'2098-01-01T00:00:00.000Z',monotonicNanoseconds:'3'},{wallTime:'2100-01-01T00:00:00.000Z',monotonicNanoseconds:'4'}]]){let i=0;const a=admitted(setup('fixture-issuer',()=>samples[Math.min(i++,samples.length-1)]));try{const r=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal(r.ok,false);assert.equal((a.s.v.inspect(TOKEN,'d1') as any).value.start_intent_digest!==null,true)}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}}})

test('monotonic deadline denies a stalled wall clock at equality',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1000000000'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'2000000000'},{wallTime:'2026-09-05T00:00:02.000Z',monotonicNanoseconds:'5000000000'}];let i=0;const s=setup('fixture-issuer',()=>samples[Math.min(i++,3)]);try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:06.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:05.000Z'});assert(c.ok);const r=s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert.equal((r as any).stop,'STALE_PACKET')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('all five closed candidate record schemas validate emitted records and exact digest domains',()=>{const a=admitted();try{const start=a.s.v.guardedStart(TOKEN,{decisionId:'d1',claimId:'c1',intentId:'i1',successorId:'successor-1',action:FIXED_ACTION});assert(start.ok);const db=new Database(a.s.dbPath,{readonly:true});const rows=db.prepare('select kind,record_json from local_owner_records').all() as any[];const statuses=db.prepare('select record_json from local_owner_status').all() as any[];db.close();const ajv=new Ajv2020({strict:false});addFormats(ajv);for(const kind of ['decision','claim','status-event','start-intent','start-result']){const schema=JSON.parse(readFileSync(path.resolve(`schemas/local-owner/${kind}.schema.json`),'utf8'));const validate=ajv.compile(schema);const records=kind==='status-event'?statuses.map(x=>JSON.parse(x.record_json)):rows.filter(x=>x.kind===kind).map(x=>JSON.parse(x.record_json));assert(records.length>0,kind);for(const record of records){assert(validate(record),`${kind}: ${ajv.errorsText(validate.errors)}`);const wrong:any=structuredClone(record);wrong.digest.domain='wrong';assert.equal(validate(wrong),false,`${kind} own digest domain`)}}for(const [kind,field] of [['decision','baseDecisionDigest'],['claim','decisionDigest'],['start-intent','claimDigest'],['start-result','intentDigest']] as const){const schema=JSON.parse(readFileSync(path.resolve(`schemas/local-owner/${kind}.schema.json`),'utf8'));const validator=new Ajv2020({strict:false});addFormats(validator);const validate=validator.compile(schema);const record=rows.find(x=>x.kind===kind);assert(record);const wrong=JSON.parse(record.record_json);wrong[field].domain='wrong';assert.equal(validate(wrong),false,`${kind} ${field} domain`)}const resultSchema=JSON.parse(readFileSync(path.resolve('schemas/local-owner/start-result.schema.json'),'utf8'));const resultAjv=new Ajv2020({strict:false});addFormats(resultAjv);const validateResult=resultAjv.compile(resultSchema),completed=JSON.parse(rows.find(x=>x.kind==='start-result').record_json);completed.observationDigest=null;assert.equal(validateResult(completed),false);completed.outcome='uncertain';completed.observationDigest={algorithm:'sha256',canonicalization:'json-rfc8785-jcs',domain:`${PROFILE_ID}.observation.0.1-candidate`,value:OBSERVATION_DIGEST_VALUE};assert.equal(validateResult(completed),false)}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})

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
    for (const input of [{ ...startInput(), action: undefined }, { ...startInput(), recovery: true }]) {
      const result = a.s.v.guardedStart(TOKEN, input as any)
      assert.equal(result.ok, false)
      assert.equal((a.s.v.inspect(TOKEN, 'd1') as any).value.start_intent_digest, null)
    }
  } finally { a.s.v.close(); rmSync(a.s.dir, { recursive: true }) }
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

test('invalid base transition is rejected before candidate mutation',()=>{const human={...base(),from_status:'draft'};const s=setup('bad-transition',undefined,{},[human]);try{const r=s.v.recordDecision(TOKEN,decision());assert.equal((r as any).stop,'MISSING_AUTHORITY');assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('caller cannot override configured actor or issuer',()=>{const s=setup();try{for(const field of ['actorId','issuerId']){const input:any=decision();input[field]='caller-forged';assert.equal((s.v.recordDecision(TOKEN,input) as any).stop,'MISSING_AUTHORITY')}assert.equal((s.v.inspect(TOKEN,'d1') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('decision and claim expiry are independently enforced',()=>{for(const variant of ['decision','claim'] as const){const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:03.000Z',monotonicNanoseconds:'2'}];let i=0;const s=setup(`expiry-${variant}`,()=>samples[Math.min(i++,2)]);try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:variant==='decision'?'2026-09-05T00:00:03.000Z':'2026-09-05T00:00:06.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:03.000Z'});assert(c.ok);const r=s.v.guardedStart(TOKEN,startInput());assert.equal((r as any).stop,'STALE_PACKET');const db=new Database(s.dbPath);const states=db.prepare("select target_kind,record_json from local_owner_status where sequence=0").all() as any[];db.close();assert(states.every(x=>JSON.parse(x.record_json).state==='active'))}finally{s.v.close();rmSync(s.dir,{recursive:true})}}})

test('decision revocation blocks an otherwise active claim',()=>{const a=admitted();try{assert(a.s.v.revoke(TOKEN,'d1','decision').ok);assert.equal((a.s.v.guardedStart(TOKEN,startInput()) as any).stop,'STALE_PACKET');const db=new Database(a.s.dbPath);const claimStatus=JSON.parse((db.prepare("select record_json from local_owner_status where target_kind='claim' order by sequence desc limit 1").get() as any).record_json);db.close();assert.equal(claimStatus.state,'active')}finally{a.s.v.close();rmSync(a.s.dir,{recursive:true})}})

test('missing and malformed expiry fail for decision and claim admission',()=>{for(const target of ['decision','claim'] as const)for(const value of [undefined,'not-a-time']){const s=setup(`expiry-input-${target}-${String(value)}`);try{if(target==='decision'){const input:any=decision();if(value===undefined)delete input.expiresAt;else input.expiresAt=value;assert.equal(s.v.recordDecision(TOKEN,input).ok,false)}else{const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const input:any=claim(d.value);if(value===undefined)delete input.expiresAt;else input.expiresAt=value;assert.equal(s.v.admitClaim(TOKEN,input).ok,false)}assert.equal((s.v.inspect(TOKEN,'missing') as any).stop,'MISSING_AUTHORITY')}finally{s.v.close();rmSync(s.dir,{recursive:true})}}})

test('claim expiry cannot exceed decision expiry',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'}];let i=0;const s=setup('claim-deadline',()=>samples[Math.min(i++,1)]);try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:05.000Z'});assert(d.ok);const r=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:06.000Z'});assert.equal(r.ok,false);assert.equal((s.v.inspect(TOKEN,'d1') as any).value.claim_digest,null)}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('expiry is sampled after serialization guard wait',()=>{const samples=[{wallTime:'2026-09-05T00:00:00.000Z',monotonicNanoseconds:'0'},{wallTime:'2026-09-05T00:00:01.000Z',monotonicNanoseconds:'1'},{wallTime:'2026-09-05T00:00:03.000Z',monotonicNanoseconds:'2'}];let i=0,startBegan=0;const s=setup('post-wait-expiry',()=>{if(i===2)assert(Date.now()-startBegan>=20,'start clock sampled before guarded wait completed');return samples[Math.min(i++,2)]},{holdGuardMs:25});try{const d=s.v.recordDecision(TOKEN,{...decision(),expiresAt:'2026-09-05T00:00:03.000Z'});assert(d.ok);const c=s.v.admitClaim(TOKEN,{...claim(d.value),expiresAt:'2026-09-05T00:00:03.000Z'});assert(c.ok);startBegan=Date.now();assert.equal((s.v.guardedStart(TOKEN,startInput()) as any).stop,'STALE_PACKET');assert.equal((s.v.inspect(TOKEN,'d1') as any).value.start_intent_digest,null)}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('uncertain observation persists uncertainty and forbids retry',()=>{const s=setup('uncertain',undefined,{uncertainObservation:true});const d=s.v.recordDecision(TOKEN,decision());assert(d.ok);const c=s.v.admitClaim(TOKEN,claim(d.value));assert(c.ok);try{const r=s.v.guardedStart(TOKEN,startInput());assert.equal((r as any).stop,'HUMAN_DECISION_REQUIRED');const db=new Database(s.dbPath);const result=JSON.parse((db.prepare("select record_json from local_owner_records where kind='start-result'").get() as any).record_json);db.close();assert.equal(result.outcome,'uncertain');assert.equal(result.observationDigest,null);assert.equal((s.v.guardedStart(TOKEN,startInput()) as any).stop,'HUMAN_DECISION_REQUIRED')}finally{s.v.close();rmSync(s.dir,{recursive:true})}})

test('production surfaces cannot import the candidate verifier',()=>{const files:string[]=[];const walk=(dir:string)=>{for(const name of readdirSync(dir)){const file=path.join(dir,name);if(file.includes(`${path.sep}local-owner`))continue;const stat=statSync(file);if(stat.isDirectory())walk(file);else if(/\.(ts|tsx|mjs)$/.test(name))files.push(file)}};walk(path.resolve('app'));walk(path.resolve('src'));for(const file of files){const source=readFileSync(file,'utf8');assert.equal(/(?:from|import\()\s*['"][^'"]*local-owner/.test(source)||source.includes('LocalOwnerVerifier'),false,file)}})

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
