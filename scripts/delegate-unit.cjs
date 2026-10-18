#!/usr/bin/env node
/**
 * Atomic delegation harness for Tier 1 primitives (ADR-SEC-AISDLC-001 §6, plan item 2).
 *
 * ONE COMMAND, AND THE POINT IS THAT NONE OF ITS STEPS IS SKIPPABLE. The lifecycle it automates has
 * seven parts that were previously run by hand in the right order, and every one of them is a place
 * where a human in a hurry can skip the mutant check, run the contract once instead of three times,
 * or commit before the signer has seen the bytes. The harness refuses to reach the seal without them.
 *
 * WHAT IT ADAPTED FROM THE BLUEPRINT, and why each adaptation was forced:
 *
 *   - The blueprint calls `scripts/delegate-note.cjs`. No such file has ever existed here; the signer
 *     is `scripts/attest-unit.cjs` with `--prepare` / `--approve`.
 *   - The blueprint dispatches `scripts/worker-build.mjs --target … --model …`. The dispatcher is
 *     `tools/worker-build.mjs` and takes POSITIONAL arguments (`<target> <contract>`); it has no
 *     model flag, and it refuses a target with no authored `REQUIREMENTS` entry.
 *   - The blueprint validates the mutant with a `TARGET_FILE_OVERRIDE` environment variable. There
 *     is no such hook, and `check-contract-fixtures.cjs` records why it was removed: the contract
 *     needed a test-only branch, which changed the contract's bytes and broke the `contractHash`
 *     parity that the attestation is built on. This harness uses that file's mirror technique
 *     instead -- the contract is copied BYTE-IDENTICAL into a temporary tree with the mutant placed
 *     at `tools/<name>.ts`, so the bytes that judge the real module are the bytes that judged the
 *     mutant.
 *   - `config.tiers.tier1.flakeIterations` does not exist; the count lives in
 *     `config.delegation.flakeIterations` (POL §5.3).
 *
 * THE APPROVAL IS NOT AUTOMATED, DELIBERATELY. `--prepare` stages a draft and attaches nothing; the
 * harness prints the exact `--approve --reviewer-identity` command and stops. A harness that could
 * fill in a reviewer name would be manufacturing the second signature the two-phase design exists to
 * keep separate (attestation-spec-1.2 §11-13), and a record claiming a review nobody performed is
 * worse than a missing record.
 *
 * Usage: node scripts/delegate-unit.cjs --target <path> --contract <path> --mutant <path> [--dry-run]
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadPolicyConfig } = require('./policy-config.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const { config } = loadPolicyConfig(REPO_ROOT)
const USAGE =
  'usage: node scripts/delegate-unit.cjs --target <path> --contract <path> --mutant <path> [--dry-run]'

/** Repository-relative, POSIX-separated: every path this harness prints or passes to git. */
function rel(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
}

function fail(code, message) {
  console.error('FATAL [' + code + ']: ' + message)
  process.exit(1)
}

function ok(message) {
  console.log('  ok    ' + message)
}

function heading(message) {
  console.log('\n[HARNESS] ' + message)
}

function parseArgs(argv) {
  const params = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') {
      params.dryRun = true
    } else if (!token.startsWith('--')) {
      fail('BAD_ARGS', 'unexpected argument "' + token + '"\n' + USAGE)
    } else {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        fail('BAD_ARGS', '--' + token.slice(2) + ' needs a value\n' + USAGE)
      }
      params[token.slice(2)] = value
      i += 1
    }
  }
  return params
}

