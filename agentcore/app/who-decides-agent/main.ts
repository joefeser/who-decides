/* AgentCore CodeZip entry point (AC-4). The @aws/agentcore CLI (0.28.1)
 * bundles exactly this file (`<codeLocation>/main.ts`, zod EntrypointSchema)
 * into a single CJS main.js via esbuild and runs it on the AgentCore Runtime
 * microVM. The AgentCore HTTP contract requires the server on 0.0.0.0:8080
 * with GET /ping and POST /invocations — the AC-1 service implements both.
 *
 * The service module starts its own listener only when run directly
 * (import.meta.url guard); under the esbuild CJS banner that guard is
 * environment-dependent, so this glue starts the exported server itself if
 * and only if nothing is listening yet (idempotent, no double-bind).
 *
 * Contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
 */
import { server } from '../../../src/agent-service/server'

const PORT = Number(process.env.WD_AGENT_PORT ?? 8080)

if (!server.listening) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[agentcore] who-decides agent listening on 0.0.0.0:${PORT}`)
  })
}
