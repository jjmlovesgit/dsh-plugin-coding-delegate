#!/usr/bin/env node
/**
 * Guard for a contract that was transcribed from a specification: prove the contract can actually judge.
 *
 * A contract is the linchpin of contract-first delegation, and under this plugin's rules the architect can
 * neither write it nor read it back -- reading it would put implementation-shaped code into the metered
 * context. So the architect specifies behaviour, a worker transcribes the tests, and the architect is left
 * unable to tell a working contract from a broken one. This guard answers that without reading a line of it.
 *
 * The judgement is made against a NULL IMPLEMENTATION, not against the real module, and that choice is the
 * whole design. A test that fails by malfunctioning -- a broken harness, an unloadable module, a rejected
 * fixture -- looks exactly like a test that caught a bug, and the architect cannot tell them apart. Against
 * a real module the ambiguity is unresolvable: the module may simply be throwing. Against a null
 * implementation that never throws, the module cannot be blamed, so a malfunction is unambiguously the
 * contract's own fault. The run against the real module is reported and not judged, for the same reason.
 *
 * The contract is never modified and the real tree is never touched: it is mirrored into a temp directory
 * with the stub placed at the same relative position, which works because a contract reaches its module by
 * a path relative to its own directory.
 *
 * A second optional check closes the one gap the null run cannot see: a contract can be well-formed and
 * discriminating and still test the wrong thing. The contract-first experiment in docs/experiment.md spent
 * three rounds failing to satisfy a contract that asserted a predicate and its own negation while the null
 * run called it sound every time. The `--spec` flag takes a specification conformance suite owned by the
 * architect, which is the null trick run backwards: null proves the module cannot be blamed, and the suite
 * proves the module CAN be trusted, after which a contract that still rejects a conforming module is the
 * artifact at fault. The verdict names the failing contract tests and leaves the resolution open, because it
 * is only as strong as the suite — the contract may demand more than the specification states, or the suite
 * may not cover what the contract tests.
 *
 * Usage: node scripts/check-contract.cjs --contract <file> --module <file> [--spec <file>]
 * Exit 0 when the contract is fit to judge, 1 when it is not, 2 on bad usage.
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * A module that answers every property with itself and every call with itself, and never throws.
 *
 * Not throwing is the point: it is what makes the module blameless. Iteration and await are handled
 * explicitly so that a contract exercising them still reaches its own assertions rather than dying in the
 * stub, which would be a malfunction the contract did not cause and must not be charged for.
 */
const NULL_IMPLEMENTATION = [
  "'use strict'",
  'const NULL = new Proxy(function () {}, {',
  '  get: (target, prop) => {',
  '    if (prop === Symbol.iterator) return function* () {}',
  '    if (prop === Symbol.asyncIterator) return async function* () {}',
  '    if (prop === Symbol.toPrimitive) return () => 0',
  '    if (prop === Symbol.toStringTag) return "NullImplementation"',
  '    if (prop === "then") return undefined',
  '    return NULL',
  '  },',
  '  apply: () => NULL,',
  '})',
  'module.exports = NULL',
  '',
].join('\n')

function argValue(name) {
  const at = process.argv.indexOf('--' + name)
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : null
}

const contractArg = argValue('contract')
const moduleArg = argValue('module')
const specArg = argValue('spec')
if (!contractArg || !moduleArg) {
  console.log('usage: node scripts/check-contract.cjs --contract <file> --module <file> [--spec <file>]')
  process.exit(2)
}

const contract = path.resolve(contractArg)
const modulePath = path.resolve(moduleArg)
const specPath = specArg ? path.resolve(specArg) : null
const pairs = [['contract', contract], ['module', modulePath]]
if (specPath) pairs.push(['specification suite', specPath])
for (const pair of pairs) {
  if (!fs.existsSync(pair[1])) {
    console.log('FAIL: the ' + pair[0] + ' does not exist: ' + pair[1])
    process.exit(1)
  }
}

/**
 * Run one test file and classify its failures.
 *
 * Output is captured through a FILE DESCRIPTOR rather than a pipe, deliberately: DSH's confined sandbox
 * modes refuse a piped spawn outright (spawn EPERM), which would make this guard unusable in exactly the
 * environment it is meant to run in. `verification.ts` captures the same way for the same reason.
 */
function runTests(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-run-'))
  const outFile = path.join(dir, 'out.txt')
  const fd = fs.openSync(outFile, 'w')
  // The test runner passes NODE_TEST_CONTEXT to its own children; handing it to a grandchild silently redirects the report away from stdout.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--test', file], { stdio: ['ignore', fd, fd], env })
  fs.closeSync(fd)
  const output = fs.readFileSync(outFile, 'utf8')
  const number = (re) => {
    const m = output.match(re)
    return m ? Number(m[1]) : 0
  }
  const notOk = (output.match(/^not ok /gm) || []).length
  const assertion = (output.match(/code: 'ERR_ASSERTION'/g) || []).length
  return {
    status: run.status,
    output,
    total: number(/^# tests (\d+)/m),
    passed: number(/^# pass (\d+)/m),
    notOk,
    assertion,
    nonAssertion: notOk - assertion,
  }
}

function failingNames(output) {
  const names = []
  for (const line of output.split('\n')) {
    if (/^not ok /.test(line)) names.push(line.trim())
  }
  return names
}

console.log('contract : ' + contract)
console.log('module   : ' + modulePath)
console.log('')

let failed = 0

// ---- A. the controlled condition, and the only thing judged -----------------------------------------
const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-null-'))
// A test reaches its module by a path relative to its own directory, so the stub is placed at the same relative position.
const mirrorTestFile = (testFile) => {
  const mirrorPath = path.join(
    mirrorRoot,
    path.basename(path.dirname(testFile)),
    path.basename(testFile)
  )
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })
  fs.copyFileSync(testFile, mirrorPath)

  const relative = path.relative(path.dirname(testFile), modulePath)
  const mirrorModule = path.resolve(path.dirname(mirrorPath), relative)
  fs.mkdirSync(path.dirname(mirrorModule), { recursive: true })
  fs.writeFileSync(mirrorModule, NULL_IMPLEMENTATION, 'utf8')

  return mirrorPath
}
const mirrorContract = mirrorTestFile(contract)
const mirrorSpec = specPath ? mirrorTestFile(specPath) : null

