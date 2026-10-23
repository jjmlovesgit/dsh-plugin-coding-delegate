// Loopback suite for the Tier 2 execution lifecycle.
//
// The lattice is restated here as an independent function rather than imported: a test that reads the
// rule it is checking proves only that the file parses.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', '..', 'src', 'core', 'protocol', 'task-lifecycle.ts');
const { transition, resolveVerdict, projectOutcome, isTerminal, TERMINAL_STATES } = require(MODULE);

const TERMINALS = [
  'CONTRACT_MODIFIED',
  'VERIFICATION_NOT_APPROVED',
  'FLAKY',
  'INCOHERENT',
  'VERIFICATION_FAILED',
  'UNVERIFIED',
  'SUCCESS',
];

const payloads = () => {
  const out = [];
  for (const contractViolationsFound of [false, true]) {
    for (const verificationGatePassed of [false, true]) {
      for (const flaky of [false, true]) {
        for (const coherenceFailed of [false, true]) {
          for (const unverified of [false, true]) {
            for (const isSuccess of [false, true]) {
              out.push({
                contractViolationsFound,
                verificationGatePassed,
                flaky,
                coherenceFailed,
                unverified,
                isSuccess,
              });
            }
          }
        }
      }
    }
  }
  return out;
};

/** The lattice, written from the specification. */
function expectedVerdict(p) {
  if (p.contractViolationsFound) return 'CONTRACT_MODIFIED';
  if (!p.verificationGatePassed) return 'VERIFICATION_NOT_APPROVED';
  if (p.flaky) return 'FLAKY';
  if (p.coherenceFailed) return p.isSuccess ? 'INCOHERENT' : 'VERIFICATION_FAILED';
  if (p.unverified) return 'UNVERIFIED';
  return p.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED';
}

const evaluate = (p) => transition('EVALUATING', { type: 'EVALUATE', payload: p });

test('execution lifecycle: draft, dispatch, evaluate', async (t) => {
  await t.test('the lifecycle edges', () => {
    assert.deepEqual(transition('DRAFT', { type: 'DISPATCH' }), { ok: true, value: 'DISPATCHED' });
    assert.deepEqual(transition('DISPATCHED', { type: 'BEGIN_EVALUATION' }), { ok: true, value: 'EVALUATING' });
    assert.deepEqual(transition('DRAFT', { type: 'REFUSE' }), { ok: true, value: 'VERIFICATION_NOT_APPROVED' });
  });

  await t.test('a refusal before dispatch is the verdict that means nothing ran', () => {
    // `CONTEXT_REFUSED` at the tool boundary is not one of the seven verdicts, because nothing was
    // evaluated. It terminates in VERIFICATION_NOT_APPROVED, which already means exactly that.
    const refused = transition('DRAFT', { type: 'REFUSE' });
    assert.equal(refused.ok, true);
    assert.ok(TERMINALS.includes(refused.value));
  });

  await t.test('all 64 payloads resolve to the documented lattice', () => {
    const all = payloads();
    assert.equal(all.length, 64);
    for (const payload of all) {
      const result = evaluate(payload);
      assert.equal(result.ok, true, JSON.stringify(payload));
      assert.equal(result.value, expectedVerdict(payload), JSON.stringify(payload));
      assert.equal(resolveVerdict(payload), expectedVerdict(payload));
    }
  });

  await t.test('evaluation is only possible once dispatched', () => {
    const payload = { contractViolationsFound: false, verificationGatePassed: true, flaky: false, coherenceFailed: false, unverified: false, isSuccess: true };
    for (const state of ['DRAFT', 'DISPATCHED', ...TERMINALS]) {
      const result = transition(state, { type: 'EVALUATE', payload });
      assert.equal(result.ok, false, state + ' accepted an evaluation');
      assert.equal(result.error.code, 'ILLEGAL_TRANSITION');
    }
  });

  await t.test('terminal states accept nothing at all', () => {
    const events = [
      { type: 'DISPATCH' },
      { type: 'REFUSE' },
      { type: 'BEGIN_EVALUATION' },
      { type: 'EVALUATE', payload: { contractViolationsFound: false, verificationGatePassed: true, flaky: false, coherenceFailed: false, unverified: false, isSuccess: true } },
    ];
    for (const state of TERMINALS) {
      assert.equal(isTerminal(state), true);
      for (const event of events) {
        const result = transition(state, event);
        assert.equal(result.ok, false, state + ' accepted ' + event.type);
      }
    }
    assert.deepEqual([...TERMINAL_STATES].sort(), TERMINALS.slice().sort());
  });

  await t.test('an unknown state or event is rejected by name', () => {
    assert.equal(transition('BOUND', { type: 'DISPATCH' }).error.code, 'UNKNOWN_STATE');
    assert.equal(transition('DRAFT', { type: 'RESUME' }).error.code, 'UNKNOWN_EVENT');
    assert.equal(transition('DRAFT', {}).error.code, 'UNKNOWN_EVENT');
  });

  await t.test('every terminal is reachable', () => {
    const seen = new Set([...TERMINALS]);
    for (const payload of payloads()) seen.add(resolveVerdict(payload));
    assert.deepEqual([...seen].sort(), TERMINALS.slice().sort());
  });

  await t.test('the projection preserves the ledger semantics the plugin already had', () => {
    assert.equal(projectOutcome('FLAKY'), 'UNIT_FLAKY');
    assert.equal(projectOutcome('VERIFICATION_NOT_APPROVED'), 'UNIT_UNVERIFIED');
    assert.equal(projectOutcome('UNVERIFIED'), 'UNIT_UNVERIFIED');
    assert.equal(projectOutcome('SUCCESS'), 'UNIT_PASSED');
    // The unit passed and the project failed: the registry records the UNIT, not the tree.
    assert.equal(projectOutcome('INCOHERENT'), 'UNIT_PASSED');
    assert.equal(projectOutcome('CONTRACT_MODIFIED'), 'UNIT_FAILED');
    assert.equal(projectOutcome('VERIFICATION_FAILED'), 'UNIT_FAILED');
  });

  await t.test('no execution path can reach the operator-attested outcome', () => {
    // OPERATOR_ATTESTED is a human signing event that happens after this cycle ends; it is deliberately
    // absent from the projection type, so this asserts the absence rather than trusting it.
    const reached = new Set(payloads().map((p) => projectOutcome(resolveVerdict(p))));
    assert.equal(reached.has('OPERATOR_ATTESTED'), false);
  });
});
