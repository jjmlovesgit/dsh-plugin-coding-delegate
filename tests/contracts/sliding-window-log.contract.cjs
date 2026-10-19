/**
 * @sdlc.tier1
 * @target tools/sliding-window-log.ts
 * @requirements
 * Export exactly one class: SlidingWindowLog, and nothing else.
 * Zero imports: no Node built-ins, no external packages, no type imports.
 * Constructor: new SlidingWindowLog(windowMs: number, maxRequests: number).
 * - windowMs must be a positive finite number, else throw RangeError.
 * - maxRequests must be a positive integer, else throw RangeError.
 * allow(key: string, now: number): boolean
 * - Evicts every recorded timestamp t for that key with (now - t) >= windowMs.
 * - If fewer than maxRequests timestamps remain, records `now` and returns true; otherwise false.
 * - A refused request records nothing.
 * getRemaining(key: string, now: number): number
 * - Evicts on access exactly as allow does, then returns maxRequests minus the surviving count.
 * - An unknown key returns maxRequests. Never returns a negative number, never consumes capacity.
 * reset(key?: string): void
 * - With a key, clears that key only and leaves every other key untouched.
 * - With no argument, clears every key.
 * Keys are independent: one key's timestamps never affect another's capacity.
 * State lives in #private fields.
 *
 * THE CONTRACT FOR SlidingWindowLog. Architect-authored: hashed before the unit runs and re-hashed
 * after it, so the worker may not touch it and any change to it voids the verdict.
 *
 * WHAT DISCRIMINATES THIS SUITE. A sliding-window log is a list of timestamps and a filter, so the
 * capacity half is trivial and every real defect lives in the EXPIRY. An implementation that keeps a
 * count per tumbling window passes every capacity assertion and then hands a caller a fresh bucket at
 * a window boundary, which is exactly the burst a sliding window exists to prevent. Case 6 is the
 * case that reaches it; tests/contracts/fixtures/sliding-window-log.negative.ts is that implementation.
 *
 * SEMANTICS PINNED, because two choices are each defensible and an unpinned one makes the randomised
 * model ambiguous rather than able to fail:
 *   - An entry is inside the window iff (now - t) < windowMs. At exactly windowMs it is EXPIRED.
 *   - `getRemaining` evicts on access, so a later read sees the window the current time implies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SlidingWindowLog } = require(path.join(__dirname, '..', '..', 'tools', 'sliding-window-log.ts'));

/**
 * Build a limiter and assert its surface before anything calls it. Against the null implementation
 * this fails at the first ASSERTION, which is what keeps a null run from reporting a TypeError as the
 * contract malfunctioning on its own account.
 */
function limiter(windowMs, maxRequests) {
  const instance = new SlidingWindowLog(windowMs, maxRequests);
  assert.equal(typeof instance.allow, 'function', 'SlidingWindowLog must expose allow(key, now)');
  assert.equal(typeof instance.getRemaining, 'function', 'SlidingWindowLog must expose getRemaining(key, now)');
  assert.equal(typeof instance.reset, 'function', 'SlidingWindowLog must expose reset(key?)');
  return instance;
}

