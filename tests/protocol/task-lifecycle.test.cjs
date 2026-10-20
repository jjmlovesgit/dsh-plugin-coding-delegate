// Loopback suite for the Tier 2 unit-verdict lifecycle.
//
// The legal edges are restated here as DATA rather than imported from the module: a test that reads
// the table it is checking proves only that the file parses. If an edge disappears from the module,
// this list still expects it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', '..', 'src', 'core', 'protocol', 'task-lifecycle.ts');
const { transition, isTerminal, nextState, TERMINAL_STATES } = require(MODULE);

const STATES = [
  'DRAFT',
  'DISPATCHED',
  'CONTEXT_REFUSED',
  'VERIFIED',
  'VERIFICATION_FAILED',
  'UNIT_FLAKY',
  'WORKER_OUTPUT_STARVED',
  'ERROR',
  'ATTESTED',
];

const EVENTS = [
  'DISPATCH_SUCCESS',
  'REFUSE_CONTEXT',
  'VERIFY_PASS',
  'VERIFY_FAIL',
  'VERIFY_FLAKE',
  'OUTPUT_EMPTY',
  'TRANSPORT_ERROR',
  'ATTEST_PASS',
  'ATTEST_FAIL',
];

const LEGAL = [
  ['DRAFT', 'DISPATCH_SUCCESS', 'DISPATCHED'],
  ['DRAFT', 'REFUSE_CONTEXT', 'CONTEXT_REFUSED'],
  ['DISPATCHED', 'VERIFY_PASS', 'VERIFIED'],
  ['DISPATCHED', 'VERIFY_FAIL', 'VERIFICATION_FAILED'],
  ['DISPATCHED', 'VERIFY_FLAKE', 'UNIT_FLAKY'],
  ['DISPATCHED', 'OUTPUT_EMPTY', 'WORKER_OUTPUT_STARVED'],
  ['DISPATCHED', 'TRANSPORT_ERROR', 'ERROR'],
  ['VERIFIED', 'ATTEST_PASS', 'ATTESTED'],
  ['VERIFIED', 'ATTEST_FAIL', 'VERIFICATION_FAILED'],
];

const TERMINAL = [
  'CONTEXT_REFUSED',
  'VERIFICATION_FAILED',
  'UNIT_FLAKY',
  'WORKER_OUTPUT_STARVED',
  'ERROR',
  'ATTESTED',
];

test('task lifecycle: the unit verdict transition table', async (t) => {
  await t.test('every documented edge resolves to its documented state', () => {
    for (const [from, event, to] of LEGAL) {
      const result = transition(from, event);
      assert.equal(result.ok, true, from + ' + ' + event + ' must be legal');
      assert.equal(result.value, to);
      assert.equal(nextState(from, event), to);
    }
  });

  await t.test('an edge outside the table fails closed with a typed error', () => {
    // Every (state, event) pair that is not in LEGAL must be an Err, with no exceptions: a protocol
    // that has a "default" transition is a protocol with an undocumented one.
    for (const from of STATES) {
      for (const event of EVENTS) {
        const legal = LEGAL.some(([f, e]) => f === from && e === event);
        if (legal) continue;
        const result = transition(from, event);
        assert.equal(result.ok, false, from + ' + ' + event + ' should have been refused');
        assert.equal(result.error.code, 'ILLEGAL_TRANSITION');
        assert.equal(result.error.state, from);
        assert.equal(result.error.event, event);
      }
    }
  });

  await t.test('terminal states accept nothing at all', () => {
    for (const state of TERMINAL) {
      assert.equal(isTerminal(state), true, state + ' must be terminal');
      for (const event of EVENTS) {
        const result = transition(state, event);
        assert.equal(result.ok, false, state + ' accepted ' + event);
        assert.equal(result.error.code, 'ILLEGAL_TRANSITION');
      }
    }
  });

  await t.test('non-terminal states are exactly the three that can still move', () => {
    const movable = STATES.filter((state) => !isTerminal(state));
    assert.deepEqual(movable.sort(), ['DISPATCHED', 'DRAFT', 'VERIFIED']);
    assert.deepEqual([...TERMINAL_STATES].sort(), TERMINAL.slice().sort());
  });

  await t.test('an unknown state or event is rejected by name', () => {
    const badState = transition('BOUND', 'DISPATCH_SUCCESS');
    assert.equal(badState.ok, false);
    assert.equal(badState.error.code, 'UNKNOWN_STATE');

    const badEvent = transition('DRAFT', 'RESUME');
    assert.equal(badEvent.ok, false);
    assert.equal(badEvent.error.code, 'UNKNOWN_EVENT');
  });

  await t.test('every state is reachable from DRAFT', () => {
    const seen = new Set(['DRAFT']);
    const queue = ['DRAFT'];
    while (queue.length > 0) {
      const state = queue.shift();
      for (const [from, , to] of LEGAL) {
        if (from === state && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    assert.deepEqual([...seen].sort(), STATES.slice().sort(), 'an unreachable state is dead specification');
  });

  await t.test('the same request yields the same verdict', () => {
    const run = () => LEGAL.map(([from, event]) => transition(from, event));
    assert.deepEqual(run(), run());
  });
});
