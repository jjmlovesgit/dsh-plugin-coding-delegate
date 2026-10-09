// Oracle for the promotion socket: every verdict, both hash states, and the unanswerable case.
//
// WHY THIS FILE IS `.mjs`. It tests `scripts/check-promotion.cjs`. An earlier version of this header claimed
// the write guard refuses a `.cjs` oracle to a cloud context because `.cjs` appears in `CODE_EXTENSIONS`, and
// that `.mjs` was therefore the only way the oracle could exist. That claim was wrong, and it is left here
// corrected rather than deleted because of what it cost: it was repeated in `docs/control-effectiveness.md`
// as the reason this test did not exist, and it read as a precise mechanical explanation.
//
// What actually governs a test file here is the contract carve-out, not the extension: the write guard
// short-circuits on `contractPaths` (default `['tests/']`) BEFORE the extension gate is reached, so
// `tests/thing.test.cjs` with `contractWriteMode: 'allow'` is PERMITTED -- `contract-write.test.cjs` asserts
// exactly that, and a `.cjs` oracle would have been permitted too. `.mjs` is a fine choice and it is what
// shipped, but it is a choice rather than a requirement, and it is not why this file is allowed to exist.
//
// What the extension rule really refuses is `scripts/check-promotion.cjs` itself, which sits outside every
// contract path. That is the rule working: the socket is source, and source is the local worker's to write.
//
// WHY IT MATTERS MORE THAN A NORMAL TEST. This socket is the enforcement point for every promotion, and it
// is the one component whose bugs are SILENT: a missing verdict branch falls through to "the registry holds
// no verdict for it" and exits 1, which is indistinguishable from correct strictness. The
// `OPERATOR_ATTESTED` gap was exactly that shape -- three files correctly attested, the socket refusing
// them, and the refusal reading like caution rather than like a missing case. An oracle is the only way to
// tell those apart, because the observable behaviour of "correctly strict" and "branch not implemented" is
// identical from outside.
//
// THE REGISTRY IS A FIXTURE, and it has to be: the real registry lives outside the repository, is per
// machine, and describes what one machine's worker did. Each case below writes its own registry file and
// passes `--registry`, so the oracle tests the JUDGEMENT rather than the environment. It never reads or
// writes the operator's real registry.
//
// Run directly:  node --test plugin/tests/oracles/promotion-socket.oracle.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', '..', '..', 'scripts', 'check-promotion.cjs')

/** A scratch workspace with one source file, so hashes and paths are under the test's control. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-promotion-'))
  const target = path.join(dir, 'thing.ts')
  fs.writeFileSync(target, 'export const x = 1\n')
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  return {
    dir,
    target,
    hash,
    registryFor(records) {
      const registry = path.join(dir, 'delegated-registry.json')
      fs.writeFileSync(registry, JSON.stringify({ version: 1, records }, null, 2))
      return registry
    },
  }
}

function run(registryPath, target) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--registry', registryPath, '--path', target, '--json'],
    { encoding: 'utf8' }
  )
  let parsed = null
  try {
    parsed = JSON.parse(String(result.stdout || ''))
  } catch {
    parsed = null
  }
  return {
    exit: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    result: parsed && parsed.results ? parsed.results[0] : null,
  }
}

/**
 * The matrix. `exit` and `reason` are the whole observable contract of the socket, and both are asserted
 * because an exit code alone cannot distinguish "correctly refused" from "refused for a reason I did not
 * implement" -- which is the defect this file exists to catch.
 */
