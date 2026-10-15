const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const DIST = path.join(__dirname, '..', '..', 'dist', 'attestation.js')
const { selectAttestableTargets } = require(DIST)

const WROTE = ['/ws/src/core.ts', '/ws/src/util.ts']

test('attestation scope: an answer-only unit attests nothing', () => {
  // filesWritten is empty because no file was emitted. This is the exact shape that forged a review.
  const r = selectAttestableTargets({
    requested: ['/ws/src/core.ts'],
    filesWritten: [],
    operator: 'jim',
  })
  assert.deepEqual(r.attestable, [], 'nothing may be attested by a unit that wrote nothing')
  assert.deepEqual(r.refused, ['/ws/src/core.ts'], 'and the refusal is reported, not silent')
})

test('attestation scope: a target the unit did not write is refused', () => {
  const r = selectAttestableTargets({
    requested: ['/ws/src/unrelated.ts'],
    filesWritten: WROTE,
    operator: 'jim',
  })
  assert.deepEqual(r.attestable, [])
  assert.deepEqual(r.refused, ['/ws/src/unrelated.ts'])
})

test('attestation scope: a file the unit wrote IS attested, so the fix cannot pass by refusing all', () => {
  const r = selectAttestableTargets({
    requested: ['/ws/src/core.ts'],
    filesWritten: WROTE,
    operator: 'jim',
  })
  assert.deepEqual(r.attestable, ['/ws/src/core.ts'])
  assert.deepEqual(r.refused, [])
})

test('attestation scope: two spellings of one real file are one target', () => {
  // The file must EXIST: canonicalisePath skips realpath when it does not, and a path containing '.'
  // must reach the helper unnormalised or the case asserts nothing (path.resolve would strip it first).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-scope-'))
  fs.writeFileSync(path.join(dir, 'core.ts'), 'export const x = 1\n')
  // Concatenated on purpose: `path.join(dir, '.', 'core.ts')` NORMALISES the dot away, so both
  // spellings would be byte-identical and the case would assert nothing. The sentinel on the next
  // line is what caught exactly that on this file's first run.
  const dotted = dir + path.sep + '.' + path.sep + 'core.ts'
  const plain = path.join(dir, 'core.ts')
  assert.notEqual(dotted, plain, 'the two spellings must differ as strings for this to mean anything')
  const r = selectAttestableTargets({ requested: [dotted], filesWritten: [plain], operator: 'jim' })
  assert.deepEqual(r.attestable, [dotted])
})

test('attestation scope: no operator refuses every request', () => {
  for (const operator of ['', '   ', null, undefined]) {
    const r = selectAttestableTargets({ requested: ['/ws/src/core.ts'], filesWritten: WROTE, operator })
    assert.deepEqual(r.attestable, [], 'operator ' + JSON.stringify(operator) + ' must attest nothing')
  }
})

test('attestation scope: a missing filesWritten list is empty, not a crash', () => {
  // CONTEXT_REFUSED and ERROR returns carry no filesWritten. The gate must fail closed rather than throw.
  const r = selectAttestableTargets({ requested: ['/ws/src/core.ts'], filesWritten: [], operator: 'jim' })
  assert.deepEqual(r.attestable, [])
})

// ─── Structural assertions: NO shipped path may author a human attestation ──────────────────────────
//
// WHY THESE EXIST, and why they now assert the OPPOSITE of what they used to. The cases above test a pure
// decision function, and every one of them passed while `index.ts` still looped over raw `attestTargets` --
// the fix was dead code and the vulnerability was open. Worse, the first wiring attempt landed ONLY the
// import: an unused import compiles, so the build passed, 374/374 passed, coherence passed, and the
// committed-dist check passed too, because dist had changed. A full green gate proved nothing.
//
// A pure function that passes while sitting unreferenced is the exact shape this repository keeps finding,
// so the wiring is asserted structurally rather than trusted.
//
// The wiring is now ABSENCE. Scoping the attestable set to files this unit had written narrowed the blast
// radius and never addressed the claim: the caller still chose the human's name, still wrote the evidence,
// and still triggered the record. A caller-authored attestation is the caller's claim about itself, so the
// whole route was removed from the tool surface -- and "removed" is a property that decays silently the
// moment someone re-adds the convenient-looking parameter, which is what these cases exist to prevent.
//
// `selectAttestableTargets` itself is KEPT and still tested above. It is a correct decision function with no
// caller: the honest state after removing a route is a tested function that nothing wires, not a deleted
// one whose reasoning is lost.
//
// (`fs` and `path` are already required at the top of this file.)

const SRC_INDEX = path.join(__dirname, '..', '..', 'src', 'index.ts')
const DIST_INDEX = path.join(__dirname, '..', '..', 'dist', 'index.js')
const SRC_DELEGATION = path.join(__dirname, '..', '..', 'src', 'delegation.ts')
const SRC_CONTRACTS = path.join(__dirname, '..', '..', 'src', 'contracts.ts')

test('structural: index.ts never CALLS the recorder, so a tool call cannot write a human claim', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  // The identifier may appear in prose: the removal is documented in place, and a check that forbade the
  // WORD would forbid the explanation. An invocation is what must not survive.
  assert.ok(
    !/recordOperatorAttestation\s*\(/.test(src),
    'index.ts must not CALL recordOperatorAttestation -- that call is how a model-authored OPERATOR_ATTESTED record was written'
  )
  assert.ok(
    !/selectAttestableTargets\s*\(/.test(src),
    'index.ts must not call selectAttestableTargets either: a scoped route is still a caller-authored claim'
  )
})

test('structural: the attesting parameters are gone from BOTH the schema and the canonical list', () => {
  // Both halves are checked because the two are coupled by a compile-time set-equality assertion: removing
  // one alone fails the build, and this case says so in a place a reader will find before the compiler.
  const delegation = fs.readFileSync(SRC_DELEGATION, 'utf8')
  const contracts = fs.readFileSync(SRC_CONTRACTS, 'utf8')
  for (const name of ['attestTargets', 'attestEvidence', 'attestOperator']) {
    assert.ok(
      !new RegExp('^\\s+' + name + ':\\s*\\{', 'm').test(delegation),
      name + ' must not be a property of the tool schema in delegation.ts'
    )
    assert.ok(
      !new RegExp("^\\s*\\|\\s*'" + name + "'", 'm').test(contracts),
      name + ' must not be a member of DelegateWorkerParameter in contracts.ts'
    )
  }
})

test('structural: the built bundle carries the removal, so src and dist agree', () => {
  // The published artefact is dist. Asserting only the source would pass on a tree whose build was stale --
  // the failure mode that made this repository commit a dist-in-sync CI step in the first place. The
  // compiled call site reads `(0, contracts_1.recordOperatorAttestation)(`, so the pattern is the name
  // followed by a closing parenthesis; a bare name match would find the require() binding and the export.
  const dist = fs.readFileSync(DIST_INDEX, 'utf8')
  assert.ok(
    !/recordOperatorAttestation\)\(/.test(dist),
    'dist/index.js must not CALL the recorder; rebuild from the fixed source if this fails'
  )
  assert.ok(
    !dist.includes('scope.attestable'),
    'dist/index.js must not contain the removed scoped attestation loop'
  )
})

