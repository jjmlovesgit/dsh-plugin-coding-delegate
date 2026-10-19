#!/usr/bin/env node
/**
 * Empirical flake sweep for the Tier 1 contracts (POL-SEC-AISDLC-001 §5.3).
 *
 * WHY THIS EXISTS SEPARATELY FROM delegate-unit.cjs. The harness runs a contract three times before
 * it will settle a UNIT, so the two units it produced carry 3-run stability evidence. The seven
 * primitives that were re-anchored during the coverage sweep carry a single `--prepare` execution
 * each: their bytes are attested, their contracts pass, and nothing in the ledger says whether those
 * contracts agree with themselves across repeated runs. That distinction was recorded in the ADR
 * rather than papered over; this script closes it without touching a byte of any primitive.
 *
 * IT DOES NOT RE-ATTEST AND MUST NOT. Re-running a contract changes no file, so every digest the
 * ledger records stays valid. The output is an evidence artefact, not a note: it is the measurement
 * an auditor reads when asking "were these contracts actually stable, or only passed once?".
 *
 * AGREEMENT IS A THREE-WAY VERDICT, NOT A BOOLEAN. All three runs passing is PASS; all three failing
 * is FAIL; a mix is FLAKY, and a mix is the only outcome that says the contract is nondeterministic
 * rather than the code being wrong. Collapsing that to "not all passed" would report a flaky oracle
 * as a broken unit, which is the misdiagnosis the harness's own flake loop exists to prevent.
 *
 * Usage: node scripts/flake-gate-sweep.cjs
 * Exit 0 when every contract agrees with itself across the runs, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadPolicyConfig } = require('./policy-config.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const EVIDENCE = path.join(REPO_ROOT, 'docs', 'compliance', 'evidence', 'flake-gate-sweep.txt')
const { config } = loadPolicyConfig(REPO_ROOT)
const RUNS = config.delegation.flakeIterations

/** Every contract-governed primitive, by the same extension rule the coverage gate uses. */
function primitives() {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'tools'))
    .filter((name) => /\.ts$/.test(name) && !name.endsWith('.d.ts'))
    .sort()
}

const contractFor = (file) => 'tests/contracts/' + file.replace(/\.ts$/, '.contract.cjs')

function runOnce(contract) {
  const started = Date.now()
  const result = spawnSync(process.execPath, ['--test', contract], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: result.status, ms: Date.now() - started }
}

/** Three runs and a verdict: PASS, FAIL, FLAKY, or NO_CONTRACT. */
function sweep(file) {
  const contract = contractFor(file)
  if (!fs.existsSync(path.join(REPO_ROOT, contract))) {
    return { file, contract, runs: [], verdict: 'NO_CONTRACT' }
  }
  const runs = Array.from({ length: RUNS }, () => runOnce(contract))
  const codes = [...new Set(runs.map((r) => r.status))]
  const verdict = codes.length > 1 ? 'FLAKY' : runs[0].status === 0 ? 'PASS' : 'FAIL'
  return { file, contract, runs, verdict }
}

function describe(result) {
  const times = result.runs.map((r) => (r.status === 0 ? 'pass ' : 'FAIL ') + r.ms + 'ms').join(', ')
  return '  ' + result.verdict.padEnd(11) + result.file + (times ? '  [' + times + ']' : '  [no contract]')
}

function main() {
  const files = primitives()
  console.log('=== flake sweep: ' + files.length + ' contract(s) x ' + RUNS + ' run(s) ===')
  const results = files.map(sweep)
  results.forEach((result) => console.log(describe(result)))

  const failed = results.filter((r) => r.verdict !== 'PASS')
  const header = [
    '# Tier 1 flake sweep - evidence population',
    '#',
    '# Generated : ' + new Date().toISOString(),
    '# Commit    : ' + String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout).trim(),
    '# Command   : node scripts/flake-gate-sweep.cjs',
    '# Runs      : ' + RUNS + ' per contract, each in its own subprocess',
    '# Verdicts  : PASS = all runs agreed and passed; FAIL = all agreed and failed; FLAKY = disagreement',
    '#',
    '# This artefact records CONTRACT STABILITY. It changes no file and re-attests nothing, so every',
    '# digest in refs/notes/delegations remains valid against the bytes it describes.',
    '',
  ].join('\n')
  const body = results.map((r) => r.verdict + '  ' + r.file + '  ' + r.contract).join('\n')
  fs.writeFileSync(EVIDENCE, header + body + '\n')

  console.log('\n  evidence: ' + path.relative(REPO_ROOT, EVIDENCE).split(path.sep).join('/'))
  if (failed.length > 0) {
    console.error('  ' + failed.length + ' contract(s) did not agree with themselves across ' + RUNS + ' runs.')
    process.exit(1)
  }
  console.log('  all ' + files.length + ' contracts agreed and passed ' + RUNS + '/' + RUNS + ' runs.')
}

main()