/** Resolve and validate the three paths, and refuse a target that is not a Tier 1 module. */
function resolveUnit(params) {
  for (const key of ['target', 'contract', 'mutant']) {
    if (!params[key]) fail('BAD_ARGS', 'missing --' + key + '\n' + USAGE)
  }
  const unit = {
    target: path.resolve(REPO_ROOT, params.target),
    contract: path.resolve(REPO_ROOT, params.contract),
    mutant: path.resolve(REPO_ROOT, params.mutant),
  }
  for (const key of ['contract', 'mutant']) {
    if (!fs.existsSync(unit[key])) fail('MISSING_INPUT', rel(unit[key]) + ' does not exist')
  }
  if (!new RegExp(config.tiers.corePrimitives.contractGoverned).test(rel(unit.target))) {
    fail(
      'NOT_TIER1',
      rel(unit.target) + ' is not a contract-governed Tier 1 module (' +
        config.tiers.corePrimitives.contractGoverned + ')'
    )
  }
  unit.targetRel = rel(unit.target)
  unit.contractRel = rel(unit.contract)
  unit.mutantRel = rel(unit.mutant)
  return unit
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', ...options })
  if (result.error) fail('SPAWN_FAILED', command + ' could not run: ' + result.error.message)
  return { status: result.status, output: String(result.stdout || '') + String(result.stderr || '') }
}

/** Place the contract and the mutant in the relative positions the contract expects. */
function mirror(unit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delegate-unit-'))
  const base = path.basename(unit.contract).replace(/\.contract\.cjs$/, '')
  const contractDir = path.join(root, 'tests', 'contracts')
  const toolsDir = path.join(root, 'tools')
  fs.mkdirSync(contractDir, { recursive: true })
  fs.mkdirSync(toolsDir, { recursive: true })
  const contractCopy = path.join(contractDir, path.basename(unit.contract))
  fs.copyFileSync(unit.contract, contractCopy)
  fs.copyFileSync(unit.mutant, path.join(toolsDir, base + path.extname(unit.mutant)))
  return { root, contractCopy }
}

/** The contract must REJECT the mutant, and must not reject it by failing everything. */
function assertMutantDiscriminates(unit) {
  const source = fs.readFileSync(unit.contract, 'utf8')
  if (!source.includes('../../tools/')) {
    fail(
      'CONTRACT_LAYOUT',
      unit.contractRel + ' does not reach its module through ../../tools/, so the mutant cannot be ' +
        'mirrored into its place and this check would prove nothing'
    )
  }
  const mirrored = mirror(unit)
  try {
    const observed = run(process.execPath, ['--test', mirrored.contractCopy], { cwd: mirrored.root })
    if (observed.status === 0) {
      fail('TAUTOLOGY_DETECTED', 'the contract PASSES the negative mutant, so it cannot judge this unit')
    }
    const survivors = (observed.output.match(/^\s*ok \d+ - /gm) || []).length
    if (survivors === 0) {
      fail(
        'MUTANT_NOT_TARGETED',
        'the mutant fails every case, so its rejection is not evidence about the property under test'
      )
    }
    ok('mutant rejected, and ' + survivors + ' case(s) still pass, so the fixture is targeted')
  } finally {
    fs.rmSync(mirrored.root, { recursive: true, force: true })
  }
}

/** N consecutive deterministic passes, or no settlement. */
function runContract(unit, times) {
  for (let pass = 1; pass <= times; pass += 1) {
    const observed = run(process.execPath, ['--test', unit.contract], { cwd: REPO_ROOT })
    if (observed.status !== 0) {
      console.error(observed.output.slice(-2000))
      fail('VERIFICATION_FAILED', 'contract pass ' + pass + '/' + times + ' failed')
    }
    ok('contract pass ' + pass + '/' + times)
  }
}

function assertCleanTree() {
  const status = run('git', ['status', '--porcelain'])
  if (status.status !== 0) fail('GIT_STATUS', status.output)
  if (status.output.trim() !== '') {
    fail('DIRTY_TREE', 'refusing to commit a unit into a dirty tree:\n' + status.output)
  }
}

function dispatch(unit) {
  heading('dispatching to ' + config.workerModel + ' via tools/worker-build.mjs')
  if (fs.existsSync(unit.target)) {
    fs.rmSync(unit.target)
    ok('unlinked the stale target: ' + unit.targetRel)
  }
  const result = spawnSync(
    process.execPath,
    [path.join('tools', 'worker-build.mjs'), unit.targetRel, unit.contractRel],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )
  if (result.status !== 0) {
    fail(
      'WORKER_FAILED',
      'tools/worker-build.mjs exited ' + result.status + '. A target with no authored REQUIREMENTS ' +
        'entry cannot be dispatched; add one there rather than skipping the worker.'
    )
  }
  if (!fs.existsSync(unit.target)) {
    fail('EMISSION_FAILED', 'the worker exited 0 but ' + unit.targetRel + ' was not emitted')
  }
  ok('emitted ' + unit.targetRel)
}

