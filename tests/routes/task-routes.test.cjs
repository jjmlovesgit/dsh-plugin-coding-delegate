// Loopback suite for the Tier 3 route adapter.
//
// Tier 3 has no attestation obligation (POL §2 gives it static analysis and smoke tests), so this
// suite is the evidence that the adapter's mapping is the one it claims: 200 on a legal transition,
// 409 when the lifecycle refuses a well-formed request, 400 when the arguments are unusable, and no
// path that turns a caller's mistake into a 500.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTES = path.join(__dirname, '..', '..', 'src', 'routes', 'task-routes.ts');
const ENGINE = path.join(__dirname, '..', '..', 'src', 'engine', 'task-state-machine.ts');
const { handleGetSnapshot, handleTaskTransition } = require(ROUTES);
const { TaskStateMachine } = require(ENGINE);

const machine = (options = {}) => new TaskStateMachine(options);

test('task route adapter loopback suite', async (t) => {
  await t.test('serializes the snapshot of a fresh machine', () => {
    const response = handleGetSnapshot(machine());
    assert.equal(response.status, 200);
    assert.equal(response.body.state, 'IDLE');
    assert.equal(response.body.attempt, 0);
    assert.equal(response.body.maxAttempts, 3);
    assert.equal(response.body.transitions, 0);
  });

  await t.test('drives the happy path and reports each state', () => {
    const m = machine();
    assert.equal(handleTaskTransition(m, { action: 'delegate', now: 10 }).body.state, 'DELEGATED');
    assert.equal(handleTaskTransition(m, { action: 'start', now: 20 }).body.state, 'RUNNING');
    const done = handleTaskTransition(m, { action: 'complete', now: 30 });
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'COMPLETED');
    assert.equal(done.body.retryDelayMs, null);
    assert.equal(handleGetSnapshot(m).body.transitions, 3);
  });

  await t.test('maps a lifecycle refusal to 409, not 500', () => {
    const m = machine();
    const early = handleTaskTransition(m, { action: 'complete', now: 5 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'ILLEGAL_TRANSITION');
    assert.match(String(early.body.detail), /IDLE -> COMPLETED/);
  });

  await t.test('maps unusable arguments to 400', () => {
    const m = machine();
    assert.equal(handleTaskTransition(m, { action: 'teleport', now: 5 }).status, 400);
    assert.equal(handleTaskTransition(m, { action: 'teleport', now: 5 }).body.error, 'UNKNOWN_ACTION');
    assert.equal(handleTaskTransition(m, { now: 5 }).body.action, null, 'a missing action is reported as null');
    assert.equal(handleTaskTransition(m, { action: 'delegate', now: 'soon' }).body.error, 'INVALID_TIMESTAMP');
    assert.equal(handleTaskTransition(m, { action: 'delegate', now: NaN }).status, 400);
    assert.equal(handleTaskTransition(m, { action: 'delegate' }).status, 400);
  });

  await t.test('reports the retry delay that the backoff computed', () => {
    const m = machine({ maxAttempts: 2 });
    handleTaskTransition(m, { action: 'delegate', now: 0 });
    handleTaskTransition(m, { action: 'start', now: 1 });
    const first = handleTaskTransition(m, { action: 'fail', now: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'DELEGATED');
    assert.equal(first.body.retryDelayMs, 100, 'the default backoff is 100ms base');

    handleTaskTransition(m, { action: 'start', now: 100 });
    const last = handleTaskTransition(m, { action: 'fail', now: 101 });
    assert.equal(last.body.state, 'FAILED');
    assert.equal(last.body.retryDelayMs, null, 'a terminal failure has no retry');
  });

  await t.test('refuses further transitions once terminal, still as 409', () => {
    const m = machine();
    handleTaskTransition(m, { action: 'delegate', now: 0 });
    handleTaskTransition(m, { action: 'start', now: 1 });
    handleTaskTransition(m, { action: 'timeout', now: 2 });
    const after = handleTaskTransition(m, { action: 'delegate', now: 3 });
    assert.equal(after.status, 409);
    assert.match(String(after.body.detail), /TIMED_OUT -> DELEGATED/);
  });

  await t.test('is deterministic: the same requests produce the same bodies', () => {
    const run = () => {
      const m = machine();
      return [
        handleTaskTransition(m, { action: 'delegate', now: 0 }).body,
        handleTaskTransition(m, { action: 'start', now: 1 }).body,
        handleTaskTransition(m, { action: 'fail', now: 2 }).body,
        handleGetSnapshot(m).body,
      ];
    };
    assert.deepEqual(run(), run());
  });
});
