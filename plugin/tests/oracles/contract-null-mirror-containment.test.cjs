// Oracle: the contract null run must judge a file INSIDE its own temporary mirror.
//
// WHAT WENT WRONG, and why this file exists. `scripts/check-contract.cjs` proves a contract is
// discriminating by copying it into a temporary mirror, replacing the module it requires with a null
// implementation, and requiring the contract to FAIL. The stub is placed at the module's position RELATIVE
// to the contract, so the mirror has to be deep enough to absorb the `..` ascents in that path.
//
// It was one level deep. A contract in `tests/contracts` reaches its module by `../../tools/x.ts`, so two
// ascents from a one-level mirror landed at `%TEMP%\tools\x.ts` -- outside the mirror, in a directory every
// process on the machine shares, never cleaned up because the `rmSync(mirrorRoot)` cannot reach outside its
// own root. Measured on this machine before the fix: seven 432-byte null stubs in `%TEMP%\tools\`, one per
// contract, plus six abandoned `dsh-contract-null-*` roots.
//
// That is worse than a leak of scratch files. The guard's entire claim is that the module it judges is a
// CONTROLLED condition; the module it actually judged was a file outside its control that outlived the run.
// A later process could have created that path first, and the null run would have judged ITS stub while
// reporting that the contract under test was discriminating.
//
// The fix allocates the mirror's DEPTH from the number of ascents in the contract's own module path, so the
// ascents always arrive back inside the mirror root -- for a contract in the repository and for one in a temp
// workspace alike, which `contract-spec-conformance.test.cjs` depends on (the first version of this fix
// mirrored at the repository-relative depth and refused those contracts; five of its cases failed to say so).
// A pair spanning two drives has no relative path at all, and is refused by name. Case 1 is written so that
// it FAILS against the one-level mirror -- the leaked `tools` directory is exactly what it looks for --
// because a guard against a fixed bug that cannot see the bug is not a guard.
//
// (`spawnSync` with piped stdio is the only way to observe this: the writing happens in a child process.)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-contract.cjs')
const CONTRACT = path.join(REPO_ROOT, 'tests', 'contracts', 'async-mutex.contract.cjs')
const MODULE = path.join(REPO_ROOT, 'tools', 'async-mutex.ts')

/**
 * Run the checker with `TEMP`/`TMP` pointed at a directory the caller owns.
 *
 * Pointing the child's temp directory matters for two reasons: it makes the assertion ("nothing landed
 * outside the mirror") LOCAL, so it cannot be confused by another process using the real `%TEMP%`, and it
 * is the only way to observe where the child wrote. `os.tmpdir()` is read by the child, so the environment
 * is the input that controls it -- and `precondition` below proves that, rather than assuming it.
 */
function runChecker(args, tempDir) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TEMP: tempDir, TMP: tempDir },
  })
}

const withTempDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mirror-oracle-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('precondition: a child process really does read the temp directory this oracle sets', () => {
  // Without this case the whole file could pass by pointing the child nowhere: if `TEMP` were ignored,
  // `fresh/tools` would never exist no matter what the checker wrote, and case 1 would be vacuous.
  withTempDir((dir) => {
    const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(require('os').tmpdir())"], {
      encoding: 'utf8',
      env: { ...process.env, TEMP: dir, TMP: dir },
    })
    assert.strictEqual(probe.status, 0, 'the temp-directory probe itself failed to run')
    assert.strictEqual(
      path.resolve(probe.stdout),
      path.resolve(dir),
      'the child ignored TEMP/TMP, so every containment assertion below would be vacuous'
    )
  })
})

