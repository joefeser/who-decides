export const EVIDENCE_INTEGRITY_DEFECT = 'EVIDENCE_INTEGRITY — proof observed labels outran test bodies'

export type FixtureInventory = { id: string, expected: string }
export type CaseReceipt = { id: string, test: string, status: 'passed' | 'failed', evidence?: unknown }

export function deriveProofInventory(inventory: FixtureInventory[], receipts: CaseReceipt[]) {
  const known = new Set(inventory.map(item => item.id))
  const passed = new Map<string, CaseReceipt>()
  for (const receipt of receipts) {
    if (!known.has(receipt.id)) throw new Error(`UNKNOWN_FIXTURE_RECEIPT:${receipt.id}`)
    if (receipt.status === 'passed') passed.set(receipt.id, receipt)
  }
  return inventory.map(item => ({ id:item.id, required:item.expected,
    status:passed.has(item.id)?'observed' as const:'uncovered' as const,
    receipt:passed.get(item.id)??null }))
}
