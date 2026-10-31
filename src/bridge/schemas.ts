/* Bridge envelope/record validation. The bridge run kind produces NO
 * HACP-schema artifacts (spec §strategic frame): decision-request envelopes,
 * intake records, and bridge decisions are who-decides' own v0 schemas,
 * vendored under schemas/bridge/ and validated here — a separate pipeline
 * from src/artifacts/schemas.ts (HACP artifact kinds) and from the dry-run
 * receipt validators in src/server/state.ts.
 *
 * Like the HACP schema JSON, these are imported directly so esbuild can
 * inline them (the packager ships only the bundle; see schemas.ts). */
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import decisionRequestJson from '../../schemas/bridge/decision-request.schema.json'
import intakeJson from '../../schemas/bridge/intake.schema.json'
import decisionJson from '../../schemas/bridge/decision.schema.json'

export type BridgeArtifactKind = 'decision-request' | 'bridge-intake' | 'bridge-decision'

export type DecisionRequestOption = { id: string, label?: string }
export type DecisionRequestDigest = { algorithm: 'sha256', value: string, of?: string }

export type DecisionRequestEnvelope = {
  schema: 'who-decides.decision-request.v0'
  sourceSystem: string
  question: string
  options: DecisionRequestOption[]
  contextRefs: string[]
  digests: DecisionRequestDigest[]
}

export type BridgeIntakeRecord = {
  schema: 'who-decides.bridge-intake.v0'
  runId: string
  principal: string
  credentialRef: string
  receivedAt: string
  requestDigest: string
}

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

type SchemaObject = { $id: string } & Record<string, unknown>

const SCHEMAS: Record<BridgeArtifactKind, SchemaObject> = {
  'decision-request': decisionRequestJson as SchemaObject,
  'bridge-intake': intakeJson as SchemaObject,
  'bridge-decision': decisionJson as SchemaObject,
}

for (const schema of Object.values(SCHEMAS)) {
  if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema)
}

const validators = new Map<BridgeArtifactKind, ReturnType<typeof ajv.compile>>(
  (Object.entries(SCHEMAS) as Array<[BridgeArtifactKind, SchemaObject]>).map(
    ([kind, schema]) => [kind, ajv.compile({ $ref: schema.$id })],
  ),
)

export type BridgeValidationResult =
  | { valid: true, envelope: DecisionRequestEnvelope }
  | { valid: false, errors: string[] }

/** Parse + validate an external decision-request envelope. Strict: any extra
 * property (notably any attempt to carry an actor identity), missing field,
 * or malformed digest is a rejection — the caller never sees a partial
 * envelope. */
export function parseDecisionRequest(value: unknown): BridgeValidationResult {
  const validate = validators.get('decision-request')!
  if (validate(value)) return { valid: true, envelope: value as DecisionRequestEnvelope }
  return { valid: false, errors: formatErrors(validate.errors) }
}

/** Structural validation for the stored bridge record kinds (the same
 * no-free-green-check discipline as the receipt validators in state.ts). */
export function validateBridgeArtifact(kind: BridgeArtifactKind, artifact: unknown): boolean {
  const validate = validators.get(kind)!
  return Boolean(validate(artifact))
}

function formatErrors(errors: Array<{ instancePath?: string, schemaPath?: string, message?: string }> | null | undefined): string[] {
  return (errors ?? []).map(
    e => `${e.instancePath || '(root)'} ${e.schemaPath}: ${e.message ?? 'invalid'}`,
  )
}
