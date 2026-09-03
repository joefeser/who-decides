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
      <Console />
      <footer className="mt-10 border-t border-slate-800 pt-4 text-xs text-slate-500">
        Artifacts validate against HACP v0.1-draft JSON Schemas · dry-run effects only · no external mutation
      </footer>
    </main>
  )
}
