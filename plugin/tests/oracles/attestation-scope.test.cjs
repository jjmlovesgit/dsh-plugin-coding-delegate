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

// ─── Structural assertions: the gate must actually USE this function ────────────────────────────────
//
// WHY THESE EXIST, and they are the most important cases in the file. Every case above tests the pure
// decision, and every one of them passed while `index.ts` still looped over raw `attestTargets` -- the
// fix was dead code and the vulnerability was open. Worse, the first wiring attempt landed ONLY the
// import: an unused import compiles, so build passed, 374/374 passed, coherence passed, and the
// committed-dist check passed too, because dist had changed. A full green gate proved nothing.
//
// A pure function that passes while sitting unreferenced is the exact shape this repository keeps
// finding, so the wire-up is asserted structurally rather than trusted. These read the source because
// the source IS the artefact that failed: dist is generated from it, and a check on dist alone would
// not say which side drifted.
// (`fs` and `path` are already required at the top of this file.)

const SRC_INDEX = path.join(__dirname, '..', '..', 'src', 'index.ts')
const DIST_INDEX = path.join(__dirname, '..', '..', 'dist', 'index.js')

test('structural: index.ts imports AND invokes the scope function', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /import\s*\{[^}]*\bselectAttestableTargets\b[^}]*\}\s*from\s*['"]\.\/attestation['"]/,
    'index.ts must import selectAttestableTargets from ./attestation'
  )
  // Invocation, not just the name, AND as the direct source of `scope`.
  //
  // The catch that makes this precise: an earlier version of this check only looked for the name
  // followed by `(`, and a mutation that rewrote the assignment to
  //   const scope = ({ attestable: attestTargets }) || selectAttestableTargets({...})
  // kept the name, kept the call syntactically, and left `scope` holding the RAW targets -- the original
  // vulnerability restored, with every structural check still green. A `!==`/`||` guard is a trivial way
  // to ensure a real fix is evaluated only when it never matters.
  //
  // So: `scope` must be assigned FROM a call to this function, with no expression before it.
  assert.match(
    src,
    /const\s+scope\s*=\s*selectAttestableTargets\s*\{?\s*\(/,
    'index.ts must assign `scope` directly from a call to selectAttestableTargets; a fallback expression before it defeats the fix'
  )
  // Belt and braces: no fallback operator may sit between the assignment and the call.
  assert.doesNotMatch(
    src,
    /const\s+scope\s*=\s*[^\n]{0,80}(?:\|\||&&|\?\?|!==|===)\s*[^\n]{0,80}selectAttestableTargets/,
    'selectAttestableTargets must not appear as the right-hand side of a fallback expression'
  )
})

test('structural: the attestation loop iterates the SCOPED set, never raw attestTargets', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.ok(
    src.includes('for (const target of scope.attestable)'),
    'the recording loop must iterate scope.attestable'
  )
  assert.ok(
    !src.includes('for (const target of attestTargets)'),
    'the raw attestTargets loop must be GONE -- this is the loop that forged a review'
  )
})

test('structural: refused targets are reported into attestationErrors', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /verdict\.attestationErrors\s*=\s*scope\.refused\.map\(/,
    'scope.refused must be mapped into verdict.attestationErrors, not silently dropped'
  )
})

test('structural: the built bundle carries the scoped loop, so src and dist agree', () => {
  // The published artefact is dist. Asserting only the source would pass on a tree whose build was
  // stale -- the failure mode that made this repository commit a dist-in-sync CI step in the first place.
  const dist = fs.readFileSync(DIST_INDEX, 'utf8')
  assert.ok(
    dist.includes('scope.attestable'),
    'dist/index.js must iterate scope.attestable; rebuild if this fails'
  )
  assert.ok(
    !dist.includes('for (const target of attestTargets)'),
    'dist/index.js must not contain the old raw-target loop'
  )
})

