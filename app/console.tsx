'use client'

/* The three-state console (RULING M3). States change hierarchy, not badges:
 * running → progress dominates; decision_required → the decision dominates;
 * resuming/completed → proof dominates. Wording per RULING M1: never "paused".
 *
 * Watch mode: visitors get every state rendered read-only — no run/decide/
 * reset/probe affordances — plus a small operator sign-in disclosure. The
 * server decides (`authenticated` on /api/state); the browser never stores
 * tokens (cookie only, same-origin fetch). */
import { useCallback, useEffect, useRef, useState } from 'react'

type Milestone = { label: string, detail: string, at: string }

type ConsoleState = {
  schema: string
  runId: string
  state: 'ready' | 'running' | 'decision_required' | 'resuming' | 'completed'
  invocationA: string | null
  invocationB: string | null
  startedAt: string | null
  completedAt: string | null
  milestones: Milestone[]
  decisionRequest: {
    question: string
    options: string[]
    humanTerms: string
    whoIsAffected: string
    tradeoffFindingId: string
  } | null
  decision: { choice: string, rationale: string, decidedAt: string } | null
  consumption: { receiptId: string, decisionDigest: string, successorInvocationId: string, claimedAt: string } | null
  replayProbe: { attemptedBy: string, result: string, detail: string } | null
  effect: { effect: string, mode: string, noExternalMutationPerformed: boolean, exactPayload: Record<string, unknown> } | null
  artifacts: Array<{ name: string, kind: string, valid: boolean }>
  heading: string
  subheading: string
  authenticated: boolean
}

const STATE_TONE: Record<ConsoleState['state'], string> = {
  ready: 'border-slate-700 bg-slate-900/60',
  running: 'border-indigo-800 bg-indigo-950/40',
  decision_required: 'border-amber-600 bg-amber-950/30',
  resuming: 'border-sky-700 bg-sky-950/30',
  completed: 'border-emerald-700 bg-emerald-950/30',
}

function OperatorSignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [passcode, setPasscode] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    if (!passcode || signingIn) return
    setSigningIn(true)
    setError(null)
    try {
      const response = await fetch('/api/operator/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'UNKNOWN' }))
        setError(body.error === 'RATE_LIMITED'
          ? 'Too many attempts — wait a few minutes and try again'
          : 'Sign-in failed — check the operator passcode')
        return
      }
      setPasscode('')
      await onSignedIn()
    } catch {
      setError('NETWORK_ERROR: could not reach the console server')
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Operator sign-in</summary>
      <form onSubmit={signIn} className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={passcode}
          onChange={e => setPasscode(e.target.value)}
          aria-label="Operator passcode"
          placeholder="Operator passcode"
          autoComplete="off"
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm focus-visible:border-amber-500 focus-visible:outline-none"
        />
        <button
          type="submit"
          disabled={signingIn || !passcode}
          className="rounded-lg border border-slate-600 px-4 py-1.5 text-sm hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="w-full text-sm text-red-400" role="alert">Stopped: {error}</p>}
      </form>
    </details>
  )
}

