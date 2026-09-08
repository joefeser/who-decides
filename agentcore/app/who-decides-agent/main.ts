/* Container entrypoint: the Dockerfile compiles this to dist/agent.cjs.
 * The service exports its handler without opening a listener on import.
 * AgentCore requires HTTP on 0.0.0.0:8080 with /ping and /invocations.
 */
import { server } from '../../../src/agent-service/server'

const PORT = Number(process.env.WD_AGENT_PORT ?? 8080)

if (!server.listening) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[agentcore] who-decides agent listening on 0.0.0.0:${PORT}`)
  })
}
