// Loopback suite for the Tier 2 task engine.
//
// Written as a loopback rather than a contract: Tier 2 has no attestation requirement (POL §2), so
// this suite IS the evidence, and it has to be runnable by `npm run test:engine` from a clean clone
// with no worker, no keys and no network.
//
// Strict mode is required by one assertion: assigning to a frozen snapshot throws only in strict
// code, and the test wants that throw to be observed rather than a silent no-op.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ENGINE = path.join(__dirname, '..', '..', 'src', 'engine', 'task-state-machine.ts');
const BACKOFF = path.join(__dirname, '..', '..', 'tools', 'exponential-backoff.ts');
const { TaskStateMachine } = require(ENGINE);
const { ExponentialBackoff } = require(BACKOFF);

const build = (options = {}) => new TaskStateMachine(options);

test('TaskStateMachine loopback suite', async (t) => {
  await t.test('refuses an options object that cannot drive the machine', () => {
    assert.throws(() => build({ backoff: {} }), TypeError, 'a backoff without computeDelay');
    for (const bad of [0, -1, 1.5, NaN]) {
      assert.throws(() => build({ maxAttempts: bad }), RangeError, 'maxAttempts ' + String(bad));
    }
  });

  await t.test('walks the happy path and records every transition', () => {
    const machine = build();
    assert.equal(machine.state, 'IDLE');

    machine.delegate(1000);
    assert.equal(machine.state, 'DELEGATED');
    machine.start(1010);
    assert.equal(machine.state, 'RUNNING');
    const done = machine.complete(1100);

    assert.equal(done.state, 'COMPLETED');
    assert.equal(done.attempt, 0, 'a first-try completion consumed no attempt');
    assert.deepEqual(
      done.transitions.map((t) => t.from + '>' + t.to),
      ['IDLE>DELEGATED', 'DELEGATED>RUNNING', 'RUNNING>COMPLETED']
    );
    assert.deepEqual(done.transitions.map((t) => t.at), [1000, 1010, 1100]);
  });

  await t.test('refuses transitions the lifecycle does not have', () => {
    const idle = build();
    assert.throws(() => idle.start(0), /TASK_ILLEGAL_TRANSITION: IDLE -> RUNNING/);
    assert.throws(() => idle.complete(0), /TASK_ILLEGAL_TRANSITION: IDLE -> COMPLETED/);
    assert.throws(() => idle.fail(0), /fail\(\) from IDLE/);

    const delegated = build();
    delegated.delegate(0);
    assert.throws(() => delegated.complete(1), /DELEGATED -> COMPLETED/);

    const done = build();
    done.delegate(0);
    done.start(1);
    done.complete(2);
    for (const attempt of [() => done.delegate(3), () => done.start(3), () => done.timeout(3)]) {
      assert.throws(attempt, /TASK_ILLEGAL_TRANSITION: COMPLETED ->/);
    }
  });

  await t.test('a transient failure returns to DELEGATED with the backoff delay for that attempt', () => {
    const machine = build({
      maxAttempts: 3,
      backoff: new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'none' }),
    });

    machine.delegate(0);
    machine.start(10);
    const first = machine.fail(20);
    assert.equal(first.state, 'DELEGATED');
    assert.equal(first.retryDelayMs, 100, 'the first retry waits the base delay (backoff attempt 0)');

    machine.start(120);
    const second = machine.fail(130);
    assert.equal(second.retryDelayMs, 200, 'the second retry doubles');

    machine.start(330);
    const third = machine.fail(340);
    assert.equal(third.state, 'FAILED', 'the last tolerated failure settles the unit');
    assert.equal(third.retryDelayMs, null, 'a terminal failure has no retry');

    assert.equal(machine.attempt, 3);
    assert.throws(() => machine.delegate(350), /FAILED ->/);
  });

  await t.test('a timeout is terminal and does not consume an attempt', () => {
    const machine = build();
    machine.delegate(0);
    machine.start(5);
    machine.timeout(900);
    assert.equal(machine.state, 'TIMED_OUT');
    assert.equal(machine.attempt, 0);
    assert.throws(() => machine.fail(901), /fail\(\) from TIMED_OUT/);
  });

  await t.test('snapshots are frozen copies, not views', () => {
    const machine = build();
    machine.delegate(0);
    const snapshot = machine.snapshot();

    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.transitions));
    assert.throws(() => {
      snapshot.state = 'RUNNING';
    }, TypeError);
    assert.throws(() => {
      snapshot.transitions.push({});
    }, TypeError);

    machine.start(1);
    assert.equal(snapshot.state, 'DELEGATED', 'the earlier snapshot did not change');
    assert.equal(snapshot.transitions.length, 1);
    assert.equal(machine.snapshot().transitions.length, 2);
  });

  await t.test('replaying the same sequence produces the same trail', () => {
    const run = () => {
      const machine = build({ maxAttempts: 2 });
      machine.delegate(0);
      machine.start(1);
      machine.fail(2);
      machine.start(3);
      machine.fail(4);
      return machine.snapshot();
    };
    assert.deepEqual(run(), run());
  });

  await t.test('rejects a non-finite timestamp', () => {
    const machine = build();
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => machine.delegate(bad), RangeError, 'now ' + String(bad));
    }
  });
});
