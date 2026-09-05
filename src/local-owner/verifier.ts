import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { assertValid } from '../artifacts/schemas'
import { FIXED_ACTION, FIXED_OBSERVATION, OBSERVATION_DIGEST_VALUE, type CandidateResult, type CandidateStop, type ClaimInput, type ClockSample, type DecisionInput, type StartInput } from './contracts'
import { PROFILE_ID, PROFILE_VERSION, digestEnvelope, equalJcs, recordDigest, type Digest } from './jcs'

export type VerifierConfig = {
  dbPath: string, issuerId: string, actorId: string, credential: string,
  selectedProfile: { id: string, version: string, status: string, pin: string },
  test?: { clock?: () => ClockSample, holdGuardMs?: number, waitGuardMs?: number, sessionId?: string, crashAfterIntent?: boolean, uncertainObservation?: boolean },
}
export const APPROVED_PROFILE_PIN = '18dedc4a2ef445e142ef395c62883d3448ad0ee021dbde789fe6b14e94538c34'
const ok = <T>(value: T): CandidateResult<T> => ({ ok: true, value })
const stop = (kind: CandidateStop, detail: string): CandidateResult<never> => ({ ok: false, stop: kind, detail })
const timestamp = (value: string): number => /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value ? Date.parse(value) : Number.NaN
const canonicalNs = (value: string) => /^(0|[1-9][0-9]*)$/.test(value)
const sleep = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const digestMatches = (actual: unknown, expected: Digest) => equalJcs(actual, expected)

