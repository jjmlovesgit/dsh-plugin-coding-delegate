// Oracle for the attestation identity contract: a human must be named, and never invented.
//
// WHY THIS EXISTS. The first version of the tool-mediated attestation fell back to `exec.agent.id`, and a
// live probe recorded `operator: "session-f0387683-dc72-49"` in the registry. That inverts the thing the
// verdict is for: the record looks like human sign-off while naming an ephemeral LLM session, which is LESS
// attributable than a typed name rather than more. Nothing failed -- the tool reported success and the
// socket accepted it -- so no amount of end-to-end verification would have caught it. Only asking "who
// does this actually name" does.
//
// Two properties, and they fail in opposite directions, which is why both are asserted:
//
//   1. A named operator is recorded VERBATIM. Attribution that gets truncated, lowercased or defaulted is
//      attribution you cannot act on.
//   2. Missing attribution REFUSES rather than inventing one. `recordOperatorAttestation` returns null for
//      an empty operator -- it does not mint a placeholder, and there is no code path that reaches for the
//      agent id.
//
// Written as `.mjs` for the same reason as the promotion oracle: the plugin's write guard classifies `.cjs`
// as source and refuses it to a cloud context, so the test lives under an extension it does not block.
//
// Run directly:  node --test plugin/tests/oracles/attestation-identity.oracle.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS = path.join(HERE, '..', '..', 'dist', 'contracts.js')
const require = createRequire(import.meta.url)
const { recordOperatorAttestation, loadDelegatedRegistry } = require(CONTRACTS)

/**
 * The registry path is derived from env at module load, so it is set before the first call rather than
 * inside the cases. Each case gets its own data directory, and therefore its own registry.
 */
function withRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-'))
  process.env.DSH_LOCAL_ROUTER_DATA_DIR = dir
  const target = path.join(dir, 'thing.ts')
  fs.writeFileSync(target, 'export const x = 1\n')
  return { dir, target }
}

test('attestation: the named operator is recorded verbatim', () => {
  const { target } = withRegistry()
  const record = recordOperatorAttestation(target, 'jim', 'reviewed by hand')
  assert.ok(record, 'an attestation with a name and evidence must be recorded')
  assert.equal(record.outcome, 'OPERATOR_ATTESTED')
  assert.equal(record.attestation.operator, 'jim', 'attribution must survive unchanged')
  assert.equal(record.attestation.evidence, 'reviewed by hand')
  assert.equal(record.succeeded, false, 'and it is never a machine success')
})

test('attestation: whitespace around the name is trimmed, not preserved', () => {
  const { target } = withRegistry()
  const record = recordOperatorAttestation(target, '  jim  ', '  reviewed  ')
  assert.equal(record.attestation.operator, 'jim')
  assert.equal(record.attestation.evidence, 'reviewed')
})

test('attestation: an empty or missing operator REFUSES rather than inventing one', () => {
  const { target } = withRegistry()
  // The whole point. A placeholder here would be indistinguishable from a real signature in the ledger,
  // and an audit record that names nobody is worse than an absent one because it looks like evidence.
  for (const operator of ['', '   ', null, undefined]) {
    assert.equal(
      recordOperatorAttestation(target, operator, 'evidence'),
      null,
      'operator ' + JSON.stringify(operator) + ' must not produce a record'
    )
  }
  assert.equal(
    loadDelegatedRegistry().filter((r) => r.outcome === 'OPERATOR_ATTESTED').length,
    0,
    'and nothing was written for any of them'
  )
})

test('attestation: evidence is required as well, for the same reason', () => {
  const { target } = withRegistry()
  for (const evidence of ['', '   ', null, undefined]) {
    assert.equal(
      recordOperatorAttestation(target, 'jim', evidence),
      null,
      'evidence ' + JSON.stringify(evidence) + ' must not produce a record'
    )
  }
})

test('attestation: the recorded hash is read from DISK, not supplied by the caller', () => {
  // A caller-supplied hash would let an attestation describe bytes that were never on disk, which is the
  // one thing this verdict must not permit. There is no hash parameter, and this pins the consequence.
  const { target } = withRegistry()
  const onDisk = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  const record = recordOperatorAttestation(target, 'jim', 'reviewed')
  assert.equal(record.sha256, onDisk, 'the record must describe the bytes that were actually there')

  fs.writeFileSync(target, 'export const x = 2\n')
  const after = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  assert.notEqual(record.sha256, after, 'and an edit after the fact must invalidate it')
})

test('attestation: an unreadable file cannot be attested', () => {
  const { dir } = withRegistry()
  assert.equal(
    recordOperatorAttestation(path.join(dir, 'does-not-exist.ts'), 'jim', 'reviewed'),
    null,
    'nothing to hash means nothing to attest'
  )
})