const CASES = [
  {
    name: 'UNIT_PASSED with a matching hash is promotable',
    record: (f) => ({ outcome: 'UNIT_PASSED', succeeded: true, sha256: f.hash, at: 1 }),
    exit: 0,
    reason: 'a unit passed it and its content is unchanged',
  },
  {
    name: 'OPERATOR_ATTESTED with a matching hash is promotable',
    record: (f) => ({
      outcome: 'OPERATOR_ATTESTED',
      succeeded: false,
      sha256: f.hash,
      at: 1,
      attestation: { operator: 'jim', evidence: 'reviewed', at: 1 },
    }),
    exit: 0,
    reason: 'attested by jim and unchanged since',
  },
  {
    name: 'OPERATOR_ATTESTED whose content changed after the attestation is refused',
    record: (f) => ({
      outcome: 'OPERATOR_ATTESTED',
      succeeded: false,
      sha256: 'deadbeef' + f.hash.slice(8),
      at: 1,
      attestation: { operator: 'jim', evidence: 'reviewed', at: 1 },
    }),
    exit: 1,
    reason: 'its content changed after the operator attested it',
  },
  {
    name: 'UNIT_PASSED whose content changed after the verdict is refused',
    record: (f) => ({ outcome: 'UNIT_PASSED', succeeded: true, sha256: 'deadbeef' + f.hash.slice(8), at: 1 }),
    exit: 1,
    reason: 'its content changed after the verdict, so it is not the version anything verified',
  },
  {
    name: 'UNIT_UNVERIFIED is refused and is not reported as a failure',
    record: () => ({ outcome: 'UNIT_UNVERIFIED', succeeded: false, sha256: null, at: 1 }),
    exit: 1,
    reason: 'the unit that wrote it was never verified',
  },
  {
    name: 'UNIT_FAILED is refused',
    record: () => ({ outcome: 'UNIT_FAILED', succeeded: false, sha256: null, at: 1 }),
    exit: 1,
    reason: 'the unit that wrote it failed verification',
  },
  {
    name: 'UNIT_FLAKY is refused, and named as the oracle rather than the code',
    record: () => ({ outcome: 'UNIT_FLAKY', succeeded: false, sha256: null, at: 1 }),
    exit: 1,
    reason: 'the contract disagreed with itself across repeated runs',
  },
  {
    name: 'a file with no record at all is refused',
    record: () => null,
    exit: 1,
    reason: 'no verdict: no delegated unit is recorded as writing it',
  },
  {
    name: 'a record with no verdict field is refused rather than trusted',
    record: (f) => ({ sha256: f.hash, at: 1, mode: 'created' }),
    exit: 1,
    reason: 'the registry holds no verdict for it',
  },
]

for (const testCase of CASES) {
  test('promotion socket: ' + testCase.name, () => {
    const f = fixture()
    const record = testCase.record(f)
    const registry = f.registryFor(
      record === null ? [] : [{ path: f.target, mode: 'created', ...record }]
    )
    const outcome = run(registry, f.target)

    assert.equal(
      outcome.result && outcome.result.ok,
      testCase.exit === 0,
      'ok flag disagrees with the expected exit code. socket said: ' + JSON.stringify(outcome.result)
    )
    assert.equal(outcome.exit, testCase.exit, 'exit code. socket output: ' + outcome.stdout)
    assert.match(
      String(outcome.result && outcome.result.reason),
      new RegExp(testCase.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the reason must say WHY, not merely that it refused -- a fall-through to a generic refusal is the ' +
        'silent bug this oracle exists to catch'
    )
  })
}

test('promotion socket: an absent registry is UNANSWERABLE (exit 2), never a pass', () => {
  // The distinction the tri-state exists for: "I could not check" and "it is fine" must not share an exit
  // code, because a pipeline that treats both as success promotes unverified work.
  const f = fixture()
  const missing = path.join(f.dir, 'not-a-registry.json')
  const outcome = run(missing, f.target)
  assert.equal(outcome.exit, 2, 'a missing registry is unanswerable, not a refusal and not a pass')
  assert.match(outcome.stderr, /cannot answer/, 'and it says so on stderr')
})

test('promotion socket: an unreadable registry is UNANSWERABLE, not a silent pass', () => {
  const f = fixture()
  const corrupt = path.join(f.dir, 'corrupt.json')
  fs.writeFileSync(corrupt, '{ this is not json')
  const outcome = run(corrupt, f.target)
  assert.equal(outcome.exit, 2, 'a registry that cannot be parsed is unanswerable')
})

test('promotion socket: the newest record for a path wins', () => {
  // A file that failed and was then re-delegated and passed must not be judged by the older record, and
  // vice versa. `recordFor` takes the greatest `at`, so the ordering is asserted rather than assumed.
  const f = fixture()
  const stale = { path: f.target, mode: 'created', outcome: 'UNIT_FAILED', succeeded: false, sha256: null, at: 1 }
  const current = { path: f.target, mode: 'created', outcome: 'UNIT_PASSED', succeeded: true, sha256: f.hash, at: 2 }
  assert.equal(run(f.registryFor([stale, current]), f.target).exit, 0, 'newest passing record wins')
  assert.equal(run(f.registryFor([current, stale]), f.target).exit, 0, 'order in the file must not matter')

  const passing = { path: f.target, mode: 'created', outcome: 'UNIT_PASSED', succeeded: true, sha256: f.hash, at: 1 }
  const failed = { path: f.target, mode: 'created', outcome: 'UNIT_FAILED', succeeded: false, sha256: null, at: 2 }
  assert.equal(
    run(f.registryFor([passing, failed]), f.target).exit,
    1,
    'a newer failure supersedes an older pass'
  )
})