test('the null stub lands inside the mirror, and nothing is written to the shared tools/ path', () => {
  withTempDir((dir) => {
    const run = runChecker(['--contract', CONTRACT, '--module', MODULE], dir)

    // The positive half: the contract really was judged and really was discriminating. Asserting only the
    // absence below would pass if the checker had refused for an unrelated reason or never run the null
    // battery at all -- the failure mode where a containment check reports success because nothing happened.
    assert.strictEqual(
      run.status,
      0,
      'the checker should accept a real contract against a null implementation; stdout:\n' +
        run.stdout +
        '\nstderr:\n' +
        run.stderr
    )
    assert.match(run.stdout, /OK: the contract is well-formed and discriminating/)

    // The negative half, and the exact signature of the fixed bug: the stub used to be written to
    // `<temp>/tools/<module>.ts`, one directory up and out of the mirror's reach.
    assert.strictEqual(
      fs.existsSync(path.join(dir, 'tools')),
      false,
      'the null stub escaped the mirror: ' +
        path.join(dir, 'tools') +
        ' exists, so the module the guard judged was outside the guard'
    )

    // Stronger, and shape-independent: whatever the mirror depth, no stub may survive anywhere under the
    // temp root, and no mirror directory may outlive the run. The first version of the check looked only for
    // `<temp>/tools`, which is one spelling of the escape; this catches any depth that gets it wrong.
    const leftovers = fs.readdirSync(dir, { recursive: true }).map((entry) => String(entry))
    const survivingStubs = leftovers.filter((entry) => entry.endsWith('.ts'))
    assert.deepStrictEqual(
      survivingStubs,
      [],
      'a null stub survived the run under the temp root: ' + survivingStubs.join(', ')
    )
    const survivingMirrors = leftovers.filter((entry) => entry.startsWith('dsh-contract-null-'))
    assert.deepStrictEqual(
      survivingMirrors,
      [],
      'the checker did not clean up its mirror: ' + survivingMirrors.join(', ')
    )
  })
})

test('a `..`-heavy module path that names a real module is mirrored and judged normally', () => {
  withTempDir((dir) => {
    // The historical bug's own spelling: the module reached by ascents rather than by its plain path. It has
    // to still produce a real verdict. Refusing it would fix the leak by breaking the guard's normal case,
    // which is the mistake the first version of this fix made -- it refused every contract outside the
    // repository, and five cases of `contract-spec-conformance.test.cjs` failed to say so.
    const spelledWithAscents = path.join(
      REPO_ROOT,
      'tests',
      'contracts',
      '..',
      '..',
      'tools',
      'async-mutex.ts'
    )
    const run = runChecker(['--contract', CONTRACT, '--module', spelledWithAscents], dir)
    assert.strictEqual(
      run.status,
      0,
      'a module named by an ascending path must still be judged; stdout:\n' + run.stdout + '\nstderr:\n' + run.stderr
    )
    assert.match(run.stdout, /OK: the contract is well-formed and discriminating/)
  })
})

test('a module path outside the repository cannot aim the stub at that path', () => {
  withTempDir((outside) => {
    // The write primitive, stated as sharply as possible. `--module` is caller-chosen, the stub location was
    // resolved from it with no containment test, and enough `..` segments aimed that write anywhere on the
    // drive. The file the caller named must come out of the run untouched, and no stub may survive outside
    // the mirror.
    const escapeTarget = path.join(outside, 'escaped-target.ts')
    const sentinel = '// sentinel: a caller-named file the guard must never write over\n'
    fs.writeFileSync(escapeTarget, sentinel, 'utf8')

    // The exit code is deliberately NOT asserted. This pair -- the async-mutex contract with a module it does
    // not require -- cannot produce a meaningful verdict from either run, because the contract reaches its
    // module by a path of its own. `check-contract.cjs` trusts that `--module` names the module the contract
    // requires, and a mismatched pair is a separate question; what this case is about is where the bytes went.
    runChecker(['--contract', CONTRACT, '--module', escapeTarget], outside)

    assert.strictEqual(
      fs.readFileSync(escapeTarget, 'utf8'),
      sentinel,
      'the guard wrote its null stub over a file the caller named'
    )
    const survivors = fs
      .readdirSync(outside, { recursive: true })
      .map(String)
      .filter((entry) => entry.endsWith('.ts') && entry !== path.basename(escapeTarget))
    assert.deepStrictEqual(survivors, [], 'a stub survived outside the mirror: ' + survivors.join(', '))
    assert.strictEqual(
      fs.existsSync(path.join(outside, 'tools')),
      false,
      'the stub escaped to the shared tools directory again'
    )
  })
})

