/* Outbox (A2): the bridge run kind's outbound dispatch discipline.
 *
 * THE ONE-TRANSACTION RULE: a bridge decision and its outbound intent
 * commit together, inside the store adapter's acquireDecisionIntent
 * transaction (sqlite: one BEGIN IMMEDIATE block; pg: one real
 * transaction). A recorded decision can never exist without its dispatch
 * intent, and neither can commit alone.
 *
 * EXACT-PAYLOAD REPLAY: the dispatcher receives the payload parsed from the
 * op's persisted payload_json — the bytes captured at enqueue time, built
 * from the PERSISTED intake envelope and the STORED decision. Nothing is
 * ever re-derived from a fresh read of the target system; if the target
 * moved (e.g. the question revision advanced), the receiver's typed
 * refusal is the honest outcome, never a silent refresh.
 *
 * UNKNOWN STAYS UNKNOWN: a lost response (crash after the receiver acted,
 * before the result landed) resolves the op to 'unknown' — not success, not
 * failure. A later resume re-sends the EXACT same payload under the SAME
 * op key; the receiver's idempotency (B4) replays the original result,
 * which is the only way 'unknown' ever becomes 'confirmed'. An explicit
 * receiver refusal on a retry may resolve it 'failed' — evidence, not a
 * guess. */
import type { RunStore, OutboxOpRow, OutboxOpKind, OutboxOpStatus } from './store/store'

export type OutboxDispatchOutcome =
  | { kind: 'confirmed', result: unknown }
  | { kind: 'failed', error: string }
  | { kind: 'unknown', detail?: string }

/** Transport only: receives the exact persisted payload and reports what
 * the receiver said. It must never rebuild, refresh, or re-derive any part
 * of the payload. */
export type OutboxDispatcher = (op: {
  opKey: string
  kind: OutboxOpKind
  targetSystem: string
  payload: unknown
}) => Promise<OutboxDispatchOutcome>

/** Per-op outcome of a dispatch pass. `replayed: true` means the op was
 * already terminal and its PERSISTED result is echoed untouched. */
export type OutboxOpOutcome = {
  opKey: string
  kind: OutboxOpKind
  status: OutboxOpStatus | 'in_progress'
  result: unknown
  replayed: boolean
}

export class Outbox {
  constructor(private readonly runs: RunStore) {}

  /** Dispatch every op for a run in enqueue order. Safe to call repeatedly
   * (recovery, retries, overlapping workers):
   *  - terminal ops (confirmed/failed) are never re-dispatched; their
   *    persisted result rows are echoed;
   *  - a pending op is claimed pending -> dispatched by CAS — exactly one
   *    dispatcher owns the wire attempt, a concurrent pass reports
   *    in_progress without touching it;
   *  - dispatched/unknown ops (crash window, lost response) re-send the
   *    exact persisted payload under the same op key. */
  async dispatch(runId: string, dispatcher: OutboxDispatcher): Promise<OutboxOpOutcome[]> {
    const ops = await this.runs.getOutboxOps(runId)
    const outcomes: OutboxOpOutcome[] = []
    for (const op of ops) {
      if (op.status === 'confirmed' || op.status === 'failed') {
        outcomes.push({
          opKey: op.op_key, kind: op.kind, status: op.status, replayed: true,
          result: op.result_json === null ? null : JSON.parse(op.result_json),
        })
        continue
      }
      if (op.status === 'pending') {
        const claimed = await this.runs.markOutboxDispatched(runId, op.op_key, new Date().toISOString())
        if (!claimed) {
          outcomes.push({ opKey: op.op_key, kind: op.kind, status: 'in_progress', replayed: false, result: null })
          continue
        }
      }
      const outcome = await dispatcher({
        opKey: op.op_key,
        kind: op.kind,
        targetSystem: op.target_system,
        payload: JSON.parse(op.payload_json),
      })
      const resultJson = JSON.stringify(
        outcome.kind === 'confirmed'
          ? { outcome: 'confirmed', result: outcome.result }
          : outcome.kind === 'failed'
            ? { outcome: 'failed', error: outcome.error }
            : { outcome: 'unknown', detail: outcome.detail ?? null },
      )
      await this.runs.resolveOutboxOp(runId, op.op_key, outcome.kind, resultJson, new Date().toISOString())
      outcomes.push({
        opKey: op.op_key, kind: op.kind, status: outcome.kind, replayed: false,
        result: JSON.parse(resultJson),
      })
    }
    return outcomes
  }

  /** The persisted op rows, for state surfacing and audit. */
  async ops(runId: string): Promise<OutboxOpRow[]> {
    return this.runs.getOutboxOps(runId)
  }
}

/** Builds the answer op (B2 dispatch) payload from PERSISTED state only:
 * the intake envelope's coordination binding (document/question/revision
 * captured at intake) and the operator's recorded choice. Called ONCE at
 * decision time; the returned bytes are what ships, forever. The shape
 * mirrors the fork's answer_decision input contract (id, questionId,
 * revision, optionIds, idempotencyKey). */
export function buildAnswerOp(
  runId: string,
  coordination: { documentId: string, questionId: string, revision: number },
  choice: string,
  targetSystem: string,
): { runId: string, opKey: string, kind: OutboxOpKind, targetSystem: string, payloadJson: string } {
  const opKey = `wd:${runId}:answer`
  return {
    runId,
    opKey,
    kind: 'answer',
    targetSystem,
    payloadJson: JSON.stringify({
      tool: 'answer_decision',
      arguments: {
        id: coordination.documentId,
        questionId: coordination.questionId,
        revision: coordination.revision,
        optionIds: [choice],
        idempotencyKey: opKey,
      },
    }),
  }
}
