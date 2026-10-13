#!/usr/bin/env node
/**
 * Run scripts/check-contract.cjs across every contract in tests/contracts.
 *
 * WHY THIS WRAPPER EXISTS. check-contract.cjs judges ONE contract and takes `--contract` and
 * `--module`. Run with no arguments it exits 2 on bad usage, so a bare `node scripts/check-contract.cjs`
 * is not a usable gate -- it fails for a reason that has nothing to do with any contract. This walks the
 * directory and pairs each contract with the module of the same name, which is the convention the
 * audit's contractHash check already depends on: `tools/<name>.ts` <-> `tests/contracts/<name>.contract.cjs`.
 *
 * A contract with no module is a FAILURE, not a skip. It means either the module was renamed without the
 * contract, or a contract was written for a unit that never landed; both leave the suite claiming
 * coverage it does not have.
 *
 * AND THE REVERSE, which this file did not check until the claim was tested rather than asserted. A module
 * with no contract is the same failure from the other side -- a utility nothing proves anything about --
 * and it went unreported because this walked `tests/contracts` and never `tools/`. MEASURED: adding
 * `tools/zz-orphan-probe.ts` left this script printing "All 7 contracts are well-formed" and exiting 0, so
 * the 1:1 invariant held only because the two counts happened to match. A coincidence is not an invariant,
 * and "every module has a contract" is exactly the kind of claim a green run invites a reader to over-read.
 *
 * `.ts` only, and never `.d.ts`. The contract boundary is the utility modules; `tools/worker-build.mjs` is
 * a dispatcher that no contract governs. Exempting by EXTENSION rather than by a list of names means a new
 * dispatcher does not have to be remembered here, and a new utility cannot slip past by not being listed.
 *
 * A spawn failure is reported AS a spawn failure. `status` is null when the child never ran, and
 * reporting that as an unfit contract sends the reader to inspect the wrong file -- the same distinction
 * worker-build.mjs had to draw.
 *
 * Kept in Node rather than a shell loop so it behaves identically under cmd, PowerShell and sh: the
 * package.json script that calls it must work on every host this repository is checked out on.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const CONTRACTS_DIR = path.join(REPO_ROOT, 'tests', 'contracts')
const TOOLS_DIR = path.join(REPO_ROOT, 'tools')
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-contract.cjs')

if (!fs.existsSync(CONTRACTS_DIR)) {
  console.error('ERROR  no tests/contracts directory at ' + CONTRACTS_DIR)
  process.exit(1)
}

const contracts = fs
  .readdirSync(CONTRACTS_DIR)
  .filter((file) => file.endsWith('.contract.cjs'))
  .sort()

if (contracts.length === 0) {
  console.error('ERROR  no *.contract.cjs files under tests/contracts')
  process.exit(1)
}

let failed = 0

for (const contract of contracts) {
  const base = contract.replace(/\.contract\.cjs$/, '')
  const moduleRelative = 'tools/' + base + '.ts'
  const modulePath = path.join(REPO_ROOT, moduleRelative)

  console.log('=== ' + contract + '  vs  ' + moduleRelative + ' ===')

  if (!fs.existsSync(modulePath)) {
    console.error('  FAIL  no module at ' + moduleRelative + ' for this contract')
    failed += 1
    console.log('')
    continue
  }

  const result = spawnSync(
    process.execPath,
    [CHECKER, '--contract', path.join(CONTRACTS_DIR, contract), '--module', modulePath],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )

  if (result.error) {
    console.error('  FAIL  check-contract.cjs could not be RUN: ' + result.error.message)
    console.error('  this is an environment failure, not a verdict on the contract')
    failed += 1
    console.log('')
    continue
  }

  const output = String(result.stdout || '') + String(result.stderr || '')
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('OK:') || trimmed.startsWith('The contract is not fit')) {
      console.log('  ' + trimmed)
    }
  }

  if (result.status !== 0) {
    console.error('  FAIL  check-contract.cjs reported this contract unfit (exit ' + result.status + ')')
    failed += 1
  }
  console.log('')
}

// --- the reverse direction: every utility module must have a contract -----------------
//
// Deliberately NOT folded into the loop above. That loop is driven by the contracts, so it cannot see a
// module that has none; the two directions fail for different reasons and name different files, and a
// reader fixing one of them should not have to work out which pass reported it.
if (!fs.existsSync(TOOLS_DIR)) {
  console.error('ERROR  no tools directory at ' + TOOLS_DIR)
  process.exit(1)
}

const toolModules = fs
  .readdirSync(TOOLS_DIR)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort()

console.log('=== module -> contract parity (' + toolModules.length + ' utility module(s)) ===')

for (const toolFile of toolModules) {
  const base = toolFile.replace(/\.ts$/, '')
  const contractPath = path.join(CONTRACTS_DIR, base + '.contract.cjs')
  if (!fs.existsSync(contractPath)) {
    console.error(
      '  FAIL  tools/' + toolFile + ' has no contract at tests/contracts/' + base + '.contract.cjs'
    )
    failed += 1
  }
}
console.log('')

if (failed > 0) {
  console.error(failed + ' well-formedness or module-parity failure(s).')
  process.exit(1)
}

console.log(
  'All ' +
    contracts.length +
    ' contracts are well-formed and bound to a module, and all ' +
    toolModules.length +
    ' utility module(s) have a contract.'
)