const nullRun = runTests(mirrorContract)
console.log(
  'A. against a null implementation: ' +
    nullRun.total +
    ' tests, ' +
    nullRun.passed +
    ' passed, ' +
    nullRun.assertion +
    ' failed by assertion, ' +
    nullRun.nonAssertion +
    ' by malfunction'
)

if (nullRun.total === 0) {
  failed++
  console.log('   FAIL: the contract did not run -- no test count was reported.')
} else if (nullRun.nonAssertion > 0) {
  failed++
  console.log('   FAIL: ' + nullRun.nonAssertion + ' test(s) never reached an assertion. The module here')
  console.log('         cannot be blamed, because it never throws, so the contract is malfunctioning on its')
  console.log('         own account. This is the defect the architect cannot see by reading it:')
  for (const name of failingNames(nullRun.output)) console.log('           ' + name)
} else if (nullRun.assertion > 0) {
  console.log('   ok: it asserts, and every failure is a behavioural disagreement')
} else {
  failed++
  console.log('   FAIL: it passed a module whose every call returns itself, so it constrains nothing')
}

// ---- B. reported, deliberately not judged ------------------------------------------------------------
const real = runTests(contract)
console.log(
  'B. against the real module: ' +
    real.total +
    ' tests, ' +
    real.passed +
    ' passed, ' +
    real.assertion +
    ' failed by assertion, ' +
    real.nonAssertion +
    ' by malfunction'
)
console.log('   reported only. A malfunction here may be the module throwing rather than the contract')
console.log('   failing, and nothing in the output distinguishes the two -- which is why A decides.')

if (nullRun.passed > 0) {
  console.log('')
  console.log(
    'note: ' +
      nullRun.passed +
      ' test(s) pass a module that returns itself for everything. They assert nothing about the module'
  )
  console.log('      and are worth a second look from whoever can read the file.')
}

if (specPath) {
  const realSpec = runTests(specPath)
  const nullSpec = runTests(mirrorSpec)

  console.log('')
  console.log(
    'C. the specification suite against the real module: ' +
      realSpec.total +
      ' test(s), ' +
      realSpec.passed +
      ' passed, ' +
      realSpec.assertion +
      ' failed by assertion, ' +
      realSpec.nonAssertion +
      ' failed by malfunction'
  )

  console.log('')
  console.log(
    'D. the specification suite against a null implementation: ' +
      nullSpec.total +
      ' test(s), ' +
      nullSpec.passed +
      ' passed, ' +
      nullSpec.assertion +
      ' failed by assertion, ' +
      nullSpec.nonAssertion +
      ' failed by malfunction'
  )

  let specRuleSatisfied = false
  if (nullSpec.total === 0) {
    failed++
    console.log('   FAIL: the specification suite did not run -- no test count was reported.')
  } else if (nullSpec.nonAssertion > 0) {
    failed++
    console.log(
      '   FAIL: the module here cannot be blamed, so the suite is malfunctioning on its own account.'
    )
    for (const name of failingNames(nullSpec.output)) {
      console.log('     ' + name)
    }
  } else if (nullSpec.assertion > 0) {
    specRuleSatisfied = true
    console.log('   ok: it asserts, and every failure is a behavioural disagreement')
  } else {
    failed++
    console.log(
      '   FAIL: it passed a module whose every call returns itself, so the specification suite constrains nothing'
    )
  }

  if (
    realSpec.total > 0 &&
    realSpec.passed === realSpec.total &&
    specRuleSatisfied &&
    real.assertion > 0
  ) {
    failed++
    console.log('')
    console.log('DISAGREEMENT: the module satisfies the specification suite, and the contract still rejects it.')
    console.log('Either the contract demands more than the specification states, or the specification suite is incomplete.')
    console.log('Resolve which before delegating another fix. Contract tests that failed against a conforming module:')
    for (const name of failingNames(real.output)) {
      console.log('     ' + name)
    }
  }
}

try {
  fs.rmSync(mirrorRoot, { recursive: true, force: true })
} catch (err) {}

console.log('')
if (failed === 0) {
  console.log('OK: the contract is well-formed and discriminating.')
  process.exit(0)
}
console.log('The contract is not fit to judge a unit. It was transcribed from a specification, so the')
console.log('specification or the transcription is at fault; the architect cannot tell which by reading it.')
process.exit(1)
