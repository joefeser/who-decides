/* Next.js instrumentation hook: runs once at server startup, before any
 * route can create a run. A configured-but-missing AgentCore SDK fails
 * HERE (reported via /api/state health metadata), not mid-request. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAgentDispatcher } = await import('./src/server/agent-dispatch-wiring')
    initAgentDispatcher()
  }
}
