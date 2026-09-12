/* HACP v0.1-draft artifact validation. Schemas are vendored under
 * schemas/hacp/v0.1-draft/ (Apache-2.0, from github.com/joefeser/hacp —
 * see docs/disclosure.md). Every artifact the demo emits is validated
 * against the real upstream contract before it counts.
 *
 * Like fixtures/patch-scenario.json (agent-service/fixture.ts), the schema
 * JSON is imported directly so esbuild inlines it into the AgentCore
 * CodeZip bundle — the packager ships only the bundle, and a
 * cwd-relative readFileSync crashed the runtime at boot (/var/task has no
 * schemas/ directory; spike-log Day 8 addendum 4). */
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import commonDefsJson from '../../schemas/hacp/v0.1-draft/common-defs.schema.json'
import taskPacketJson from '../../schemas/hacp/v0.1-draft/task-packet.schema.json'
import humanDecisionJson from '../../schemas/hacp/v0.1-draft/human-decision.schema.json'
import agentReportJson from '../../schemas/hacp/v0.1-draft/agent-report.schema.json'
import reviewFindingJson from '../../schemas/hacp/v0.1-draft/review-finding.schema.json'
import stopResponseJson from '../../schemas/hacp/v0.1-draft/stop-response.schema.json'
import evidenceSetJson from '../../schemas/hacp/v0.1-draft/evidence-set.schema.json'

export type ArtifactKind =
  | 'task-packet'
  | 'human-decision'
  | 'agent-report'
  | 'review-finding'
  | 'stop-response'
  | 'evidence-set'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

type SchemaObject = { $id: string } & Record<string, unknown>

const SCHEMAS: Record<ArtifactKind, SchemaObject> = {
  'task-packet': taskPacketJson as SchemaObject,
  'human-decision': humanDecisionJson as SchemaObject,
  'agent-report': agentReportJson as SchemaObject,
  'review-finding': reviewFindingJson as SchemaObject,
  'stop-response': stopResponseJson as SchemaObject,
  'evidence-set': evidenceSetJson as SchemaObject,
}

// Register shared schemas (common-defs + every artifact family) under their
// declared $id so cross-refs resolve; validators compile by $ref.
for (const schema of [...Object.values(SCHEMAS), commonDefsJson as SchemaObject]) {
  if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema)
}

const validators = new Map<ArtifactKind, ReturnType<typeof ajv.compile>>(
  (Object.entries(SCHEMAS) as Array<[ArtifactKind, SchemaObject]>).map(
    ([kind, schema]) => [kind, ajv.compile({ $ref: schema.$id })],
  ),
)

export type ValidationResult =
  | { valid: true, kind: ArtifactKind }
  | { valid: false, kind: ArtifactKind, errors: string[] }

export function validateArtifact(kind: ArtifactKind, artifact: unknown): ValidationResult {
  const validate = validators.get(kind)
  if (!validate) throw new Error(`no validator loaded for ${kind}`)
  if (validate(artifact)) return { valid: true, kind }
  const errors = (validate.errors ?? []).map(
    e => `${e.instancePath || '(root)'} ${e.schemaPath}: ${e.message ?? 'invalid'}`,
  )
  return { valid: false, kind, errors }
}

export function assertValid(kind: ArtifactKind, artifact: unknown): void {
  const result = validateArtifact(kind, artifact)
  if (!result.valid) {
    throw new Error(`artifact ${kind} failed schema validation:\n${result.errors.join('\n')}`)
  }
}
