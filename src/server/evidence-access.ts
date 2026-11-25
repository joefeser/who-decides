import { requireOperator } from './auth'

/** Select explicitly; a misspelled profile must never expose private evidence. */
export function privateEvidenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const profile = env.WD_PROFILE ?? 'demo'
  if (profile !== 'demo' && profile !== 'private-local') {
    throw new Error('WD_PROFILE must be demo or private-local')
  }
  return profile === 'private-local'
}

export async function evidenceAccessDenied(request: Request): Promise<Response | undefined> {
  if (!privateEvidenceEnabled() || await requireOperator(request)) return undefined
  return Response.json({ ok: false, error: 'OPERATOR_AUTH_REQUIRED' }, {
    status: 401,
    headers: { 'cache-control': 'no-store' },
  })
}

/** The first local proof is model-free and cannot silently choose a hosted backend. */
export function validatePrivateLocalConfig(env: Record<string, string | undefined> = process.env): void {
  if (!privateEvidenceEnabled(env)) return
  if ((env.WD_STORE ?? 'sqlite') !== 'sqlite' || env.WD_AGENTCORE_ENDPOINT || env.WD_MACHINE_TOKEN) {
    throw new Error('private-local requires SQLite and deterministic dispatch; unset hosted dispatch configuration')
  }
  if (!/^[a-f0-9]{64}$/i.test(env.WD_OPERATOR_PASSCODE_HASH ?? '')) {
    throw new Error('private-local requires WD_OPERATOR_PASSCODE_HASH')
  }
}
