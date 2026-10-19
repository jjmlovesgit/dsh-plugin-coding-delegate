#!/usr/bin/env node
/**
 * Empirical flake sweep for the Tier 1 contracts (POL-SEC-AISDLC-001 §5.3).
 *
 * STDOUT BY DEFAULT, DISK ONLY ON `--out`. The sweep used to write its evidence file on every run,
 * which meant running it in the inner loop dirtied the working tree with a two-line diff (a fresh
 * timestamp and commit) that nobody wanted to commit. An evidence artefact is a RELEASE product: the
 * release workflow passes `--out`, and an ordinary run prints the same table and touches nothing.
 *
 * WHY THIS EXISTS SEPARATELY FROM delegate-unit.cjs. The harness runs a contract three times before
 * it will settle a UNIT, so the units it produced carry 3-run stability evidence. The primitives that
 * were re-anchored during the coverage sweep carry a single `--prepare` execution each: their bytes
 * are attested and their contracts pass, and nothing in the ledger says whether those contracts agree
 * with themselves across repeated runs. This script closes that without touching a byte.
 *
 * AGREEMENT IS A THREE-WAY VERDICT, NOT A BOOLEAN. All three runs passing is PASS; all three failing
 * is FAIL; a mix is FLAKY, and a mix is the only outcome that says the contract is nondeterministic
 * rather than the code being wrong.
 *
 * Usage: node scripts/flake-gate-sweep.cjs [--out <file>]
 * Exit 0 when every contract agrees with itself across the runs, 1 otherwise.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadPolicyConfig } = require('./policy-config.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const { config } = loadPolicyConfig(REPO_ROOT)
const RUNS = config.delegation.flakeIterations

function fail(code, message) {
  console.error('FATAL [' + code + ']: ' + message)
  process.exit(1)
}

/** `--out <path>` is the only flag; anything else is a mistake worth reporting. */
function parseArgs(argv) {
  const params = { out: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--out') fail('ARGS', 'unknown argument ' + argv[i])
    const value = argv[i + 1]
    if (!value) fail('ARGS', '--out needs a path')
    params.out = path.resolve(REPO_ROOT, value)
    i += 1
  }
  return params
}

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

function evidenceText(results) {
  const commit = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout).trim()
  const header = [
    '# Tier 1 flake sweep - evidence population',
    '#',
    '# Generated : ' + new Date().toISOString(),
    '# Commit    : ' + commit,
    '# Command   : node scripts/flake-gate-sweep.cjs --out docs/compliance/evidence/flake-gate-sweep.txt',
    '# Runs      : ' + RUNS + ' per contract, each in its own subprocess',
    '# Verdicts  : PASS = all runs agreed and passed; FAIL = all agreed and failed; FLAKY = disagreement',
    '#',
    '# This artefact records CONTRACT STABILITY. It changes no file and re-attests nothing, so every',
    '# digest in refs/notes/delegations remains valid against the bytes it describes.',
    '',
  ].join('\n')
  return header + results.map((r) => r.verdict + '  ' + r.file + '  ' + r.contract).join('\n') + '\n'
}

function main() {
  const params = parseArgs(process.argv.slice(2))
  const files = primitives()
  console.log('=== flake sweep: ' + files.length + ' contract(s) x ' + RUNS + ' run(s) ===')
  const results = files.map(sweep)
  results.forEach((result) => console.log(describe(result)))

  const failed = results.filter((r) => r.verdict !== 'PASS')
  if (params.out) {
    fs.writeFileSync(params.out, evidenceText(results))
    console.log('  evidence: ' + path.relative(REPO_ROOT, params.out).split(path.sep).join('/'))
  } else {
    console.log('  evidence: not written (pass --out <file> to record it)')
  }
  if (failed.length > 0) fail('FLAKY', failed.length + ' contract(s) did not agree across ' + RUNS + ' runs')
  console.log('  all ' + files.length + ' contracts agreed and passed ' + RUNS + '/' + RUNS + ' runs.')
}

main()
