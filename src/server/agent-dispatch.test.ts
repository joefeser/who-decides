/* AC-3 dispatcher tests: session mapping, payload shape, disabled
 * fallback, error pass-through, and the test-double seam. Run: npm run test:dispatch */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentDispatcher, runtimeSessionIdFor } from './agent-dispatch'
import type { InvokeAgentRuntimeClient } from './agent-dispatch'

const CONFIG = { endpoint: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/demo', machineToken: 'svc-token' }

function recordingDouble(behavior?: (payload: Record<string, unknown>) => Record<string, unknown>): { client: InvokeAgentRuntimeClient, payloads: Array<Record<string, unknown>> } {
  const payloads: Array<Record<string, unknown>> = []
  return {
    payloads,
    client: {
      invoke: async (payload) => {
        payloads.push(payload)
        return behavior ? behavior(payload) : { ok: true, result: { status: 'DECISION_REQUIRED' } }
      },
    },
  }
}

test('dispatch A sends the run payload with the machine credential inside the body', async () => {
  const { client, payloads } = recordingDouble()
  const dispatcher = createAgentDispatcher(CONFIG, client)
  const result = await dispatcher.dispatch({ kind: 'decision-run', sessionId: 'run-abc' })
  assert.equal(result.ok, true)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]!.kind, 'decision-run')
  assert.equal(payloads[0]!.sessionId, 'run-abc')
  assert.equal(payloads[0]!.credential, 'svc-token')
  // No Authorization header concept — the credential is payload-only (AC-2 boundary)
  assert.equal('authorization' in payloads[0]!, false)
  assert.equal(result.dispatch.transport, 'aws-sdk')
  assert.equal(result.dispatch.runtimeSessionId, runtimeSessionIdFor('run-abc'))
})

test('dispatch B carries the decision fields; session ids are stable per run', async () => {
  const { client, payloads } = recordingDouble()
  const dispatcher = createAgentDispatcher(CONFIG, client)
  await dispatcher.dispatch({ kind: 'decision-run', sessionId: 'run-x' })
  await dispatcher.dispatch({ kind: 'decision-resume', sessionId: 'run-x', choice: 'defer', rationale: 'not yet' })
  assert.equal(payloads[1]!.kind, 'decision-resume')
  assert.equal(payloads[1]!.choice, 'defer')
  assert.equal(payloads[1]!.rationale, 'not yet')
  // both invocations for the same run map to one session
  const dispatcher2 = createAgentDispatcher(CONFIG, recordingDouble().client)
  const a = await dispatcher2.dispatch({ kind: 'decision-run', sessionId: 'run-x' })
  const b = await dispatcher2.dispatch({ kind: 'decision-resume', sessionId: 'run-x', choice: 'defer', rationale: 'r' })
  assert.equal(a.dispatch.runtimeSessionId, b.dispatch.runtimeSessionId)
})

test('disabled dispatcher returns a typed stop, never invokes the client', async () => {
  let invoked = 0
  const client: InvokeAgentRuntimeClient = { invoke: async () => { invoked++; return {} } }
  for (const partial of [{}, { endpoint: 'x' }, { machineToken: 'y' }]) {
    const dispatcher = createAgentDispatcher(partial as { endpoint?: string, machineToken?: string }, client)
    assert.equal(dispatcher.isEnabled(), false)
    const result = await dispatcher.dispatch({ kind: 'decision-run', sessionId: 'r' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'AGENT_DISPATCH_DISABLED')
    assert.equal(result.dispatch.transport, 'disabled')
  }
  assert.equal(invoked, 0)
})

test('client errors pass through with dispatch metadata, not as throws', async () => {
  const client: InvokeAgentRuntimeClient = {
    invoke: async () => { throw new Error('ThrottlingException: rate exceeded') },
  }
  const dispatcher = createAgentDispatcher(CONFIG, client)
  const result = await dispatcher.dispatch({ kind: 'decision-run', sessionId: 'r' })
  assert.equal(result.ok, false)
  assert.match(result.error!, /ThrottlingException/)
  assert.equal(result.dispatch.transport, 'aws-sdk')
  assert.ok(result.dispatch.durationMs >= 0)
})
