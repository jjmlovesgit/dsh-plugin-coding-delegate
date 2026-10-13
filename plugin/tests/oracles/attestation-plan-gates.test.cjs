// Oracle: the BUILT attestation planner refuses the two inputs that used to produce a signed record
// nobody could verify.
//
// The unit tests in `tests/attestation.test.ts` prove the decision against `src/`. This proves the same
// decision survives the build into `dist/`, which is what DSH loads and therefore what decides whether an
// envelope is written. The two are not the same claim, and the difference is the whole reason this
// repository keeps both: a gate added to `src` and not reached by the artefact is a gate that does not
// exist in the running host.
//
// Properties:
//   1. An artifact whose digest could not be read withholds, and names the file.
//   2. HEAD observed to move around the verification withholds, naming both commits.
//   3. Observations that AGREE do not withhold -- the gate is about inequality, not about being asked.
//   4. A fully-resolved input still signs. Without this, a planner that refused everything would pass.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const { buildAttestationPlan } = require(PLUGIN + '/dist/crypto-attestation.js');

const KEY_PATH = '/configured/delegation-signer.pem';

function inputs(overrides) {
  return Object.assign(
    {
      privateKeyPath: KEY_PATH,
      privateKeyReadable: true,
      runId: 'turn-7-oracle',
      baseCommit: '166ff33dfb601b0a60cc40c798c42b9c986285dc',
      modelIdentifier: 'qwen/qwen3.8-27b',
      status: 'SUCCESS',
      contracts: [{ path: 'tests/contracts/thing.contract.cjs', sha256: 'aa11' }],
      artifacts: [{ path: 'tools/thing.ts', sha256: 'bb22' }],
      verification: {
        command: 'node tests/contracts/thing.contract.cjs',
        executed: true,
        exitCode: 0,
        output: 'ok 1 - fine\n',
        failed: 0,
      },
    },
    overrides || {}
  );
}

test('a missing artifact digest withholds the record instead of signing an unverifiable one', () => {
  for (const missing of [null, '', '   ', undefined]) {
    const plan = buildAttestationPlan(inputs({ artifacts: [{ path: 'tools/thing.ts', sha256: missing }] }));
    assert.equal(plan.action, 'withheld', 'sha256 ' + JSON.stringify(missing) + ' must withhold');
    assert.match(plan.reason, /artifact digest is unavailable/i);
    assert.match(plan.reason, /tools\/thing\.ts/, 'the refusal must name the file');
  }
});

test('one unhashable artifact among several withholds rather than being dropped', () => {
  const plan = buildAttestationPlan(
    inputs({
      artifacts: [
        { path: 'tools/good.ts', sha256: 'bb22' },
        { path: 'tools/bad.ts', sha256: null },
      ],
    })
  );
  assert.equal(plan.action, 'withheld');
  assert.match(plan.reason, /tools\/bad\.ts/);
});

test('HEAD observed to move around the verification withholds, naming both commits', () => {
  const plan = buildAttestationPlan(
    inputs({
      headObserved: {
        before: '166ff33dfb601b0a60cc40c798c42b9c986285dc',
        after: '9be3300000000000000000000000000000000000',
      },
    })
  );
  assert.equal(plan.action, 'withheld');
  assert.match(plan.reason, /HEAD_DRIFT_DETECTED/);
  assert.match(plan.reason, /166ff33d/);
  assert.match(plan.reason, /9be33000/);
});

test('observations that agree do not withhold, and neither does never asking', () => {
  const same = 'aa'.repeat(20);
  const agreeing = buildAttestationPlan(inputs({ headObserved: { before: same, after: same } }));
  assert.equal(agreeing.action, 'sign', 'a pair that agrees is not drift');
  const unobserved = buildAttestationPlan(inputs({ headObserved: null }));
  assert.equal(unobserved.action, 'sign', 'a host that never asked git must not be refused');
});

test('a fully resolved input still signs, so the refusals above are not a blanket refusal', () => {
  const plan = buildAttestationPlan(inputs());
  assert.equal(plan.action, 'sign');
  assert.equal(plan.payload.artifacts.length, 1);
  assert.equal(plan.payload.artifacts[0].sha256, 'bb22');
  assert.equal(plan.payload.verification.passed, true);
});
