import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { assertValid } from '../artifacts/schemas'
import { FIXED_ACTION, FIXED_OBSERVATION, OBSERVATION_DIGEST_VALUE, type BaseDecision, type CandidateResult, type CandidateStop, type ClaimInput, type ClockSample, type DecisionInput, type StartInput } from './contracts'
import { PROFILE_ID, PROFILE_VERSION, digestEnvelope, equalJcs, recordDigest, type Digest } from './jcs'

export type VerifierConfig = {
  dbPath: string, issuerId: string, actorId: string, credential: string,
  selectedProfile: { id: string, version: string, status: string, pin: string },
  trustedHumanDecisions?: BaseDecision[],
  test?: { clock?: () => ClockSample, holdGuardMs?: number, waitGuardMs?: number, crashAfterIntent?: boolean, uncertainObservation?: boolean },
}
export const APPROVED_PROFILE_PIN = 'bc02b5972c2ac1184637062b3dabf7a655ae442cb6fa22940d8d119f678483ec'
const PROCESS_SESSION_ID = randomUUID()
const ok = <T>(value: T): CandidateResult<T> => ({ ok: true, value })
const stop = (kind: CandidateStop, detail: string): CandidateResult<never> => ({ ok: false, stop: kind, detail })
const timestamp = (value: string): number => /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value ? Date.parse(value) : Number.NaN
const canonicalNs = (value: string) => /^(0|[1-9][0-9]*)$/.test(value)
const sleep = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const nonEmpty = (values: Array<string | undefined>) => values.every(value => typeof value === 'string' && value.length > 0)
const digestMatches = (actual: unknown, expected: Digest) => { try { return equalJcs(actual, expected) } catch { return false } }

export class LocalOwnerVerifier {
  private readonly db: Database.Database
  private readonly credentialHash: Buffer
  private lastMonotonic: bigint | null = null