export default function Console() {
  const [state, setState] = useState<ConsoleState | null>(null)
  const [choice, setChoice] = useState<string>('')
  const [rationale, setRationale] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [replaying, setReplaying] = useState(false)
  const choiceRef = useRef<HTMLFieldSetElement>(null)

  const refresh = useCallback(async () => {
    const response = await fetch('/api/state', { cache: 'no-store' })
    if (response.status === 401) {
      // Defensive: /api/state is public; treat an unexpected 401 as watch mode.
      setState(null)
      return
    }
    if (response.ok) setState(await response.json())
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Poll only while the server is actively transitioning (RULING M3).
  useEffect(() => {
    const active = state?.state === 'running' || state?.state === 'resuming'
    if (!active) return
    const timer = setInterval(() => { void refresh() }, 800)
    return () => clearInterval(timer)
  }, [state?.state, refresh])

  useEffect(() => {
    if (state?.state === 'decision_required' && state?.authenticated) choiceRef.current?.focus()
  }, [state?.state, state?.authenticated])

  async function startRun() {
    setError(null)
    try {
      await fetch('/api/run', { method: 'POST' })
      await refresh()
    } catch {
      setError('NETWORK_ERROR: could not reach the console server')
    }
  }

  async function submitDecision(event: React.FormEvent) {
    event.preventDefault()
    if (!choice || rationale.trim().length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choice, rationale, idempotencyKey: `console:${state?.runId}` }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'UNKNOWN' }))
        setError(body.error ?? 'UNKNOWN')
        return
      }
      await refresh()
    } catch {
      setError('NETWORK_ERROR: decision not recorded — check the server and retry (same choice is safe)')
    } finally {
      setSubmitting(false)
    }
  }

  async function attemptDuplicate() {
    setReplaying(true)
    try {
      await fetch('/api/replay', { method: 'POST' })
      await refresh()
    } catch {
      setError('NETWORK_ERROR: probe not recorded — check the server and retry')
    } finally {
      setReplaying(false)
    }
  }

  async function resetConsole() {
    await fetch('/api/state', { method: 'DELETE' }).catch(() => {})
    setChoice('')
    setRationale('')
    await refresh()
  }

  if (!state) {
    return <p className="text-slate-400" aria-live="polite">Loading console…</p>
  }

  const readOnly = !state.authenticated
  const watchNotice = (
    <div className="space-y-4">
      <p className="rounded-lg border border-amber-700/60 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200" role="note">
        Awaiting the operator&rsquo;s decision — this console is read-only for visitors.
      </p>
      <OperatorSignIn onSignedIn={refresh} />
    </div>
  )

  const canSubmit = state.state === 'decision_required' && choice !== '' && rationale.trim().length > 0 && !submitting

  return (
    <section
      aria-live="polite"
      className={`rounded-2xl border p-6 transition-colors ${STATE_TONE[state.state]}`}
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold" role="status">{state.heading}</h2>
        <span className="font-mono text-xs text-slate-400">{state.state}</span>
      </div>
      <p className="mb-6 text-sm text-slate-300">{state.subheading}</p>

      {state.state === 'ready' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            The demo seeds a bounded task packet: a security patch whose runtime floor moves —
            a real judgment call the agent cannot own.
          </p>
          {readOnly ? watchNotice : (
            <>
              <button
                onClick={startRun}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
              >
                Run the demo
              </button>
              <p className="text-xs text-slate-500">
                One click starts invocation A. It never preselects your decision.
              </p>
            </>
          )}
        </div>
      )}

      {state.state === 'running' && (
        <div className="space-y-4">
          <p className="font-mono text-xs text-slate-400">invocation A · {state.invocationA}</p>
          <ol className="space-y-2" aria-label="Run milestones">
            {state.milestones.map(m => (
              <li key={m.label} className="flex items-baseline gap-3 rounded-lg bg-slate-900/70 px-4 py-2">
                <span className="w-20 shrink-0 font-mono text-xs uppercase tracking-wide text-indigo-300">{m.label}</span>
                <span className="text-sm text-slate-200">{m.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {state.state === 'decision_required' && state.decisionRequest && (
        <div className="space-y-5">
          <p className="font-mono text-xs text-slate-400">
            invocation A · {state.invocationA} — ended. No PR created.
          </p>
          <div className="rounded-lg border border-amber-700/60 bg-slate-900/70 p-4">
            <h3 className="mb-2 text-base font-semibold text-amber-200">{state.decisionRequest.question}</h3>
            <p className="text-sm text-slate-200">{state.decisionRequest.humanTerms}</p>
            <p className="mt-2 text-sm text-amber-300/90">Who is affected: {state.decisionRequest.whoIsAffected}</p>
            <p className="mt-1 font-mono text-xs text-slate-500">evidence: {state.decisionRequest.tradeoffFindingId}</p>
          </div>
          {readOnly ? watchNotice : (
            <form onSubmit={submitDecision} className="space-y-5">
              <fieldset ref={choiceRef} tabIndex={-1} className="space-y-2" aria-label="Your decision">
                <legend className="mb-2 text-sm font-medium text-slate-200">Your decision — nothing is selected for you:</legend>
                {state.decisionRequest.options.map(option => (
                  <label key={option} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2.5 hover:border-slate-500 has-checked:border-amber-500">
                    <input
                      type="radio"
                      name="decision"
                      value={option}
                      checked={choice === option}
                      onChange={() => setChoice(option)}
                      className="h-4 w-4 accent-amber-500"
                    />
                    <span className="font-mono text-sm">{option}</span>
                  </label>
                ))}
              </fieldset>
              <div>
                <label htmlFor="rationale" className="mb-1 block text-sm font-medium text-slate-200">
                  Rationale (required — recorded on the decision artifact)
                </label>
                <textarea
                  id="rationale"
                  value={rationale}
                  onChange={e => setRationale(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus-visible:border-amber-500 focus-visible:outline-none"
                  placeholder="Why this call is yours and why you chose it"
                />
              </div>
              {error && <p className="text-sm text-red-400" role="alert">Stopped: {error}</p>}
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-amber-600 px-5 py-2.5 font-medium hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? 'Recording decision…' : 'Record decision'}
              </button>
            </form>
          )}
        </div>
      )}

      {state.state === 'resuming' && (
        <p className="animate-pulse text-sm text-sky-300" role="status">
          Starting new invocation… claiming the decision exactly once…
        </p>
      )}

      {state.state === 'completed' && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-slate-900/70 p-4">
              <h3 className="mb-1 text-sm font-semibold text-emerald-300">Consumption receipt</h3>
              <p className="font-mono text-xs break-all text-slate-300">{state.consumption?.receiptId}</p>
              <p className="mt-1 font-mono text-xs break-all text-slate-500">{state.consumption?.decisionDigest}</p>
              <p className="mt-1 font-mono text-xs text-slate-400">bound to {state.consumption?.successorInvocationId}</p>
            </div>
            <div className="rounded-lg bg-slate-900/70 p-4">
              <h3 className="mb-1 text-sm font-semibold text-emerald-300">Effect — {state.effect?.mode}</h3>
              <p className="text-sm text-slate-200">
                {state.effect?.effect} · exact payload prepared ·
                <span className="text-emerald-400"> no external mutation performed</span>
              </p>
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
                {JSON.stringify(state.effect?.exactPayload, null, 1)}
              </pre>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-200">Typed artifacts — validated against HACP v0.1-draft</h3>
            <ul className="flex flex-wrap gap-2">
              {state.artifacts.map(a => (
                <li
                  key={a.name}
                  className={`rounded-full border px-3 py-1 font-mono text-xs ${a.valid ? 'border-emerald-700/70 text-emerald-300' : 'border-red-700 text-red-400'}`}
                >
                  {a.name} {a.valid ? '✓' : '✗'}
                </li>
              ))}
            </ul>
          </div>

          {state.decision && (
            <p className="text-sm text-slate-300">
              Your recorded decision: <span className="font-mono">{state.decision.choice}</span> — “{state.decision.rationale}”
            </p>
          )}

          {(state.replayProbe || !readOnly) && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Prove the gate: attempt a duplicate resume</h3>
              <p className="mb-3 text-xs text-slate-400">
                A second invocation tries to claim the same decision. It must fail closed.
              </p>
              {!readOnly && (
                <button
                  onClick={attemptDuplicate}
                  disabled={replaying}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:border-slate-400 disabled:opacity-40"
                >
                  {replaying ? 'Attempting…' : 'Attempt duplicate resume'}
                </button>
              )}
              {state.replayProbe && (
                <p className={`mt-3 rounded-lg px-3 py-2 font-mono text-xs ${state.replayProbe.result.startsWith('REJECTED') ? 'bg-red-950/60 text-red-300' : 'bg-red-950/80 text-red-200'}`} role="alert">
                  {state.replayProbe.result} — {state.replayProbe.detail}
                </p>
              )}
            </div>
          )}

          {readOnly ? watchNotice : (
            <button onClick={resetConsole} className="text-xs text-slate-500 underline hover:text-slate-300">
              Reset demo
            </button>
          )}
        </div>
      )}
    </section>
  )
}
