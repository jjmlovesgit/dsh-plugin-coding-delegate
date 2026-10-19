/**
 * @requirements
 * 1. `new CancellationToken()` starts uncancelled and `isCancelled()` returns false.
 * 2. `cancel()` is idempotent and flips `isCancelled()` to true.
 * 3. `throwIfCancelled()` throws an Error whose message mentions "cancel" when the token is cancelled,
 *    and returns undefined (does not throw) while it is not.
 * 4. `onCancel(cb)` registers a listener that is invoked exactly once when `cancel()` is called.
 * 5. `onCancel(cb)` on an ALREADY cancelled token invokes `cb` synchronously before returning.
 * 6. `onCancel(cb)` returns an unsubscribe function; after calling it, the listener never runs.
 * 7. Multiple listeners are invoked in registration order, all of them, exactly once.
 * 8. The module is a Tier 1 leaf: no import and no require of anything.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', '..', 'tools', 'cancellation-token.ts');
// Literal, not path.join: the atomic harness mirrors the mutant into `../../tools/` and checks that the
// contract reaches its module through that exact specifier, so it can prove the fixture takes the real
// module's place rather than trusting a resolved path.
const { CancellationToken } = require('../../tools/cancellation-token.ts');

test('cancellation token: cancellation state and listeners', async (t) => {
  await t.test('is a leaf: the module imports nothing', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, 'a Tier 1 primitive may not import anything');
    assert.doesNotMatch(source, /\brequire\s*\(/, 'a Tier 1 primitive may not require anything');
  });

  await t.test('starts uncancelled and throwIfCancelled does not throw', () => {
    const token = new CancellationToken();
    assert.equal(token.isCancelled(), false);
    assert.equal(token.throwIfCancelled(), undefined);
  });

  await t.test('cancel flips the state, and cancelling twice is harmless', () => {
    const token = new CancellationToken();
    token.cancel();
    assert.equal(token.isCancelled(), true);
    token.cancel();
    assert.equal(token.isCancelled(), true);
  });

  await t.test('throwIfCancelled throws an error that names cancellation', () => {
    const token = new CancellationToken();
    token.cancel();
    assert.throws(
      () => token.throwIfCancelled(),
      (error) => /cancel/i.test(String(error && error.message)),
      'the thrown error must mention cancellation'
    );
  });

  await t.test('a listener registered before cancel runs exactly once', () => {
    const token = new CancellationToken();
    const calls = [];
    token.onCancel(() => calls.push('first'));
    assert.deepEqual(calls, [], 'a listener must not run before cancellation');
    token.cancel();
    token.cancel();
    assert.deepEqual(calls, ['first']);
  });

  await t.test('a listener registered after cancel runs immediately', () => {
    const token = new CancellationToken();
    token.cancel();
    const calls = [];
    token.onCancel(() => calls.push('late'));
    assert.deepEqual(calls, ['late'], 'a late listener must run synchronously');
  });

  await t.test('unsubscribing before cancel prevents the listener from running', () => {
    const token = new CancellationToken();
    const calls = [];
    const unsubscribe = token.onCancel(() => calls.push('removed'));
    assert.equal(typeof unsubscribe, 'function', 'onCancel must return an unsubscribe function');
    unsubscribe();
    token.cancel();
    assert.deepEqual(calls, []);
  });

  await t.test('multiple listeners all run, in registration order', () => {
    const token = new CancellationToken();
    const calls = [];
    token.onCancel(() => calls.push('a'));
    token.onCancel(() => calls.push('b'));
    token.onCancel(() => calls.push('c'));
    token.cancel();
    assert.deepEqual(calls, ['a', 'b', 'c']);
  });
});
