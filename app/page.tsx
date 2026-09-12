import Console from './console'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-3xl font-bold">who decides?</h1>
        <p className="text-sm text-slate-400">
          A Strands agent that works in the background and surfaces only when there is a real human decision.
        </p>
      </header>
      <details className="mb-6 rounded-lg border border-slate-700 bg-slate-900/70 p-4 text-sm">
        <summary className="cursor-pointer font-medium text-slate-200">What am I looking at?</summary>
        <div className="mt-3 space-y-2 text-slate-300">
          <p>
            A Strands agent works a bounded job in the background — here, a dependency security
            patch with one genuine judgment call. When it reaches a decision that belongs to a
            human, it stops and emits a <strong>typed decision request</strong> (question,
            evidence, tradeoff), and nothing executes until a person approves with a written
            rationale.
          </p>
          <p>
            You are seeing the console&rsquo;s current run in <strong>watch mode</strong>: the
            state, receipts, and artifacts are live server data (the same JSON is served at{' '}
            <code className="rounded bg-slate-950 px-1.5 py-0.5">GET /api/state</code>), but
            starting runs and deciding require the operator passcode.
          </p>
          <p>
            The loop, end to end: run &rarr; typed decision request &rarr; the agent halts &rarr;
            a human decides &rarr; resume executes only the approved branch &rarr; receipts prove
            the decision was consumed exactly once. Sign in below to run it yourself — locally,
            the whole demo is reproducible from the repo&rsquo;s README Quickstart.
          </p>
        </div>
      </details>
      <Console />
      <footer className="mt-10 border-t border-slate-800 pt-4 text-xs text-slate-500">
        Artifacts validate against HACP v0.1-draft JSON Schemas · dry-run effects only · no external mutation
      </footer>
    </main>
  )
}
