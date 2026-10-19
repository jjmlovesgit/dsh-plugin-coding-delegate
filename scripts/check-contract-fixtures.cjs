#!/usr/bin/env node
/**
 * Discrimination gate: every contract must PASS its real module and FAIL a plausible defective fixture.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/check-contract.cjs. That guard judges a contract against a NULL
 * implementation, which answers every property with itself. Its verdict is therefore about
 * well-formedness -- does the contract reach its assertions, does it malfunction -- and it cannot speak
 * to whether a case exercises the property its NAME claims, because a null stub is not a plausible
 * wrong answer. Measured: a contract containing ONLY the vacuous, non-mutating corruption case, the one
 * a caller-corruptible implementation passes, is reported by check-contract.cjs as "well-formed and
 * discriminating". It was not discriminating.
 *
 * So this gate tests the other half: the half that caught all three contract defects found here -- a
 * case 6 that mutated nothing, a case 5 named "interleaved" that pushed and then drained, and a
 * canonicalMerge decoupling case that compared the wrong array.
 *
 * THE CONTRACT IS NEVER MODIFIED. The negative run mirrors the contract into a temporary tree where
 * `../../tools/<name>.ts` resolves to the fixture, so the contract file it executes is a byte-identical
 * copy of the one under tests/contracts.
 *
 * WHY THAT MATTERS RATHER THAN BEING TIDINESS. The contract's SHA-256 is sealed into the delegation
 * attestation as `contractHash`. An earlier revision of this gate pointed the contract at the fixture
 * through a `TARGET_OVERRIDE` environment variable, which required a test-only branch INSIDE the
 * contract. That changed the contract's bytes and broke hash parity with both existing notes:
 * recorded 52786a81 against an actual ef234a4d, recorded a05234be against an actual e439f2f8. Signature
 * and artifact hashes survived; the property that the record binds the exact bytes that judged the
 * module did not. Mirroring leaves the contract untouched and the parity intact.
 *
 * TWO RULES THAT ARE DELIBERATELY STRICTER THAN THE OBVIOUS VERSION, each closing a way for the GATE
 * ITSELF to report success:
 *
 *   1. The contract must also PASS its real module. Checking only that it fails the fixture cannot tell
 *      discrimination from a contract that fails everything -- a syntax error, a bad import, a renamed
 *      method -- and would report such a contract as fine.
 *   2. FAIL-CLOSED. A contract without a fixture is an error, a fixture without a contract is an error,
 *      and a missing fixtures directory is an error. A gate that passes when its fixtures are absent
 *      provides no guarantee at all, which is the failure it exists to prevent.
 *
 * Usage: node scripts/check-contract-fixtures.cjs
 * Exit 0 when every contract discriminates, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const CONTRACTS_DIR = path.join(REPO_ROOT, 'tests', 'contracts')
const FIXTURES_DIR = path.join(CONTRACTS_DIR, 'fixtures')
const CONTRACT_RE = /\.contract\.cjs$/
const FIXTURE_RE = /\.negative\.(ts|cjs)$/

const die = (message) => {
  console.error('ERROR  ' + message)
  process.exit(1)
}

if (!fs.existsSync(CONTRACTS_DIR)) die('no tests/contracts directory at ' + CONTRACTS_DIR)

const contractFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => CONTRACT_RE.test(f)).sort()
if (contractFiles.length === 0) die('no *.contract.cjs files under tests/contracts')

// FAIL-CLOSED: a missing fixtures directory is an error, not a reason to skip. A gate that goes green
// when its fixtures are gone guarantees nothing, and nothing downstream would report the difference.
if (!fs.existsSync(FIXTURES_DIR)) {
  die(
    'no tests/contracts/fixtures directory. Every contract needs a negative fixture; refusing to ' +
      'report success with nothing to discriminate against.'
  )
}

const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => FIXTURE_RE.test(f)).sort()
if (fixtureFiles.length === 0) {
  die('tests/contracts/fixtures is empty. Every contract needs a negative fixture.')
}

const baseOfContract = (file) => file.replace(CONTRACT_RE, '')
const baseOfFixture = (file) => file.replace(FIXTURE_RE, '')

// Bi-directional pairing, both directions fatal: a contract with no fixture is unchecked, and a fixture
// with no contract is dead weight that looks like coverage.
for (const contract of contractFiles) {
  const base = baseOfContract(contract)
  if (!fixtureFiles.some((f) => baseOfFixture(f) === base)) {
    die(
      contract + ' has no matching negative fixture. Add tests/contracts/fixtures/' + base +
        '.negative.ts -- a contract that cannot fail a plausible wrong implementation is not evidence.'
    )
  }
}
for (const fixture of fixtureFiles) {
  const base = baseOfFixture(fixture)
  if (!contractFiles.includes(base + '.contract.cjs')) {
    die(
      'orphaned negative fixture ' + fixture + ': no ' + base + '.contract.cjs to check. Delete it or ' +
        'restore the contract it was written for.'
    )
  }
}

function runTests(contractAbs, cwd) {
  const result = spawnSync(process.execPath, ['--test', contractAbs], { cwd, encoding: 'utf8' })
  return {
    code: result.status,
    output: String(result.stdout || '') + String(result.stderr || ''),
  }
}

/** Which CASES failed, for the log. Parent test and file wrapper are filtered out. */
function failedCaseNames(contractAbs, output) {
  const src = fs.readFileSync(contractAbs, 'utf8')
  const parentMatch = /test\('([^']+)'/.exec(src)
  const parent = parentMatch ? parentMatch[1] : null
  const passed = []
  const failed = []
  for (const m of output.matchAll(/^\s*not ok \d+ - (.+)$/gm)) {
    const name = m[1].trim()
    if (name !== parent && !name.endsWith('.cjs')) failed.push(name)
  }
  for (const m of output.matchAll(/^\s*ok \d+ - (.+)$/gm)) {
    const name = m[1].trim()
    if (name !== parent && !name.endsWith('.cjs')) passed.push(name)
  }
  return { failed, passed }
}

