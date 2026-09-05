import { createHash } from 'node:crypto'

export const PROFILE_ID = 'org.hacp.local-owner-continuation'
export const PROFILE_VERSION = '0.1-candidate'

export type Digest = {
  algorithm: 'sha256'
  canonicalization: 'json-rfc8785-jcs'
  domain: string
  value: string
}

/** RFC 8785 canonical JSON for the closed records used by this profile. */
export function jcs(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS_NON_FINITE_NUMBER')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('JCS_UNPAIRED_SURROGATE')
        index += 1
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('JCS_UNPAIRED_SURROGATE')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${jcs(key)}:${jcs(record[key])}`).join(',')}}`
  }
  throw new Error('JCS_UNSUPPORTED_VALUE')
}

export function digestEnvelope(domain: string, record: unknown): Digest {
  return {
    algorithm: 'sha256',
    canonicalization: 'json-rfc8785-jcs',
    domain,
    value: createHash('sha256').update(jcs({ domain, record })).digest('hex'),
  }
}

export function recordDigest(kind: string, record: Record<string, unknown>): Digest {
  const withoutDigest = { ...record }
  delete withoutDigest.digest
  return digestEnvelope(`${PROFILE_ID}.${kind}.0.1-candidate`, withoutDigest)
}

export function equalJcs(left: unknown, right: unknown): boolean {
  return jcs(left) === jcs(right)
}
