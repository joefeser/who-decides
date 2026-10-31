import { NextRequest, NextResponse } from 'next/server'
import engine from '../../../../src/server/state'
import { createMachineAuth, BRIDGE_PRINCIPAL } from '../../../../src/agent-service/machine-auth'
import { parseDecisionRequest } from '../../../../src/bridge/schemas'

/* External decision-request intake — the bridge run kind's front door.
 *
 * Machine-principal only: the chopin bridge authenticates with its own
 * scoped token (WD_BRIDGE_TOKEN_HASH), the same fail-closed discipline as
 * the agent service under a distinct principal — a bridge token can never
 * authenticate as the agentcore runtime. Unset/malformed hash disables the
 * route entirely (503 typed, never open).
 *
 * The envelope is validated strictly (additionalProperties: false — it
 * structurally cannot carry an actor). Actor attribution happens later, at
 * decision time, from the operator session channel. */
export async function POST(request: NextRequest) {
  const auth = createMachineAuth({ tokenHash: process.env.WD_BRIDGE_TOKEN_HASH, principal: BRIDGE_PRINCIPAL }).authorize(request)
  if (!auth.ok) {
    // Same status mapping as the agent service: DISABLED means the route is
    // not provisioned (503); REQUIRED/INVALID are authentication failures.
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.error === 'MACHINE_AUTH_DISABLED' ? 503 : 401 })
  }
  const body = await request.json().catch(() => null)
  const parsed = parseDecisionRequest(body)
  if (!parsed.valid) {
    return NextResponse.json({ ok: false, error: 'ENVELOPE_INVALID', details: parsed.errors }, { status: 400 })
  }
  const result = await engine.startBridgeRun(parsed.envelope, auth.principal)
  return NextResponse.json(result, { status: result.ok ? 201 : result.error === 'ACTIVE_RUN_EXISTS' ? 409 : 400 })
}
