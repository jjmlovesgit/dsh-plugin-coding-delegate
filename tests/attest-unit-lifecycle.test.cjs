'use strict';

/**
 * tests/attest-unit-lifecycle.test.cjs
 *
 * The 1.2 signer's end-to-end lifecycle, in a throwaway clone, exercised against BOTH reviewer trust
 * roots and against a wrong pin. This is the automated form of a protocol that was previously manual,
 * and it exists because the signer had no coverage at all: nothing in `tests/` or `plugin/tests/`
 * referenced `scripts/attest-unit.cjs`, so its correctness rested on someone remembering to run the
 * clone steps by hand. A manual protocol that is not automated is one that gets skipped.
 *
 * WHAT IT PROVES, IN ORDER
 *   1. `--prepare` stages a draft, attaches nothing, and does not move `refs/notes/delegations`.
 *   2. `--approve` attaches exactly one note and unlinks the draft.
 *   3. Run A: the default in-repo fallback passes AND announces itself, and the 1.2 reviewer checks
 *      genuinely ran over the new note.
 *   4. Run B: the out-of-band pin passes and SILENTLY replaces the fallback -- the notice is gone.
 *   5. Run C: a wrong out-of-band pin fails the audit closed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never touches the real ledger. Every git operation happens inside a `mkdtemp` clone, which is
 * removed in `finally`. The published `refs/notes/delegations` is read once, to be copied, and never
 * written.
 *
 * SKIPPING, NOT FAILING, WHEN THE KEYS ARE MISSING
 * Signing requires the operator and reviewer PRIVATE keys in `~/.dsh/keys/`. Those exist on a signing
 * machine and must never exist in CI, so this test skips with a named reason rather than failing: a
 * red gate in CI for a key that CI is forbidden to hold would train people to ignore the gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const NOTES_REF = 'refs/notes/delegations';
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
const OPERATOR_KEY = path.join(HOME_DIR, '.dsh', 'keys', 'delegation_ed25519.pem');
const REVIEWER_KEY = path.join(HOME_DIR, '.dsh', 'keys', 'delegation-reviewer.pem');
const REVIEWER_FINGERPRINT = '92e726e01a961c602d04d5fd26a64dde819ffe7953fb0b189bdb77d51ddb3d8d';
const TARGET = 'tools/async-mutex.ts';
const CONTRACT = 'tests/contracts/async-mutex.contract.cjs';

/**
 * `spawnSync` has no `check` option -- that is `execSync`'s, and passing it is silently ignored, which
 * turns a failed clone into a confusing assertion failure several steps later. Every call here goes
 * through `mustRun`, which reports the command, its exit status, and both streams.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(command + ' could not be spawned: ' + result.error.message);
  }
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(
    result.status,
    0,
    command + ' ' + args.join(' ') + ' exited ' + result.status + '\n--- stdout ---\n' + result.stdout + '\n--- stderr ---\n' + result.stderr
  );
  return result;
}

function ledgerTip(cwd) {
  const result = run('git', ['rev-parse', '--verify', NOTES_REF], { cwd });
  return result.status === 0 ? result.stdout.trim() : null;
}

function noteCount(cwd) {
  const result = run('git', ['notes', '--ref=' + NOTES_REF, 'list'], { cwd });
  if (result.status !== 0) return -1;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

test('Schema 1.2 two-phase lifecycle across both reviewer trust roots', { timeout: 300000 }, async (t) => {
  const missingKeys = [OPERATOR_KEY, REVIEWER_KEY].filter((keyPath) => !fs.existsSync(keyPath));
  if (missingKeys.length > 0) {
    t.skip('signing keys absent, so the lifecycle cannot run here: ' + missingKeys.join(', '));
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attest-lifecycle-'));
  const clone = path.join(scratch, 'repo');
  const pendingPath = path.join(clone, '.git', 'dsh-attestation-pending.json');

  try {
    // A clone of the LOCAL path, not of a remote: a local clone needs no credentials and no TLS
    // backend, and this repository cannot reach github over its default `schannel` backend at all.
    mustRun('git', ['clone', '--quiet', REPO_ROOT, clone]);
    mustRun('git', ['fetch', '--quiet', 'origin', NOTES_REF + ':' + NOTES_REF], { cwd: clone });

    // THE WORKING TREE IS COPIED OVER THE CLONE, and this is load-bearing rather than tidiness: a clone
    // contains committed content only, so without this the test would exercise the last commit instead
    // of the signer being edited -- and would keep passing after a local change broke it.
    for (const name of ['attest-unit.cjs', 'verify-delegation-ledger.cjs']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', name), path.join(clone, 'scripts', name));
    }

    const tipBefore = ledgerTip(clone);
    const countBefore = noteCount(clone);
    assert.ok(tipBefore, 'the clone has no ledger ref, so the fetch above did not copy one');
    assert.ok(countBefore > 0, 'the clone ledger is empty, so the audit would fail for the wrong reason');

    // ---- Phase 1: --prepare ----------------------------------------------------------------
    const prepare = mustRun('node', ['scripts/attest-unit.cjs', '--prepare', TARGET, CONTRACT], { cwd: clone });
    assert.match(prepare.stdout, /PREPARE PASS/, '--prepare did not report success');
    assert.ok(fs.existsSync(pendingPath), '--prepare did not stage a draft');
    assert.equal(ledgerTip(clone), tipBefore, '--prepare moved the ledger, which invariant 12 forbids');
    assert.equal(noteCount(clone), countBefore, '--prepare attached a note, which it must never do');

    // ---- Phase 2: --approve ----------------------------------------------------------------
    const approve = mustRun(
      'node',
      ['scripts/attest-unit.cjs', '--approve', TARGET, '--reviewer-identity', 'Automated Test Reviewer <test@local>'],
      { cwd: clone }
    );
    assert.match(approve.stdout, /APPROVE PASS/, '--approve did not report success');
    assert.ok(!fs.existsSync(pendingPath), '--approve left the draft staged, so invariant 13 did not complete');
    assert.equal(noteCount(clone), countBefore + 1, '--approve did not attach exactly one new note');
    assert.notEqual(ledgerTip(clone), tipBefore, '--approve reported success but attached nothing');

    // ---- Run A: the in-repo fallback, which must pass AND announce itself -------------------
    const fallback = run('node', ['scripts/verify-delegation-ledger.cjs'], { cwd: clone });
    assert.equal(fallback.status, 0, 'the audit failed under the in-repo fallback:\n' + fallback.stdout + fallback.stderr);
    assert.match(fallback.stdout + fallback.stderr, /AUDIT_NOTICE: in-repo reviewer key used/);
    // The audit writes its SUCCESS to stdout and its REFUSAL to stderr (`console.error`), so the two
    // streams must be checked together: a caller reading only stdout cannot tell a pass from a fail by
    // the message alone, and the exit code is the only part of the contract that is stream-independent.
    assert.doesNotMatch(fallback.stdout + fallback.stderr, /AUDIT FAILED/);
    // The new note must be inside the audited set and its 1.2 checks must actually have run, so a pass
    // over the legacy notes alone cannot satisfy this.
    assert.match(fallback.stdout, new RegExp('\\(' + (countBefore + 1) + ' notes\\)'));
    assert.match(fallback.stdout, /reviewer signature valid over the canonical record/);

    // ---- Run B: the out-of-band pin, correct -------------------------------------------------
    const pinned = run('node', ['scripts/verify-delegation-ledger.cjs'], {
      cwd: clone,
      env: { ...process.env, DSH_REVIEWER_FINGERPRINT: REVIEWER_FINGERPRINT },
    });
    assert.equal(pinned.status, 0, 'the audit failed with the correct out-of-band pin:\n' + pinned.stdout + pinned.stderr);
    assert.match(pinned.stdout, /reviewer trust root supplied out of band/);
    assert.doesNotMatch(
      pinned.stdout + pinned.stderr,
      /AUDIT_NOTICE/,
      'the in-repo notice was not suppressed, so the pin did not replace the fallback'
    );

    // ---- Run C: the out-of-band pin, wrong ---------------------------------------------------
    const mismatched = run('node', ['scripts/verify-delegation-ledger.cjs'], {
      cwd: clone,
      env: { ...process.env, DSH_REVIEWER_FINGERPRINT: '0'.repeat(64) },
    });
    assert.equal(mismatched.status, 1, 'a wrong out-of-band pin did not fail the audit');
    assert.match(mismatched.stdout + mismatched.stderr, /does not match DSH_REVIEWER_FINGERPRINT/);
    assert.match(mismatched.stdout + mismatched.stderr, /AUDIT FAILED/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