export class LocalOwnerVerifier {
  private readonly db: Database.Database
  private readonly credentialHash: Buffer
  private readonly sessionId: string
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
    this.sessionId = config.test?.sessionId ?? randomUUID()
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
    `)
  }

  close() { this.db.close() }
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
  private store(kind: string, id: string, decisionId: string, record: Record<string, unknown>) {
    const digest = recordDigest(kind, record); const complete = { ...record, digest }
    this.db.prepare('INSERT INTO local_owner_records VALUES (?, ?, ?, ?, ?, ?)').run(this.config.issuerId, kind, id, decisionId, digest.value, JSON.stringify(complete))
    return complete
  }
  private read(kind: string, id: string) {
    const row = this.db.prepare('SELECT digest, record_json FROM local_owner_records WHERE issuer_id=? AND kind=? AND record_id=?').get(this.config.issuerId, kind, id) as { digest: string, record_json: string } | undefined
    if (!row) return null
    const record = JSON.parse(row.record_json) as Record<string, unknown>
    return recordDigest(kind, record).value === row.digest ? record : null
  }
  private appendStatus(decisionId: string, targetKind: 'decision' | 'claim', targetDigest: string, state: 'active' | 'revoked', at: string) {
    const rows = this.db.prepare('SELECT sequence,digest,record_json FROM local_owner_status WHERE issuer_id=? AND decision_id=? AND target_kind=? ORDER BY sequence').all(this.config.issuerId, decisionId, targetKind) as Array<{sequence:number,digest:string,record_json:string}>
    if (rows.some((row, index) => row.sequence !== index || recordDigest('status-event', JSON.parse(row.record_json)).value !== row.digest)) throw new Error('CORRUPT_STATUS')
    const previous = rows.at(-1); if (previous && JSON.parse(previous.record_json).state === 'revoked') throw new Error('REVOCATION_TERMINAL')
    const record: Record<string, unknown> = { recordKind:'status-event',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId,eventId:randomUUID(),targetKind,targetDigest,sequence:rows.length,previousDigest:previous?.digest??null,state,recordedAt:at,actorId:this.config.actorId }
    const digest = recordDigest('status-event', record); const complete={...record,digest}
    this.db.prepare('INSERT INTO local_owner_status VALUES (?,?,?,?,?,?)').run(this.config.issuerId,decisionId,targetKind,rows.length,digest.value,JSON.stringify(complete))
    this.db.prepare(`UPDATE local_owner_slots SET ${targetKind === 'decision' ? 'decision_status_head' : 'claim_status_head'}=? WHERE issuer_id=? AND decision_id=?`).run(digest.value,this.config.issuerId,decisionId)
    return complete
  }

  recordDecision(token: string, input: DecisionInput): CandidateResult<Record<string, unknown>> {
    return this.guarded(token, input?.decisionId ?? '', () => {
      if (!input || !exactKeys(input as unknown as Record<string, unknown>, ['decisionId','humanEventRef','baseDecisionRef','baseDecisionDigest','requestRef','action','approvedAt','expiresAt','baseDecision'])) return stop('MISSING_AUTHORITY','missing or stripped candidate context')
      if (!equalJcs(input.action,FIXED_ACTION)) return stop('SCOPE_CONFLICT','unsupported action')
      if (!Number.isFinite(timestamp(input.approvedAt)) || !Number.isFinite(timestamp(input.expiresAt)) || timestamp(input.expiresAt)<=Date.now()) return stop('STALE_PACKET','invalid or expired decision')
      try { assertValid('human-decision', input.baseDecision) } catch { return stop('MISSING_AUTHORITY','closed base decision invalid') }
      const base=input.baseDecision as Record<string,unknown>
      const evidence=base.evidence as unknown
      if (base.decision!=='start_work'||base.from_status!=='approved'||base.to_status!=='in_progress'||base.actor_kind!=='human'||base.actor_id!==this.config.actorId
        ||base.packet_id!==input.baseDecisionRef||base.decision_id!==input.humanEventRef||!Array.isArray(evidence)
        ||!evidence.includes(`candidate-decision:${input.decisionId}`)||!evidence.includes(`candidate-action:${recordDigest('action',FIXED_ACTION as unknown as Record<string,unknown>).value}`)) return stop('MISSING_AUTHORITY','human act does not bind this packet and action')
      const expectedBase=digestEnvelope(`${PROFILE_ID}.base-decision-reference.0.1-candidate`,input.baseDecision)
      if(!digestMatches(input.baseDecisionDigest,expectedBase))return stop('MISSING_AUTHORITY','base decision companion digest mismatch')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const legacyTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consumption_receipts'").get()
        if(legacyTable&&this.db.prepare('SELECT 1 FROM consumption_receipts WHERE decision_id=?').get(input.decisionId)){this.db.exec('ROLLBACK');return stop('MISSING_AUTHORITY','legacy decision-id collision')}
        if(this.db.prepare('SELECT 1 FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId)){this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT','decision slot exists')}
        const record:Record<string,unknown>={recordKind:'decision',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,humanEventRef:input.humanEventRef,baseDecisionRef:input.baseDecisionRef,baseDecisionDigest:input.baseDecisionDigest,requestRef:input.requestRef,action:FIXED_ACTION,approvedAt:input.approvedAt,expiresAt:input.expiresAt}
        const complete=this.store('decision',input.decisionId,input.decisionId,record);const digest=(complete.digest as Digest).value
        this.db.prepare('INSERT INTO local_owner_slots(issuer_id,decision_id,decision_digest) VALUES(?,?,?)').run(this.config.issuerId,input.decisionId,digest)
        this.appendStatus(input.decisionId,'decision',digest,'active',input.approvedAt);this.db.exec('COMMIT');return ok(complete)
      } catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('UNVERIFIED_ASSUMPTION',String(error))}
    })
  }

  admitClaim(token:string,input:ClaimInput):CandidateResult<Record<string,unknown>>{
    return this.guarded(token,input?.decisionId??'',()=>{if(!input||!exactKeys(input as unknown as Record<string,unknown>,['decisionId','decisionDigest','claimId','attemptKey','successorId','requestRef','action','claimedAt','expiresAt']))return stop('MISSING_AUTHORITY','missing claim context');if(!equalJcs(input.action,FIXED_ACTION))return stop('SCOPE_CONFLICT','unsupported action')
      const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any;if(!slot)return stop('MISSING_AUTHORITY','missing decision')
      if(slot.claim_digest){const old=this.read('claim',input.claimId);if(!old)return stop('SCOPE_CONFLICT','slot already consumed');const candidate={recordKind:'claim',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,...input};return recordDigest('claim',candidate).value===slot.claim_digest?ok(old):stop('SCOPE_CONFLICT','changed binding replay')}
      const decision=this.read('decision',input.decisionId);if(!decision)return stop('UNVERIFIED_ASSUMPTION','decision readback failed')
      if((input.decisionDigest as Digest).value!==slot.decision_digest||input.requestRef!==decision.requestRef||!Number.isFinite(timestamp(input.claimedAt))||!Number.isFinite(timestamp(input.expiresAt))||timestamp(input.expiresAt)>timestamp(decision.expiresAt as string)||timestamp(input.expiresAt)<=Date.now())return stop('SCOPE_CONFLICT','claim bindings invalid')
      this.db.exec('BEGIN IMMEDIATE');try{const record={recordKind:'claim',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,...input};const complete=this.store('claim',input.claimId,input.decisionId,record);const digest=(complete.digest as Digest).value;this.db.prepare('UPDATE local_owner_slots SET claim_digest=?,claim_session=? WHERE issuer_id=? AND decision_id=?').run(digest,this.sessionId,this.config.issuerId,input.decisionId);this.appendStatus(input.decisionId,'claim',digest,'active',input.claimedAt);this.db.exec('COMMIT');return ok(complete)}catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('SCOPE_CONFLICT',String(error))}})
  }
  revoke(token:string,decisionId:string,targetKind:'decision'|'claim'):CandidateResult<Record<string,unknown>>{return this.guarded(token,decisionId,()=>{const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,decisionId) as any;if(!slot)return stop('MISSING_AUTHORITY','missing target');const targetDigest=targetKind==='decision'?slot.decision_digest:slot.claim_digest;if(!targetDigest)return stop('MISSING_AUTHORITY','missing target');const clock=this.sampleClock();if(!clock.ok)return clock;this.db.exec('BEGIN IMMEDIATE');try{const result=this.appendStatus(decisionId,targetKind,targetDigest,'revoked',clock.value.wallTime);this.db.exec('COMMIT');return ok(result)}catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('STALE_PACKET','revocation is terminal')}})}
  private currentStatus(slot:any,decisionId:string,targetKind:'decision'|'claim'){
    const targetDigest=targetKind==='decision'?slot.decision_digest:slot.claim_digest,head=targetKind==='decision'?slot.decision_status_head:slot.claim_status_head
    const rows=this.db.prepare('SELECT sequence,digest,record_json FROM local_owner_status WHERE issuer_id=? AND decision_id=? AND target_kind=? ORDER BY sequence').all(this.config.issuerId,decisionId,targetKind) as any[];let previous:null|string=null,last:any=null
    for(let index=0;index<rows.length;index++){const record=JSON.parse(rows[index].record_json);if(rows[index].sequence!==index||record.sequence!==index||record.previousDigest!==previous||record.targetDigest!==targetDigest||recordDigest('status-event',record).value!==rows[index].digest)return null;previous=rows[index].digest;last=record}
    return previous===head?last:null
  }
  guardedStart(token:string,input:StartInput):CandidateResult<any>{
    if(!this.authenticate(token))return stop('MISSING_AUTHORITY','access denied')
    const pre=this.db.prepare('SELECT start_intent_digest,claim_session FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any
    if(pre?.start_intent_digest)return stop('HUMAN_DECISION_REQUIRED','existing start intent; no retry')
    if(pre?.claim_session&&pre.claim_session!==this.sessionId)return stop('HUMAN_DECISION_REQUIRED','restart after claim requires human inspection')
    return this.guarded(token,input.decisionId,()=>{const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any;if(!slot?.claim_digest)return stop('MISSING_AUTHORITY','missing claim');if(slot.start_intent_digest)return stop('HUMAN_DECISION_REQUIRED','existing start intent')
      const decision=this.read('decision',input.decisionId),claim=this.read('claim',input.claimId);if(!decision||!claim||(claim.digest as Digest).value!==slot.claim_digest)return stop('UNVERIFIED_ASSUMPTION','missing or corrupt durable readback');if(input.successorId!==claim.successorId||!equalJcs(input.action,FIXED_ACTION))return stop('SCOPE_CONFLICT','start binding conflict')
      const ds=this.currentStatus(slot,input.decisionId,'decision'),cs=this.currentStatus(slot,input.decisionId,'claim');if(!ds||!cs)return stop('UNVERIFIED_ASSUMPTION','status chain invalid');if(ds.state!=='active'||cs.state!=='active')return stop('STALE_PACKET','revoked')
      const first=this.sampleClock();if(!first.ok)return first;if(timestamp(first.value.wallTime)>=timestamp(decision.expiresAt as string)||timestamp(first.value.wallTime)>=timestamp(claim.expiresAt as string))return stop('STALE_PACKET','expired')
      const intent:Record<string,unknown>={recordKind:'start-intent',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,claimDigest:claim.digest,intentId:input.intentId,successorId:input.successorId,action:FIXED_ACTION,admittedAt:first.value.wallTime,decisionStatusHead:slot.decision_status_head,claimStatusHead:slot.claim_status_head,clockSample:first.value}
      this.db.exec('BEGIN IMMEDIATE');let complete:any;try{complete=this.store('start-intent',input.intentId,input.decisionId,intent);this.db.prepare('UPDATE local_owner_slots SET start_intent_digest=? WHERE issuer_id=? AND decision_id=?').run((complete.digest as Digest).value,this.config.issuerId,input.decisionId);this.db.prepare('INSERT INTO local_owner_clock VALUES(?,?) ON CONFLICT(issuer_id) DO UPDATE SET wall_time=excluded.wall_time').run(this.config.issuerId,first.value.wallTime);this.db.exec('COMMIT')}catch(error){if(this.db.inTransaction)this.db.exec('ROLLBACK');return stop('HUMAN_DECISION_REQUIRED',String(error))}
      if(this.config.test?.crashAfterIntent)process.exit(91)
      const second=this.sampleClock();if(!second.ok)return this.recordUncertain(input,complete,first.value,second.detail)
      const refreshed=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,input.decisionId) as any
      if(timestamp(second.value.wallTime)>=timestamp(decision.expiresAt as string)||timestamp(second.value.wallTime)>=timestamp(claim.expiresAt as string)||this.currentStatus(refreshed,input.decisionId,'decision')?.state!=='active'||this.currentStatus(refreshed,input.decisionId,'claim')?.state!=='active')return this.recordUncertain(input,complete,second.value,'stale immediately before observation','STALE_PACKET')
      if(this.config.test?.uncertainObservation)return this.recordUncertain(input,complete,second.value,'observation outcome unknown')
      const observationDigest:Digest={algorithm:'sha256',canonicalization:'json-rfc8785-jcs',domain:`${PROFILE_ID}.observation.0.1-candidate`,value:OBSERVATION_DIGEST_VALUE}
      const result:Record<string,unknown>={recordKind:'start-result',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,intentDigest:complete.digest,resultId:randomUUID(),outcome:'completed',observedAt:second.value.wallTime,observationClockSample:second.value,observationDigest}
      return ok({intent:complete,result:this.store('start-result',result.resultId as string,input.decisionId,result),observation:FIXED_OBSERVATION})
    })
  }
  private recordUncertain(input:StartInput,intent:any,clock:ClockSample,detail:string,kind:CandidateStop='HUMAN_DECISION_REQUIRED'):CandidateResult<any>{const result:Record<string,unknown>={recordKind:'start-result',profileId:PROFILE_ID,profileVersion:PROFILE_VERSION,issuerId:this.config.issuerId,decisionId:input.decisionId,intentDigest:intent.digest,resultId:randomUUID(),outcome:'uncertain',observedAt:clock.wallTime,observationClockSample:clock,observationDigest:null};this.store('start-result',result.resultId as string,input.decisionId,result);return stop(kind,detail)}
  inspect(token:string,decisionId:string):CandidateResult<any>{if(!this.authenticate(token))return stop('MISSING_AUTHORITY','access denied');const slot=this.db.prepare('SELECT * FROM local_owner_slots WHERE issuer_id=? AND decision_id=?').get(this.config.issuerId,decisionId);return slot?ok(slot):stop('MISSING_AUTHORITY','missing')}
}