  constructor(private readonly config: VerifierConfig) {
    if (!config.issuerId || !config.actorId || config.credential.length < 16) throw new Error('INVALID_OWNER_CONFIGURATION')
    if (config.selectedProfile.id !== PROFILE_ID || config.selectedProfile.version !== PROFILE_VERSION
      || config.selectedProfile.status !== 'active' || config.selectedProfile.pin !== APPROVED_PROFILE_PIN) throw new Error('PROFILE_NOT_SELECTED')
    mkdirSync(path.dirname(config.dbPath), { recursive: true })
    this.db = new Database(config.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.credentialHash = createHash('sha256').update(config.credential).digest()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_owner_slots (
        issuer_id TEXT NOT NULL, decision_id TEXT NOT NULL, decision_digest TEXT NOT NULL,
        claim_digest TEXT, claim_session TEXT, decision_status_head TEXT, claim_status_head TEXT,
        start_intent_digest TEXT, PRIMARY KEY (issuer_id, decision_id));
      CREATE TABLE IF NOT EXISTS local_owner_records (
        issuer_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, decision_id TEXT NOT NULL,
        digest TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (issuer_id, kind, record_id));
      CREATE TABLE IF NOT EXISTS local_owner_status (
        issuer_id TEXT NOT NULL, decision_id TEXT NOT NULL, target_kind TEXT NOT NULL,
        sequence INTEGER NOT NULL, digest TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY (issuer_id, decision_id, target_kind, sequence));
      CREATE TABLE IF NOT EXISTS local_owner_clock (issuer_id TEXT PRIMARY KEY, wall_time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_owner_human_acts (
        issuer_id TEXT NOT NULL, event_ref TEXT NOT NULL, packet_ref TEXT NOT NULL,
        digest TEXT NOT NULL, record_json TEXT NOT NULL, used_by_decision TEXT,
        PRIMARY KEY (issuer_id, event_ref), UNIQUE (issuer_id, packet_ref));
    `)
    this.installTrustedHumanDecisions(config.trustedHumanDecisions ?? [])
  }

  close() { this.db.close() }
  private installTrustedHumanDecisions(decisions: BaseDecision[]) {
    const insert=this.db.prepare('INSERT OR IGNORE INTO local_owner_human_acts VALUES (?,?,?,?,?,NULL)')
    this.db.transaction(()=>{for(const decision of decisions){assertValid('human-decision',decision)
      if(typeof decision.decision_id!=='string'||typeof decision.packet_id!=='string'||decision.actor_id!==this.config.actorId||decision.actor_kind!=='human'||decision.actor_verification_source!=='signed_human_attestation')throw new Error('INVALID_TRUSTED_HUMAN_DECISION')
      const digest=digestEnvelope(`${PROFILE_ID}.base-decision-reference.0.1-candidate`,decision)
      insert.run(this.config.issuerId,decision.decision_id,decision.packet_id,digest.value,JSON.stringify(decision))
      const stored=this.db.prepare('SELECT packet_ref,digest,record_json FROM local_owner_human_acts WHERE issuer_id=? AND event_ref=?').get(this.config.issuerId,decision.decision_id) as any
      if(stored.packet_ref!==decision.packet_id||stored.digest!==digest.value||stored.record_json!==JSON.stringify(decision))throw new Error('TRUSTED_HUMAN_DECISION_CONFLICT')
    }})()
  }
  private authenticate(token: string): boolean {
    const supplied = createHash('sha256').update(token ?? '').digest()
    return timingSafeEqual(supplied, this.credentialHash)
  }
  private guarded<T>(token: string, decisionId: string, operation: () => CandidateResult<T>): CandidateResult<T> {
    if (!this.authenticate(token)) return stop('MISSING_AUTHORITY', 'access denied')
    const lockPath = `${this.config.dbPath}.${createHash('sha256').update(`${this.config.issuerId}\0${decisionId}`).digest('hex')}.guard`
    let descriptor: number | undefined
    const deadline = Date.now() + (this.config.test?.waitGuardMs ?? 0)
    do { try { descriptor = openSync(lockPath, 'wx'); break } catch { if (Date.now() >= deadline) break; sleep(5) } } while (true)
    if (descriptor === undefined) return stop('ENVIRONMENT_BLOCKED', 'serialization guard unavailable; it is never reclaimed automatically')
    writeSync(descriptor, randomBytes(16))
    try { if (this.config.test?.holdGuardMs) sleep(this.config.test.holdGuardMs); return operation() }
    finally { closeSync(descriptor); unlinkSync(lockPath) }
  }
  private sampleClock(): CandidateResult<ClockSample> {
    try {
      const sample = this.config.test?.clock?.() ?? { wallTime: new Date().toISOString(), monotonicNanoseconds: process.hrtime.bigint().toString() }
      if (!exactKeys(sample as unknown as Record<string, unknown>, ['wallTime', 'monotonicNanoseconds'])
        || !Number.isFinite(timestamp(sample.wallTime)) || !canonicalNs(sample.monotonicNanoseconds)) return stop('UNVERIFIED_ASSUMPTION', 'invalid clock sample')
      const monotonic = BigInt(sample.monotonicNanoseconds)
      if (this.lastMonotonic !== null && monotonic < this.lastMonotonic) return stop('UNVERIFIED_ASSUMPTION', 'monotonic clock rollback')
      const prior = this.db.prepare('SELECT wall_time FROM local_owner_clock WHERE issuer_id = ?').get(this.config.issuerId) as { wall_time: string } | undefined
      if (prior && timestamp(sample.wallTime) < timestamp(prior.wall_time)) return stop('UNVERIFIED_ASSUMPTION', 'wall clock rollback')
      this.lastMonotonic = monotonic
      return ok(sample)
    } catch { return stop('UNVERIFIED_ASSUMPTION', 'clock unavailable') }
  }
  private persistClock(sample: ClockSample) {
    // The durable checkpoint only ever moves FORWARD: concurrent processes on
    // different decisions (whose filesystem guards do not serialize each
    // other) must not let a slower writer drag the accepted wall time
    // backwards (review P1). Fixed-format ISO-8601 Z strings order
    // lexicographically exactly as they do in time.
    this.db.prepare('INSERT INTO local_owner_clock VALUES(?,?) ON CONFLICT(issuer_id) DO UPDATE SET wall_time=excluded.wall_time WHERE excluded.wall_time>local_owner_clock.wall_time').run(this.config.issuerId,sample.wallTime)
  }
  private store(kind: string, id: string, decisionId: string, record: Record<string, unknown>) {
    const digest = recordDigest(kind, record); const complete = { ...record, digest }
    this.db.prepare('INSERT INTO local_owner_records VALUES (?, ?, ?, ?, ?, ?)').run(this.config.issuerId, kind, id, decisionId, digest.value, JSON.stringify(complete))
    return complete
  }
  private read(kind: string, id: string) {
    try { const row = this.db.prepare('SELECT digest, record_json FROM local_owner_records WHERE issuer_id=? AND kind=? AND record_id=?').get(this.config.issuerId, kind, id) as { digest: string, record_json: string } | undefined
      if (!row) return { kind:'missing' as const }
      const record = JSON.parse(row.record_json) as Record<string, unknown>
      const expected=recordDigest(kind,record);return expected.value===row.digest&&digestMatches(record.digest,expected)?{kind:'ok' as const,record}:{kind:'corrupt' as const}
    } catch { return {kind:'corrupt' as const} }
  }
  private appendStatus(decisionId: string, targetKind: 'decision' | 'claim', targetDigest: string, state: 'active' | 'revoked', at: string) {
    const rows = this.db.prepare('SELECT sequence,digest,record_json FROM local_owner_status WHERE issuer_id=? AND decision_id=? AND target_kind=? ORDER BY sequence').all(this.config.issuerId, decisionId, targetKind) as Array<{sequence:number,digest:string,record_json:string}>
    const parsed=rows.map(row=>JSON.parse(row.record_json) as Record<string,unknown>)
    if (rows.some((row, index) => { const expected=recordDigest('status-event',parsed[index]);return row.sequence!==index||expected.value!==row.digest||!digestMatches(parsed[index].digest,expected) })) throw new Error('CORRUPT_STATUS')
    const previous = rows.at(-1); if (previous && parsed.at(-1)?.state === 'revoked') throw new Error('REVOCATION_TERMINAL')
    const record: Record<string, unknown> = { recordKind:'status-event',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId,eventId:randomUUID(),targetKind,targetDigest,sequence:rows.length,previousDigest:previous?.digest??null,state,recordedAt:at,actorId:this.config.actorId }
    const digest = recordDigest('status-event', record); const complete={...record,digest}
    this.db.prepare('INSERT INTO local_owner_status VALUES (?,?,?,?,?,?)').run(this.config.issuerId,decisionId,targetKind,rows.length,digest.value,JSON.stringify(complete))
    this.db.prepare(`UPDATE local_owner_slots SET ${targetKind === 'decision' ? 'decision_status_head' : 'claim_status_head'}=? WHERE issuer_id=? AND decision_id=?`).run(digest.value,this.config.issuerId,decisionId)
    return complete
  }

  recordDecision(token: string, input: DecisionInput): CandidateResult<Record<string, unknown>> {
    return this.guarded(token, input?.decisionId ?? '', () => {
      if (!input || !exactKeys(input as unknown as Record<string, unknown>, ['decisionId','humanEventRef','baseDecisionRef','baseDecisionDigest','requestRef','action','approvedAt','expiresAt']) || !nonEmpty([input.decisionId,input.humanEventRef,input.baseDecisionRef,input.requestRef])) return stop('MISSING_AUTHORITY','missing or stripped candidate context')
      if (!equalJcs(input.action,FIXED_ACTION)) return stop('SCOPE_CONFLICT','unsupported action')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const clock=this.sampleClock();if(!clock.ok){this.db.exec('ROLLBACK');return clock}
        if(!Number.isFinite(timestamp(input.approvedAt))||!Number.isFinite(timestamp(input.expiresAt))||timestamp(input.approvedAt)>timestamp(clock.value.wallTime)||timestamp(input.expiresAt)<=timestamp(clock.value.wallTime)){this.db.exec('ROLLBACK');return stop('STALE_PACKET','invalid, future-approved or expired decision')}
        const trusted=this.db.prepare('SELECT packet_ref,digest,record_json,used_by_decision FROM local_owner_human_acts WHERE issuer_id=? AND event_ref=?').get(this.config.issuerId,input.humanEventRef) as any
        if(!trusted||trusted.packet_ref!==input.baseDecisionRef||trusted.used_by_decision!==null){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','missing, unrelated or reused trusted human act')}
        let base:Record<string,unknown>;try{base=JSON.parse(trusted.record_json);assertValid('human-decision',base)}catch{this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION','trusted human act is corrupt')}
        const evidence=base.evidence as unknown,expectedBase=digestEnvelope(`${PROFILE_ID}.base-decision-reference.0.1-candidate`,base)
        if(trusted.digest!==expectedBase.value||!digestMatches(input.baseDecisionDigest,expectedBase)||base.decision!=='start_work'||base.from_status!=='approved'||base.to_status!=='in_progress'||base.actor_kind!=='human'||base.actor_id!==this.config.actorId||base.packet_id!==input.baseDecisionRef||base.decision_id!==input.humanEventRef||!Array.isArray(evidence)||!evidence.includes(`candidate-decision:${input.decisionId}`)||!evidence.includes(`candidate-action:${recordDigest('action',FIXED_ACTION as unknown as Record<string,unknown>).value}`)){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','trusted human act does not bind this packet and action')}
        const legacyTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consumption_receipts'").get()
        if(legacyTable&&this.db.prepare('SELECT 1 FROM consumption_receipts WHERE decision_id=?').get(input.decisionId)){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','legacy decision-id collision')}
        if(this.db.prepare('SELECT 1 FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId)){this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT','decision slot exists')}
        const record:Record<string,unknown>={recordKind:'decision',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,humanEventRef:input.humanEventRef,baseDecisionRef:input.baseDecisionRef,baseDecisionDigest:input.baseDecisionDigest,requestRef:input.requestRef,action:FIXED_ACTION,approvedAt:input.approvedAt,expiresAt:input.expiresAt}
        const complete=this.store('decision',input.decisionId,input.decisionId,record);const digest=(complete.digest as Digest).value
        this.db.prepare('INSERT INTO local_owner_slots(issuer_id,decision_id,decision_digest) VALUES(?,?,?)').run(this.config.issuerId,input.decisionId,digest)
        this.appendStatus(input.decisionId,'decision',digest,'active',clock.value.wallTime)
        this.db.prepare('UPDATE local_owner_human_acts SET used_by_decision=? WHERE issuer_id=? AND event_ref=? AND used_by_decision IS NULL').run(input.decisionId,this.config.issuerId,input.humanEventRef)
        this.persistClock(clock.value);this.db.exec('COMMIT');return ok(complete)
      } catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION',String(error))}
    })
  }

  admitClaim(token:string,input:ClaimInput):CandidateResult<Record<string,unknown>>{
    return this.guarded(token,input?.decisionId??'',()=>{if(!input||!exactKeys(input as unknown as Record<string,unknown>,['decisionId','decisionDigest','claimId','attemptKey','successorId','requestRef','action','claimedAt','expiresAt'])||!nonEmpty([input.decisionId,input.claimId,input.attemptKey,input.successorId,input.requestRef]))return stop('MISSING_AUTHORITY','missing claim context');if(!equalJcs(input.action,FIXED_ACTION))return stop('SCOPE_CONFLICT','unsupported action')
      this.db.exec('BEGIN IMMEDIATE');try{
        const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any;if(!slot){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','missing decision')}
        if(slot.claim_digest){const old=this.read('claim',input.claimId);if(old.kind==='corrupt'){this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION','claim readback corrupt')}if(old.kind==='missing'){this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT','slot already consumed')}const candidate={recordKind:'claim',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,...input};const result=recordDigest('claim',candidate).value===slot.claim_digest?ok(old.record):stop('SCOPE_CONFLICT','changed binding replay');this.db.exec('ROLLBACK');return result}
        const read=this.read('decision',input.decisionId);if(read.kind!=='ok'){this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION','decision readback missing or corrupt')}const decision=read.record
        const expected=recordDigest('decision',decision),clock=this.sampleClock();if(!clock.ok){this.db.exec('ROLLBACK');return clock}
        if(!digestMatches(input.decisionDigest,expected)||expected.value!==slot.decision_digest||input.requestRef!==decision.requestRef||!Number.isFinite(timestamp(input.claimedAt))||!Number.isFinite(timestamp(input.expiresAt))||timestamp(input.claimedAt)>timestamp(clock.value.wallTime)||timestamp(input.expiresAt)>timestamp(decision.expiresAt as string)||timestamp(input.expiresAt)<=timestamp(clock.value.wallTime)){this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT','claim bindings invalid, future-claimed or expired')}
        const record={recordKind:'claim',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,...input};const complete=this.store('claim',input.claimId,input.decisionId,record);const digest=(complete.digest as Digest).value;this.db.prepare('UPDATE local_owner_slots SET claim_digest=?,claim_session=? WHERE issuer_id=? AND decision_id=?').run(digest,PROCESS_SESSION_ID,this.config.issuerId,input.decisionId);this.appendStatus(input.decisionId,'claim',digest,'active',clock.value.wallTime);this.persistClock(clock.value);this.db.exec('COMMIT');return ok(complete)
      }catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION',String(error))}})
  }
  revoke(token:string,decisionId:string,targetKind:'decision'|'claim'):CandidateResult<Record<string,unknown>>{return this.guarded(token,decisionId,()=>{this.db.exec('BEGIN IMMEDIATE');try{const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,decisionId) as any;if(!slot){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','missing target')}const targetDigest=targetKind==='decision'?slot.decision_digest:slot.claim_digest;if(!targetDigest){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','missing target')}const clock=this.sampleClock();if(!clock.ok){this.db.exec('ROLLBACK');return clock}const result=this.appendStatus(decisionId,targetKind,targetDigest,'revoked',clock.value.wallTime);this.persistClock(clock.value);this.db.exec('COMMIT');return ok(result)}catch{if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('STALE_PACKET','revocation is terminal or corrupt')}})}
  private currentStatus(slot:any,decisionId:string,targetKind:'decision'|'claim'){
    const targetDigest=targetKind==='decision'?slot.decision_digest:slot.claim_digest,head=targetKind==='decision'?slot.decision_status_head:slot.claim_status_head
    const rows=this.db.prepare('SELECT sequence,digest,record_json FROM local_owner_status WHERE issuer_id=? AND decision_id=? AND target_kind=? ORDER BY sequence').all(this.config.issuerId,decisionId,targetKind) as any[];let previous:null|string=null,last:any=null
    try{for(let index=0;index<rows.length;index++){const record=JSON.parse(rows[index].record_json),expected=recordDigest('status-event',record);if(rows[index].sequence!==index||record.sequence!==index||record.previousDigest!==previous||record.targetDigest!==targetDigest||expected.value!==rows[index].digest||!digestMatches(record.digest,expected))return null;previous=rows[index].digest;last=record}return previous===head?last:null}catch{return null}
  }
  guardedStart(token:string,input:StartInput):CandidateResult<any>{
    return this.guarded(token,input?.decisionId??'',()=>{ if(!nonEmpty([input?.decisionId,input?.claimId,input?.intentId,input?.successorId]))return stop('MISSING_AUTHORITY','missing start context')
      this.db.exec('BEGIN IMMEDIATE');let intent:any,decision:any,claim:any,first:ClockSample,deadline:bigint
      try{
        const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any
        if(!slot?.claim_digest){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','missing claim')}
        if(slot.start_intent_digest){this.db.exec('ROLLBACK');return stop('HUMAN_DECISION_REQUIRED','existing start intent; no retry')}
        if(slot.claim_session!==PROCESS_SESSION_ID){this.db.exec('ROLLBACK');return stop('HUMAN_DECISION_REQUIRED','restart after claim requires human inspection')}
        const dr=this.read('decision',input.decisionId),cr=this.read('claim',input.claimId)
        if(dr.kind!=='ok'||cr.kind!=='ok'||(cr.record.digest as Digest)?.value!==slot.claim_digest){this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION','missing or corrupt durable readback')}
        decision=dr.record;claim=cr.record
        if(input.successorId!==claim.successorId||!equalJcs(input.action,FIXED_ACTION)){this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT','start binding conflict')}
        const ds=this.currentStatus(slot,input.decisionId,'decision'),cs=this.currentStatus(slot,input.decisionId,'claim')
        if(!ds||!cs){this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION','status chain invalid')}
        if(ds.state!=='active'||cs.state!=='active'){this.db.exec('ROLLBACK');return stop('STALE_PACKET','revoked')}
        const sampled=this.sampleClock();if(!sampled.ok){this.db.exec('ROLLBACK');return sampled}first=sampled.value
        const effective=Math.min(timestamp(decision.expiresAt as string),timestamp(claim.expiresAt as string)),now=timestamp(first.wallTime)
        if(now>=effective){this.db.exec('ROLLBACK');return stop('STALE_PACKET','expired')}
        deadline=BigInt(first.monotonicNanoseconds)+BigInt(effective-now)*1000000n
        const record:Record<string,unknown>={recordKind:'start-intent',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,claimDigest:claim.digest,intentId:input.intentId,successorId:input.successorId,action:FIXED_ACTION,admittedAt:first.wallTime,decisionStatusHead:slot.decision_status_head,claimStatusHead:slot.claim_status_head,clockSample:first,expiryDeadlineMonotonicNanoseconds:deadline.toString()}
        intent=this.store('start-intent',input.intentId,input.decisionId,record);this.db.prepare('UPDATE local_owner_slots SET start_intent_digest=? WHERE issuer_id=? AND decision_id=?').run((intent.digest as Digest).value,this.config.issuerId,input.decisionId);this.persistClock(first);this.db.exec('COMMIT')
      }catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('HUMAN_DECISION_REQUIRED',String(error))}
      if(this.config.test?.crashAfterIntent)process.exit(91)
      const second=this.sampleClock();if(!second.ok)return this.recordUncertain(input,intent,first,second.detail)
      const refreshed=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any
      const effective=Math.min(timestamp(decision.expiresAt as string),timestamp(claim.expiresAt as string))
      if(timestamp(second.value.wallTime)>=effective||BigInt(second.value.monotonicNanoseconds)>=deadline||this.currentStatus(refreshed,input.decisionId,'decision')?.state!=='active'||this.currentStatus(refreshed,input.decisionId,'claim')?.state!=='active')return this.recordUncertain(input,intent,second.value,'stale immediately before observation','STALE_PACKET')
      if(this.config.test?.uncertainObservation)return this.recordUncertain(input,intent,second.value,'observation outcome unknown')
      const observationDigest:Digest={algorithm:'sha256',canonicalization:'json-rfc8785-jcs',domain:`${PROFILE_ID}.observation.0.1-candidate`,value:OBSERVATION_DIGEST_VALUE}
      const result:Record<string,unknown>={recordKind:'start-result',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,intentDigest:intent.digest,resultId:randomUUID(),outcome:'completed',observedAt:second.value.wallTime,observationClockSample:second.value,observationDigest}
      try{this.db.exec('BEGIN IMMEDIATE');const complete=this.store('start-result',result.resultId as string,input.decisionId,result);this.persistClock(second.value);this.db.exec('COMMIT');return ok({intent,result:complete,observation:FIXED_OBSERVATION})}catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('HUMAN_DECISION_REQUIRED',`observation result persistence failed: ${String(error)}`)}
    })
  }
  private recordUncertain(input:StartInput,intent:any,clock:ClockSample,detail:string,kind:CandidateStop='HUMAN_DECISION_REQUIRED'):CandidateResult<any>{const result:Record<string,unknown>={recordKind:'start-result',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,intentDigest:intent.digest,resultId:randomUUID(),outcome:'uncertain',observedAt:clock.wallTime,observationClockSample:clock,observationDigest:null};try{this.db.exec('BEGIN IMMEDIATE');this.store('start-result',result.resultId as string,input.decisionId,result);this.persistClock(clock);this.db.exec('COMMIT')}catch{if(this.db.inTransaction)this.db.exec('ROLLBACK')}return stop(kind,detail)}
  inspect(token:string,decisionId:string):CandidateResult<any>{if(!this.authenticate(token))return stop('MISSING_AUTHORITY','access denied');try{const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,decisionId);return slot?ok(slot):stop('MISSING_AUTHORITY','missing')}catch{return stop('UNVERIFIED_ASSUMPTION','store unavailable')}}
}
