#!/usr/bin/env node
/**
 * Discrimination gate: every contract must PASS its real module and FAIL a plausible defective fixture.
 *
 * WHY THIS EXISTS ALONGSIDE scripts/check-contract.cjs. That guard judges a contract against a NULL
 * implementation, which answers every property with itself. Its verdict is therefore about
 * well-formedness -- does the contract reach its assertions, does it malfunction -- and it cannot speak
 * to whether a case exercises the property its NAME claims, because a null stub is not a plausible
 * wrong answer. Measured this session: a contract containing ONLY the vacuous, non-mutating corruption
 * case, the one a caller-corruptible implementation passes, is reported by check-contract.cjs as
 * "well-formed and discriminating". It was not discriminating.
 *
 * So this gate tests the other half, and it is the half that caught all three contract defects found
 * here: a case 6 that mutated nothing, a case 5 named "interleaved" that pushed and then drained, and a
 * canonicalMerge decoupling case that compared the wrong array.
 *
 * Two rules that are deliberately STRICTER than a naive version of this check:
 *
 *   1. The contract must also PASS its real module. Checking only that it fails the fixture cannot tell
 *      discrimination from a contract that fails everything -- a syntax error, a bad import, a renamed
 *      method. Without this half, the gate reports success for a contract that judges nothing.
 *   2. FAIL-CLOSED. A contract without a fixture is an error, not a skip, and a fixture without a
 *      contract is an error too. A gate that passes silently when its fixtures are missing provides no
 *      guarantee at all, which is precisely the failure it exists to prevent.
 *
 * Usage: node scripts/check-contract-fixtures.cjs
 * Exit 0 when every contract discriminates, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const CONTRACTS_DIR = path.join(ROOT, 'tests', 'contracts')
const FIXTURES_DIR = path.join(CONTRACTS_DIR, 'fixtures')
const FIXTURE_RE = /\.negative\.(ts|cjs)$/
const CONTRACT_RE = /\.contract\.cjs$/

/**
 * Run a contract, optionally aimed at a fixture through TARGET_OVERRIDE.
 *
 * The override is deleted rather than left unset when absent: a stale value in the environment would
 * otherwise silently redirect the "real module" run at a fixture, and the two halves of this check
 * would stop being independent.
 */
function runContract(contractAbs, targetOverride) {
  const env = Object.assign({}, process.env)
  if (targetOverride) env.TARGET_OVERRIDE = targetOverride
  else delete env.TARGET_OVERRIDE

  const result = spawnSync(process.execPath, ['--test', contractAbs], { env, encoding: 'utf8' })
  return {
    code: result.status,
    output: String(result.stdout || '') + String(result.stderr || ''),
  }
}

/**
 * Which cases passed and which failed, for the log. The parent test and the file-level wrapper are
 * filtered out so the list names the CASES rather than the two envelopes around them.
 */
function caseNames(contractAbs, output) {
  const src = fs.readFileSync(contractAbs, 'utf8')
  const parentMatch = /test\('([^']+)'/.exec(src)
  const parent = parentMatch ? parentMatch[1] : null
  const failed = []
  const passed = []
  const skip = (name) => name === parent || name.endsWith('.cjs')
  for (const m of output.matchAll(/^\s*not ok \d+ - (.+)$/gm)) {
    const name = m[1].trim()
    if (!skip(name)) failed.push(name)
  }
  for (const m of output.matchAll(/^\s*ok \d+ - (.+)$/gm)) {
    const name = m[1].trim()
    if (!skip(name)) passed.push(name)
  }
  return { failed, passed }
}

const contractFiles = fs.existsSync(CONTRACTS_DIR)
  ? fs.readdirSync(CONTRACTS_DIR).filter((f) => CONTRACT_RE.test(f)).sort()
  : []

if (contractFiles.length === 0) {
  console.log('No contracts found under tests/contracts. Nothing to gate.')
  process.exit(0)
}

const fixtureFiles = fs.existsSync(FIXTURES_DIR)
  ? fs.readdirSync(FIXTURES_DIR).filter((f) => FIXTURE_RE.test(f)).sort()
  : []

let failures = 0
const pass = (msg) => console.log('  ok    ' + msg)
const fail = (msg) => {
  failures++
  console.error('  FAIL  ' + msg)
}

// A fixture whose contract is gone is checking nothing, and nothing would report that.
for (const fixture of fixtureFiles) {
  const base = fixture.replace(FIXTURE_RE, '')
  if (!contractFiles.includes(base + '.contract.cjs')) {
    fail(
      'fixture ' + fixture + ' has no matching ' + base + '.contract.cjs, so it is checking nothing. ' +
        'Delete it or restore the contract it was written for.'
    )
  }
}

for (const contract of contractFiles) {
  const base = contract.replace(CONTRACT_RE, '')
  const contractAbs = path.join(CONTRACTS_DIR, contract)
  const fixture = fixtureFiles.find((f) => f.replace(FIXTURE_RE, '') === base)

  console.log('\n=== ' + contract + ' ===')

  if (!fixture) {
    fail(
      'no negative fixture for ' + contract + '. Every contract needs one: a contract that cannot fail ' +
        'a plausible wrong implementation is not evidence. Add tests/contracts/fixtures/' + base + '.negative.ts'
    )
    continue
  }

  const real = runContract(contractAbs, null)
  if (real.code === 0) {
    pass('passes the real module (exit 0)')
  } else {
    fail(
      'does NOT pass the real module (exit ' + real.code + '). A contract that fails everything is not ' +
        'discriminating, and checking only the fixture half would have reported this contract as fine.'
    )
  }

  const fixtureAbs = path.join(FIXTURES_DIR, fixture)
  const negated = runContract(contractAbs, fixtureAbs)
  if (negated.code !== 0) {
    pass('rejects ' + fixture + ' (exit ' + negated.code + ')')
  } else {
    fail(
      'PASSED the defective fixture ' + fixture + '. That fixture is deliberately wrong in a property ' +
        'this contract exists to enforce, so the contract does not discriminate.'
    )
  }

  const names = caseNames(contractAbs, negated.output)
  if (names.failed.length > 0) {
    console.log('        cases that caught it: ' + names.failed.join(' | '))
  }
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
