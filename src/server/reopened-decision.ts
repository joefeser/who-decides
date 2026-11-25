import { createHash } from 'node:crypto'
import { parseDecisionRequest } from '../bridge/schemas'

/** Reopen is observed, never invoked. Revision alone does not identify a decision cycle. */
export function reopenedRequest(envelope: unknown, snapshot: unknown, confirmed: unknown, priorRunId: string) {
  const parsed = parseDecisionRequest(envelope)
  if (!parsed.valid) throw new Error('ENVELOPE_INVALID')
  const env = parsed.envelope
  const decisions = (snapshot as { decisions?: unknown })?.decisions
  if (!Array.isArray(decisions)) throw new Error('SNAPSHOT_INVALID')
  const matches = decisions.filter(d => d?.id === env.coordination.questionId)
  if (matches.length !== 1) throw new Error('CARD_UNAVAILABLE')
  const card = matches[0]
  if (card.status !== 'reopened') throw new Error('CARD_NOT_REOPENED')
  const settlement = (confirmed as { outcome?: string, result?: { settled?: { choices?: unknown, by?: unknown, at?: unknown } } })
  const previous = card.previous
  const settled = settlement?.result?.settled
  const sameChoices = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b)
    && a.every(x => typeof x === 'string') && b.every(x => typeof x === 'string')
    && new Set(a).size === a.length && new Set(b).size === b.length
    && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  if (settlement?.outcome !== 'confirmed' || !previous || !settled
    || typeof previous.by !== 'string' || !previous.by.trim() || typeof previous.at !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(previous.at)
    || !Number.isFinite(Date.parse(previous.at))
    || previous.by !== settled.by || previous.at !== settled.at || !sameChoices(previous.choices, settled.choices)) {
    throw new Error('PREVIOUS_SETTLEMENT_MISMATCH')
  }
  if (!Number.isSafeInteger(card.revision) || card.revision < 0 || card.questions?.length !== 1 || card.questions[0].multiple) throw new Error('CARD_SHAPE_UNSUPPORTED')
  const question = card.questions[0]
  if (!question || typeof question.question !== 'string' || !Array.isArray(question.options) || question.options.some((o: unknown) => !o || typeof o !== 'object')) throw new Error('CARD_SHAPE_UNSUPPORTED')
  const input = { priorRunId, cardId: card.id, revision: card.revision, previous, question }
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const request = { ...env, question: question.question, options: question.options.map((o: { id: string, label: string }) => ({ id: o.id, label: o.label })),
    coordination: { ...env.coordination, revision: card.revision }, contextRefs: [...env.contextRefs, `who-decides:prior-run:${priorRunId}`],
    digests: [{ algorithm: 'sha256', value: digest, of: 'observed-reopen-cycle' }] }
  const validated = parseDecisionRequest(request)
  if (!validated.valid) throw new Error('REOPENED_REQUEST_INVALID')
  return { envelope: validated.envelope, digest, previous }
}
