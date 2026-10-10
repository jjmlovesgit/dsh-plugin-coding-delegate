import { canonicalisePath } from './paths'

/**
 * The scope decision for one attestation: a human claim may only cover files this unit wrote.
 *
 * `OPERATOR_ATTESTED` says a person reviewed content. Before this existed, the gate was the unit's
 * status alone, and an ANSWER-ONLY delegation reaches SUCCESS without writing anything -- so a caller
 * could name any readable path in the workspace and have it recorded as human-reviewed. The status was
 * true and the claim was unrelated to it.
 *
 * A unit that wrote files cannot reach SUCCESS unverified (resolveDelegateStatus returns UNVERIFIED),
 * so requiring membership in `filesWritten` also requires that verification ran and passed.
 *
 * Matches on canonicalised paths, the same comparison `evaluateUnitScope` uses, so redundant segments
 * and a symlinked spelling of one file are a single target rather than two. Note that
 * `canonicalisePath` resolves a RELATIVE input against process.cwd(), while `filesWritten` holds
 * absolute paths, so a relative attestTarget is refused when cwd differs from the workspace. That
 * fails closed and is deliberate.
 */
export function selectAttestableTargets(input: {
  requested: Array<string | undefined | null>
  filesWritten: Array<string | undefined | null>
  operator: string
}): { attestable: string[]; refused: string[] } {
  // No operator identity is a refusal, not a value to invent -- unchanged from the existing contract.
  if (!input.operator || !input.operator.trim()) {
    return { attestable: [], refused: input.requested.filter(Boolean).map(String) }
  }
  const written: string[] = []
  for (const f of input.filesWritten) {
    if (typeof f === 'string' && f.trim()) written.push(canonicalisePath(f))
  }
  const attestable: string[] = []
  const refused: string[] = []
  for (const raw of input.requested) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const canonical = canonicalisePath(raw)
    if (written.includes(canonical)) attestable.push(raw)
    else refused.push(raw)
  }
  return { attestable, refused }
}