test('SlidingWindowLog strict specification contract', async (t) => {
  await t.test('is self-contained and exports exactly one class', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/sliding-window-log.ts'), 'utf8');
    assert.match(src, /export\s+class\s+SlidingWindowLog/, 'Must export class SlidingWindowLog');
    assert.doesNotMatch(src, /^\s*import\s/m, 'the module must be self-contained: no imports');
  });

  await t.test('rejects a window or limit that is not a positive number', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      assert.throws(() => new SlidingWindowLog(bad, 3), RangeError, 'windowMs ' + String(bad) + ' must throw RangeError');
    }
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => new SlidingWindowLog(1000, bad), RangeError, 'maxRequests ' + String(bad) + ' must throw RangeError');
    }
  });

  await t.test('an unknown key starts with the full allowance, and nothing is consumed by reading', () => {
    const log = limiter(1000, 3);
    assert.equal(log.getRemaining('nobody', 500), 3);
    assert.equal(log.getRemaining('nobody', 500), 3, 'reading must not consume capacity');
  });

  await t.test('allows exactly maxRequests inside one window and then refuses', () => {
    const log = limiter(1000, 3);
    assert.equal(log.allow('a', 100), true);
    assert.equal(log.allow('a', 200), true);
    assert.equal(log.allow('a', 300), true);
    assert.equal(log.getRemaining('a', 300), 0);
    assert.equal(log.allow('a', 400), false, 'the fourth request inside the window must be refused');
    assert.equal(log.getRemaining('a', 400), 0, 'a refused request must not consume anything');
  });

  await t.test('an entry at exactly windowMs is expired', () => {
    const log = limiter(1000, 1);
    assert.equal(log.allow('k', 0), true);
    assert.equal(log.getRemaining('k', 999), 0, 'just inside the window the entry still counts');
    assert.equal(log.getRemaining('k', 1000), 1, 'at exactly windowMs the entry has expired');
  });

  await t.test('SLIDING EXPIRY: each timestamp leaves on its own schedule, not with a shared window', () => {
    // The case a tumbling-window implementation cannot pass. At t=1150 only t=100 has aged out, so
    // exactly one slot is free -- not all three, which is what resetting a window start would give.
    const log = limiter(1000, 3);
    log.allow('u', 100);
    log.allow('u', 200);
    log.allow('u', 300);

    assert.equal(log.getRemaining('u', 1150), 1, 'only the t=100 entry has left the window');
    assert.equal(log.allow('u', 1150), true, 'the freed slot is usable');
    assert.equal(log.allow('u', 1150), false, 'and only one slot was free');
    // 1250 - 200 = 1050, which is >= windowMs, so t=200 has expired too: two entries remain alive
    // (300 and 1150) and one slot is free. Measured: the first draft of this case asserted 0 here and
    // the worker's implementation was right to disagree.
    assert.equal(log.getRemaining('u', 1250), 1, 't=200 has also left the window by 1250');

    assert.equal(log.getRemaining('u', 1300), 2, 't=300 leaves at 1300, leaving the 1150 entry alone');
    assert.equal(log.getRemaining('u', 2150), 3, 'every original entry has expired by 2150');
  });

  await t.test('keys are isolated from one another', () => {
    const log = limiter(1000, 1);
    assert.equal(log.allow('a', 10), true);
    assert.equal(log.allow('b', 10), true, 'a different key has its own allowance');
    assert.equal(log.allow('a', 20), false);
    assert.equal(log.allow('b', 20), false);
    assert.equal(log.getRemaining('a', 20), 0);
    assert.equal(log.getRemaining('b', 20), 0);
    assert.equal(log.getRemaining('c', 20), 1, 'a key never seen has the full allowance');
  });

  await t.test('reset clears one key, or all of them', () => {
    const log = limiter(1000, 2);
    log.allow('a', 0);
    log.allow('b', 0);

    log.reset('a');
    assert.equal(log.getRemaining('a', 0), 2, 'the named key is restored');
    assert.equal(log.getRemaining('b', 0), 1, 'and the other key is untouched');

    log.reset();
    assert.equal(log.getRemaining('a', 0), 2);
    assert.equal(log.getRemaining('b', 0), 2, 'reset() clears everything');
  });

  await t.test('matches a timestamp-log reference model across randomised arrivals', () => {
    const model = (windowMs, maxRequests) => {
      const logs = new Map();
      const alive = (key, now) =>
        (logs.get(key) || []).filter((at) => now - at < windowMs);
      return {
        allow(key, now) {
          const kept = alive(key, now);
          if (kept.length >= maxRequests) return false;
          kept.push(now);
          logs.set(key, kept);
          return true;
        },
        getRemaining(key, now) {
          const kept = alive(key, now);
          logs.set(key, kept);
          return maxRequests - kept.length;
        },
      };
    };

    const WINDOW = 50;
    const MAX = 4;
    const log = limiter(WINDOW, MAX);
    const reference = model(WINDOW, MAX);

    let seed = 24681357;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const KEYS = ['k0', 'k1', 'k2'];
    let now = 0;

    for (let step = 0; step < 400; step += 1) {
      now += next() % 9; // a monotonically advancing clock, so the model needs no clock policy
      const key = KEYS[next() % KEYS.length];
      const decision = log.allow(key, now);
      assert.equal(decision, reference.allow(key, now), 'allow disagreed at step ' + step);
      assert.equal(
        log.getRemaining(key, now),
        reference.getRemaining(key, now),
        'getRemaining disagreed at step ' + step
      );
    }
  });
});