test('a contract outside the repository is mirrored and judged, and the module is never modified', () => {
  withTempDir((outside) => {
    // `contract-spec-conformance.test.cjs` lays its workspace out in the temp directory, so a guard that can
    // only mirror contracts found inside the repository breaks a supported use. Containment has to come from
    // the SHAPE of the mirror, not from where the contract happens to live.
    const localModule = path.join(outside, 'module.js')
    const localContract = path.join(outside, 'tests', 'contract.test.js')
    fs.mkdirSync(path.dirname(localContract), { recursive: true })
    const moduleSource = 'exports.add = (a, b) => a + b\n'
    fs.writeFileSync(localModule, moduleSource, 'utf8')
    fs.writeFileSync(
      localContract,
      [
        "'use strict'",
        "const { test } = require('node:test')",
        "const assert = require('node:assert/strict')",
        "const { add } = require('../module.js')",
        "test('adds two numbers', () => { assert.equal(add(2, 3), 5) })",
        '',
      ].join('\n'),
      'utf8'
    )

    const run = runChecker(['--contract', localContract, '--module', localModule], outside)
    assert.strictEqual(
      run.status,
      0,
      'a contract outside the repository must still be judged; stdout:\n' + run.stdout + '\nstderr:\n' + run.stderr
    )
    assert.match(run.stdout, /OK: the contract is well-formed and discriminating/)

    // The null run has to judge a STUB, so the module under test must survive byte-identical. Without this
    // assertion a guard could demonstrate "discriminating" by mutating the artefact it is judging.
    assert.strictEqual(
      fs.readFileSync(localModule, 'utf8'),
      moduleSource,
      'the guard modified the module under test'
    )
  })
})

test('a contract and a module on different drives are refused by name, and the refusal cleans up', (t) => {
  // The last containment hole, and the one no `..` arithmetic can close: `path.relative` between two drives
  // returns an absolute path, so there is no depth that would bring the stub back inside the mirror. The
  // guard has to refuse instead, and it has to say which pair it refused.
  //
  // Windows-only, because drive letters are the only way to produce the case -- and `subst` produces one
  // without a second physical disk. On any other platform the case is skipped by name rather than quietly
  // passing, so a Linux CI run does not report coverage it never had.
  if (process.platform !== 'win32') {
    t.skip('drive letters only exist on Windows, so the cross-drive refusal cannot be constructed here')
    return
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mirror-drive-'))
  let guest = null
  for (const candidate of ['Z:', 'Y:', 'X:', 'W:', 'V:']) {
    const mapped = spawnSync('subst', [candidate, dir], { encoding: 'utf8' })
    if (mapped.status === 0) {
      guest = candidate
      break
    }
  }
  if (guest === null) {
    fs.rmSync(dir, { recursive: true, force: true })
    t.skip('no free drive letter for subst, so the cross-drive pair cannot be constructed on this host')
    return
  }

  try {
    const target = guest + '\\dsh-cross-drive-target.ts'
    const sentinel = '// sentinel: a file on another drive the guard must never write over\n'
    fs.writeFileSync(target, sentinel, 'utf8')

    const run = runChecker(['--contract', CONTRACT, '--module', target], dir)
    assert.strictEqual(
      run.status,
      1,
      'a cross-drive pair must be refused rather than mirrored; stdout:\n' + run.stdout + '\nstderr:\n' + run.stderr
    )
    assert.match(run.stderr, /are on different drives, so no relative mirror can contain the null stub/)
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      sentinel,
      'the guard wrote its null stub across drives, onto the file the caller named'
    )

    // The refusal happens after the temporary root exists, and `process.exit` runs no `finally`, so a refusal
    // that just exits leaves a mirror root behind on every refused run. Measured on this host before the
    // `refuse` helper: hundreds of abandoned `dsh-contract-*` directories in the shared temp directory.
    const abandoned = fs.readdirSync(dir).filter((entry) => entry.startsWith('dsh-contract-'))
    assert.deepStrictEqual(
      abandoned,
      [],
      'the refusal left temporary directories behind: ' + abandoned.join(', ')
    )
  } finally {
    spawnSync('subst', [guest, '/D'], { encoding: 'utf8' })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