let failures = 0
const pass = (msg) => console.log('  ok    ' + msg)
const fail = (msg) => {
  failures++
  console.error('  FAIL  ' + msg)
}

for (const contract of contractFiles) {
  const base = baseOfContract(contract)
  const contractAbs = path.join(CONTRACTS_DIR, contract)
  const fixture = fixtureFiles.find((f) => baseOfFixture(f) === base)
  const fixtureAbs = path.join(FIXTURES_DIR, fixture)

  console.log('\n=== ' + contract + ' (fixture: ' + fixture + ') ===')

  // --- half one: it must pass the module it was written for -----------------
  const real = runTests(contractAbs, REPO_ROOT)
  if (real.code === 0) {
    pass('passes the real module (exit 0)')
  } else {
    fail(
      'does NOT pass the real module (exit ' + real.code + '). A contract that fails everything is not ' +
        'discriminating, and checking only the fixture half would have called this contract fine.'
    )
  }

  // --- half two: it must reject the fixture, without modifying the contract --
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fixture-' + base + '-'))
  let negated
  try {
    // The contract reaches its module as a path relative to tests/contracts, so the fixture takes
    // exactly that position and the contract file is copied byte-for-byte. BOTH Tier 1 layouts are
    // populated: a contract may reach `../../tools/<base>.ts` or `../../src/core/primitives/<base>.ts`,
    // and mirroring both means the runner never has to parse the contract to learn which one it is.
    const extension = path.extname(fixture)
    for (const mirrorModuleDir of [
      path.join(mirrorRoot, 'tools'),
      path.join(mirrorRoot, 'src', 'core', 'primitives'),
    ]) {
      fs.mkdirSync(mirrorModuleDir, { recursive: true })
      fs.copyFileSync(fixtureAbs, path.join(mirrorModuleDir, base + extension))
    }
    const mirrorContracts = path.join(mirrorRoot, 'tests', 'contracts')
    fs.mkdirSync(mirrorContracts, { recursive: true })
    const mirroredContract = path.join(mirrorContracts, contract)
    fs.copyFileSync(contractAbs, mirroredContract)

    negated = runTests(mirroredContract, mirrorRoot)
  } finally {
    fs.rmSync(mirrorRoot, { recursive: true, force: true })
  }

  if (negated.code !== 0) {
    pass('rejects ' + fixture + ' (exit ' + negated.code + ')')
  } else {
    fail(
      'PASSED the defective fixture ' + fixture + '. That fixture is deliberately wrong in a property ' +
        'this contract exists to enforce, so the contract does not discriminate.'
    )
  }

  const names = failedCaseNames(contractAbs, negated.output)
  if (names.failed.length > 0) console.log('        cases that caught it: ' + names.failed.join(' | '))
  if (negated.code !== 0 && names.passed.length === 0) {
    fail(
      'the fixture fails EVERY case, so it is not evidence about any particular property. Make it ' +
        'correct in every respect except the one under test.'
    )
  }
}

console.log('')
if (failures > 0) {
  console.error(failures + ' discrimination check(s) failed.')
  process.exit(1)
}
console.log('All contracts pass their own module and reject their negative fixture.')
