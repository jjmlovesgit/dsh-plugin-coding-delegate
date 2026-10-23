// Parity oracle: the Tier 2 specification and the plugin's implementation must agree.
//
// `plugin/` may not import `src/core/protocol/` — the package ships standalone and has to resolve
// entirely inside itself — so the lattice exists twice: once as the specification in
// `src/core/protocol/task-lifecycle.ts`, once as `resolveDelegateStatus` in the plugin. Two copies of
// a rule is exactly how a rule drifts, and this is the same guard the vendored backoff uses.
//
// The plugin's function takes the six inputs in a slightly different shape (a gate STRING rather than a
// boolean), so the comparison maps between them rather than assuming they are identical.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SPEC = require(path.join(__dirname, '..', 'src', 'core', 'protocol', 'task-lifecycle.ts'));
const { resolveDelegateStatus } = require(path.join(__dirname, '..', 'plugin', 'dist', 'delegation.js'));

test('the lattice specification and the plugin implementation agree', async (t) => {
  await t.test('all 64 combinations produce the same verdict', () => {
    let compared = 0;
    for (const contractViolationsFound of [false, true]) {
      for (const verificationGatePassed of [false, true]) {
        for (const flaky of [false, true]) {
          for (const coherenceFailed of [false, true]) {
            for (const unverified of [false, true]) {
              for (const isSuccess of [false, true]) {
                const payload = {
                  contractViolationsFound,
                  verificationGatePassed,
                  flaky,
                  coherenceFailed,
                  unverified,
                  isSuccess,
                };
                const spec = SPEC.resolveVerdict(payload);
                const plugin = resolveDelegateStatus({
                  verificationGate: verificationGatePassed ? null : 'denied by operator',
                  unverified,
                  contractViolations: contractViolationsFound ? ['tests/x.contract.cjs was modified'] : [],
                  isSuccess,
                  coherenceFailed,
                  flaky,
                });
                assert.equal(plugin, spec, JSON.stringify(payload));
                compared += 1;
              }
            }
          }
        }
      }
    }
    assert.equal(compared, 64);
  });

  await t.test('both cover the same seven verdicts', () => {
    const seen = new Set();
    for (const contractViolationsFound of [false, true]) {
      for (const verificationGatePassed of [false, true]) {
        for (const flaky of [false, true]) {
          for (const coherenceFailed of [false, true]) {
            for (const unverified of [false, true]) {
              for (const isSuccess of [false, true]) {
                seen.add(SPEC.resolveVerdict({ contractViolationsFound, verificationGatePassed, flaky, coherenceFailed, unverified, isSuccess }));
              }
            }
          }
        }
      }
    }
    assert.deepEqual([...seen].sort(), [
      'CONTRACT_MODIFIED',
      'FLAKY',
      'INCOHERENT',
      'SUCCESS',
      'UNVERIFIED',
      'VERIFICATION_FAILED',
      'VERIFICATION_NOT_APPROVED',
    ].sort());
  });
});