function commitUnit(unit) {
  heading('committing the unit')
  assertCleanTree()
  const added = run('git', ['add', '--', unit.targetRel, unit.contractRel, unit.mutantRel])
  if (added.status !== 0) fail('GIT_ADD', added.output)
  const name = path.basename(unit.target, path.extname(unit.target))
  const committed = run('git', ['commit', '-m', 'feat(tools): delegate ' + name], {
    env: { ...process.env, AI_SDLC_ATOMIC_RUN: '1' },
  })
  if (committed.status !== 0) fail('GIT_COMMIT', committed.output)
  ok('committed as "feat(tools): delegate ' + name + '"')
}

function prepareAttestation(unit) {
  heading('staging the Schema 1.2 attestation')
  const result = run(process.execPath, [
    'scripts/attest-unit.cjs',
    '--prepare',
    unit.targetRel,
    unit.contractRel,
    '--model',
    config.workerModel,
  ])
  process.stdout.write(result.output)
  if (result.status !== 0) fail('ATTEST_PREPARE_FAILED', 'the signer refused to stage a draft')
}

function audit() {
  heading('verifying the ledger')
  const result = run(process.execPath, ['scripts/verify-delegation-ledger.cjs'])
  if (result.status !== 0) {
    console.error(result.output.slice(-1500))
    fail('AUDIT_FAILED', 'the ledger audit did not pass')
  }
  ok('ledger audit passed')
}

function printPlan(unit) {
  heading('dry run: nothing is unlinked, committed, or signed')
  const present = fs.existsSync(unit.target) ? ' (present)' : ' (absent)'
  console.log('  would unlink   : ' + unit.targetRel + present)
  console.log('  would dispatch : tools/worker-build.mjs ' + unit.targetRel + ' ' + unit.contractRel)
  console.log('  would verify   : ' + config.delegation.flakeIterations + ' x node --test ' + unit.contractRel)
  console.log('  would commit   : ' + unit.targetRel + ', ' + unit.contractRel + ', ' + unit.mutantRel)
  console.log('  would prepare  : scripts/attest-unit.cjs --prepare ' + unit.targetRel + ' ' + unit.contractRel)
  console.log('  would await    : a human `--approve --reviewer-identity` signature')
}

function execute(unit) {
  dispatch(unit)
  heading('flake gate: ' + config.delegation.flakeIterations + ' consecutive passes')
  runContract(unit, config.delegation.flakeIterations)
  commitUnit(unit)
  prepareAttestation(unit)
  console.log('\n  the draft is staged and NOTHING is attached. A human must approve it:')
  console.log('    node scripts/attest-unit.cjs --approve ' + unit.targetRel + ' --reviewer-identity "<name>"')
  audit()
  console.log('\n=== DELEGATION COMPLETE: unit committed, draft staged, ledger verified ===')
}

function main() {
  const params = parseArgs(process.argv.slice(2))
  const unit = resolveUnit(params)
  console.log('=== AI-SDLC ATOMIC DELEGATION HARNESS ===')
  console.log('  target   : ' + unit.targetRel)
  console.log('  contract : ' + unit.contractRel)
  console.log('  mutant   : ' + unit.mutantRel)
  console.log('  model    : ' + config.workerModel)
  console.log('  ledger   : ' + config.ledgerRef)

  heading('step 1: mutant discrimination')
  assertMutantDiscriminates(unit)

  heading('contract against the current target')
  if (fs.existsSync(unit.target)) runContract(unit, config.delegation.flakeIterations)
  else console.log('  skip  no target on disk yet, so there is nothing to verify')

  if (params.dryRun) printPlan(unit)
  else execute(unit)
}

main()
