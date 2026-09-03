/* HACP v0.1-draft artifact validation. Schemas are vendored under
 * schemas/hacp/v0.1-draft/ (Apache-2.0, from github.com/joefeser/hacp —
 * see docs/disclosure.md). Every artifact the demo emits is validated
 * against the real upstream contract before it counts. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

export const SCHEMA_DIR = path.resolve(process.cwd(), 'schemas/hacp/v0.1-draft')

export type ArtifactKind =
  | 'task-packet'
  | 'human-decision'
  | 'agent-report'
  | 'review-finding'
  | 'stop-response'
  | 'evidence-set'

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

const SCHEMA_FILES: Record<ArtifactKind, string> = {
  'task-packet': 'task-packet.schema.json',
  'human-decision': 'human-decision.schema.json',
  'agent-report': 'agent-report.schema.json',
  'review-finding': 'review-finding.schema.json',
  'stop-response': 'stop-response.schema.json',
  'evidence-set': 'evidence-set.schema.json',
}

// Register shared schemas (common-defs + every artifact family) under their
// declared $id so cross-refs resolve; validators compile by $ref.
for (const file of Object.values(SCHEMA_FILES).concat('common-defs.schema.json')) {
  const schema = JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf8'))
  const id = schema.$id as string
  if (!ajv.getSchema(id)) ajv.addSchema(schema)
}

const validators = new Map<ArtifactKind, ReturnType<typeof ajv.compile>>()
for (const [kind, file] of Object.entries(SCHEMA_FILES) as Array<[ArtifactKind, string]>) {
  const schema = JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf8'))
  const id = schema.$id as string
  if (!ajv.getSchema(id)) ajv.addSchema(schema)
  validators.set(kind, ajv.compile({ $ref: id }))
}

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
