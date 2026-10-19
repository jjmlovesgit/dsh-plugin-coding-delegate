#!/usr/bin/env node
/**
 * Run scripts/check-contract.cjs across every contract in tests/contracts.
 *
 * TWO DIRECTORIES, ONE STANDARD. `tools/*.ts` and `src/core/primitives/*.ts` are both Tier 1 in the
 * policy, and this script used to know only the first. A primitive under the reserved path could have
 * shipped with no contract and no discrimination fixture while this gate reported that every contract
 * was well-formed -- the same one-directional blind spot that let `tools/zz-orphan-probe.ts` pass
 * before the reverse check existed. The reverse pass below therefore walks BOTH directories.
 *
 * A contract with no module is a FAILURE, not a skip. It means either the module was renamed without
 * the contract, or a contract was written for a unit that never landed; both leave the suite claiming
 * coverage it does not have.
 *
 * `.ts` only, and never `.d.ts`. The contract boundary is the utility modules; `tools/worker-build.mjs`
 * is a dispatcher that no contract governs. Exempting by EXTENSION rather than by a list of names
 * means a new dispatcher does not have to be remembered here, and a new utility cannot slip past by
 * not being listed.
 *
 * A spawn failure is reported AS a spawn failure. `status` is null when the child never ran, and
 * reporting that as an unfit contract sends the reader to inspect the wrong file.
 *
 * Kept in Node rather than a shell loop so it behaves identically under cmd, PowerShell and sh.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const CONTRACTS_DIR = path.join(REPO_ROOT, 'tests', 'contracts')
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-contract.cjs')

/** Every directory the policy calls Tier 1, with the label used in messages. */
const MODULE_DIRS = [
  { dir: path.join(REPO_ROOT, 'tools'), label: 'tools/' },
  { dir: path.join(REPO_ROOT, 'src', 'core', 'primitives'), label: 'src/core/primitives/' },
]

if (!fs.existsSync(CONTRACTS_DIR)) {
  console.error('ERROR  no tests/contracts directory at ' + CONTRACTS_DIR)
  process.exit(1)
}

/** Modules under one Tier 1 directory, as { base, rel, abs }. A missing directory is empty, not fatal. */
function listModules(entry) {
  if (!fs.existsSync(entry.dir)) return []
  return fs
    .readdirSync(entry.dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .sort()
    .map((file) => ({
      base: file.replace(/\.ts$/, ''),
      rel: entry.label + file,
      abs: path.join(entry.dir, file),
    }))
}

const modules = MODULE_DIRS.flatMap(listModules)
const byBase = new Map(modules.map((module) => [module.base, module]))
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
  const module = byBase.get(base)

  console.log('=== ' + contract + '  vs  ' + (module ? module.rel : '(no module)') + ' ===')

  if (!module) {
    console.error('  FAIL  no module under ' + MODULE_DIRS.map((d) => d.label).join(' or ') + ' for ' + base)
    failed += 1
    console.log('')
    continue
  }

  const result = spawnSync(
    process.execPath,
    [CHECKER, '--contract', path.join(CONTRACTS_DIR, contract), '--module', module.abs],
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

// --- the reverse direction: every Tier 1 module must have a contract -----------------
//
// Deliberately NOT folded into the loop above. That loop is driven by the contracts, so it cannot see a
// module that has none; the two directions fail for different reasons and name different files.
console.log('=== module -> contract parity (' + modules.length + ' Tier 1 module(s)) ===')

for (const module of modules) {
  const contractPath = path.join(CONTRACTS_DIR, module.base + '.contract.cjs')
  if (!fs.existsSync(contractPath)) {
    console.error('  FAIL  ' + module.rel + ' has no contract at tests/contracts/' + module.base + '.contract.cjs')
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
    modules.length +
    ' Tier 1 module(s) have a contract.'
)
