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
