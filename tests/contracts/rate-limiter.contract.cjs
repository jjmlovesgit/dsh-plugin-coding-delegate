// The contract for TokenBucket. Architect-authored: hashed before the unit runs and re-hashed after it,
// so the worker may not touch it and any change to it voids the verdict.
//
// WHAT DISCRIMINATES THIS SUITE. A token bucket is arithmetic plus a clock, and the arithmetic is
// trivial. Everything that can be wrong lives in the CARRY. Refill is continuous, so a bucket read at
// 400 ms intervals must accumulate 0.4, 0.8, then 1.2 tokens; an implementation that floors each
// increment and restarts the interval from the last read never reaches 1 token and starves under
// exactly the bursty traffic a limiter exists to absorb. Case 6 is the case that reaches it, and
// tests/contracts/fixtures/rate-limiter.negative.ts is that implementation.
//
// SEMANTICS PINNED BECAUSE AN IMPLEMENTATION COULD REASONABLY GO EITHER WAY, and an unpinned choice
// would make the randomised model ambiguous rather than able to fail:
//
//   - `available` is FRACTIONAL and LAZY. It is derived from elapsed time on every read; there is no
//     timer, and nothing rounds it.
//   - `tryRemove` is ATOMIC. An insufficient request consumes nothing -- not a partial token.
//   - refill SATURATES at capacity. Idle time cannot bank a burst larger than the bucket.
//   - the clock is INJECTED (`now`), which is what lets this contract test an hour of refill in
//     microseconds without sleeping.
//
// THE `bucket()` HELPER IS NOT ONLY CONVENIENCE. It asserts the object's shape before a test touches
// it, so a run against the null implementation fails at the first ASSERTION in every case rather than
// dying on `bucket.tryRemove is not a function`. The null-stub guard in scripts/check-contract.cjs
// counts a TypeError as the contract malfunctioning on its own account, which is the one thing a
// contract must never do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TokenBucket } = require(path.join(__dirname, '..', '..', 'tools', 'rate-limiter.ts'));

/** A clock the test drives by hand. Time starts at a non-zero value on purpose: an implementation that
 * derives refill from an absolute timestamp instead of a delta looks correct when the origin is 0. */
function clockAt(start) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

/** Build a bucket and assert the promised surface before anything calls it. */
function bucket(options, clock) {
  const b = new TokenBucket({ now: clock.now, ...options });
  assert.equal(typeof b.tryRemove, 'function', 'TokenBucket must expose tryRemove(count?)');
  assert.equal(typeof b.msUntil, 'function', 'TokenBucket must expose msUntil(count?)');
  assert.equal(typeof b.reset, 'function', 'TokenBucket must expose reset()');
  assert.equal(typeof b.available, 'number', 'TokenBucket must expose a numeric `available`');
  assert.equal(typeof b.capacity, 'number', 'TokenBucket must expose a numeric `capacity`');
  return b;
}

test('TokenBucket strict specification contract', async (t) => {
  await t.test('is self-contained and exports the class', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/rate-limiter.ts'), 'utf8');
    assert.match(src, /export\s+class\s+TokenBucket/, 'Must export class TokenBucket');
    assert.doesNotMatch(src, /^\s*import\s/m, 'the module must be self-contained: no imports');
    assert.equal(typeof TokenBucket, 'function');
  });

  await t.test('rejects a capacity that is not a positive finite number', () => {
    // 1.5 is deliberately NOT in this list. Capacity is a number of tokens, tokens are fractional in
    // this model, and the specification says "positive finite" -- so demanding an integer here would
    // be the contract asserting a rule the unit was never given. Measured: it was in the list, and
    // the worker's implementation was right to accept it.
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => new TokenBucket({ capacity: bad, refillPerSecond: 1 }),
        RangeError,
        'capacity ' + String(bad) + ' must throw RangeError'
      );
    }
  });

  await t.test('rejects a refill rate that is negative, non-numeric or infinite', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => new TokenBucket({ capacity: 10, refillPerSecond: bad }),
        RangeError,
        'refillPerSecond ' + String(bad) + ' must throw RangeError'
      );
    }
    // Zero is legal: a fixed quota with no refill is a bucket, not a misuse.
    assert.doesNotThrow(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 }));
  });

  await t.test('starts full and reports its capacity', () => {
    const clock = clockAt(1_000_000);
    const b = bucket({ capacity: 10, refillPerSecond: 2 }, clock);
    assert.equal(b.capacity, 10);
    assert.equal(b.available, 10);
  });

  await t.test('consumes a token and reports the fractional remainder', () => {
    const clock = clockAt(5_000);
    const b = bucket({ capacity: 10, refillPerSecond: 2 }, clock);

    assert.equal(b.tryRemove(), true, 'the default count is one token');
    assert.equal(b.available, 9);
    assert.equal(b.tryRemove(3), true);
    assert.equal(b.available, 6);
  });

  await t.test('an insufficient request consumes NOTHING', () => {
    const clock = clockAt(0);
    const b = bucket({ capacity: 2, refillPerSecond: 0 }, clock);
    b.tryRemove(2);

    assert.equal(b.tryRemove(1), false, 'an empty bucket refuses');
    assert.equal(b.available, 0, 'a refused request must not go into debt, and must not half-consume');
    assert.equal(b.tryRemove(0.5), false, 'a fractional request larger than the remainder also refuses');
    assert.equal(b.available, 0);

    // More than capacity can never succeed, however long the caller waits.
    assert.equal(b.tryRemove(3), false, 'a request above capacity is impossible, not merely early');
  });

  await t.test('FRACTIONAL REFILL CARRIES: 0.4 + 0.4 + 0.4 tokens is 1.2, and one is available', () => {
    // The case a floor-per-read implementation cannot pass. Each read restarts the interval in that
    // implementation, so every increment floors to 0 and the bucket never fills at all.
    const clock = clockAt(10_000);
    const b = bucket({ capacity: 10, refillPerSecond: 1 }, clock);
    b.tryRemove(10);

    assert.equal(b.available, 0);
    clock.advance(400);
    assert.ok(Math.abs(b.available - 0.4) < 1e-9, 'after 400 ms at 1/s the bucket holds 0.4, got ' + b.available);
    clock.advance(400);
    assert.ok(Math.abs(b.available - 0.8) < 1e-9, 'after 800 ms it holds 0.8, got ' + b.available);
    clock.advance(400);

    assert.equal(b.tryRemove(1), true, '1.2 tokens have accumulated, so one token is available');
    assert.ok(Math.abs(b.available - 0.2) < 1e-9, 'the leftover 0.2 must survive the spend, got ' + b.available);
  });

  await t.test('refill saturates at capacity and idle time banks nothing beyond it', () => {
    const clock = clockAt(0);
    const b = bucket({ capacity: 5, refillPerSecond: 10 }, clock);
    b.tryRemove(5);

    clock.advance(60_000); // an hour of refill at 10/s, against a bucket of 5
    assert.equal(b.available, 5, 'refill must clamp to capacity');
    clock.advance(60_000);
    assert.equal(b.available, 5, 'and stay clamped');
    assert.equal(b.tryRemove(5), true);
    assert.equal(b.available, 0);
  });

  await t.test('msUntil reports the wait for a token, and 0 once one is available', () => {
    const clock = clockAt(0);
    const b = bucket({ capacity: 10, refillPerSecond: 2 }, clock);
    b.tryRemove(10);

    assert.equal(b.msUntil(1), 500, 'at 2 tokens/s one token takes 500 ms');
    clock.advance(200);
    assert.equal(b.msUntil(1), 300, 'the wait shrinks with the time already served');
    clock.advance(100); // 300 ms served in total, so 0.6 tokens are banked
    assert.equal(b.msUntil(2), 700, '1.4 tokens short of two at 2/s is 700 ms, rounded up');
    clock.advance(400);
    assert.equal(b.msUntil(1), 0, 'an available token is a zero wait, not a negative one');
  });

  await t.test('msUntil is Infinity when the request can never be satisfied', () => {
    const clock = clockAt(0);
    const noRefill = bucket({ capacity: 5, refillPerSecond: 0 }, clock);
    // Spent first, deliberately: a FULL bucket answers msUntil(5) with 0, and that is correct. The
    // property under test is about a quota that is gone, so the case has to make the bucket empty
    // before it can mean anything. Measured: without this line the case asserted Infinity against a
    // bucket that had five tokens in it, and failed for the contract's own arithmetic.
    assert.equal(noRefill.tryRemove(5), true, 'spend the fixed quota');
    assert.equal(noRefill.msUntil(1), Infinity, 'a fixed quota that is spent is never refilled');
    assert.equal(noRefill.msUntil(5), Infinity);

    const small = bucket({ capacity: 5, refillPerSecond: 1 }, clock);
    assert.equal(small.msUntil(6), Infinity, 'more than capacity is unreachable, not merely slow');
  });

  await t.test('reset refills the bucket and restarts the interval', () => {
    const clock = clockAt(1_000);
    const b = bucket({ capacity: 4, refillPerSecond: 1 }, clock);
    b.tryRemove(4);
    clock.advance(2_500); // 2.5 tokens would have accrued
    b.reset();

    assert.equal(b.available, 4, 'reset returns the bucket to full');
    clock.advance(1_000);
    assert.equal(b.available, 4, 'and the elapsed time before the reset is not banked on top');
    b.tryRemove(4);
    assert.equal(b.available, 0);
    clock.advance(1_000);
    assert.equal(b.available, 1, 'refill resumes from the reset, not from an older origin');
  });

  await t.test('a clock that goes backwards mints nothing', () => {
    const clock = clockAt(10_000);
    const b = bucket({ capacity: 5, refillPerSecond: 1 }, clock);
    b.tryRemove(5);
    clock.advance(1_000);
    assert.ok(Math.abs(b.available - 1) < 1e-9);

    clock.advance(-5_000); // a non-monotonic clock, which a wall clock can be
    assert.ok(b.available <= 1 + 1e-9, 'negative elapsed time must not create tokens, got ' + b.available);
    assert.ok(b.available >= 0, 'and must not create debt, got ' + b.available);
  });

  await t.test('matches a reference model across randomised operations', () => {
    const model = (capacity, rate, now) => {
      let tokens = capacity;
      let last = now();
      return {
        capacity,
        available() {
          const at = now();
          tokens = Math.min(capacity, tokens + (Math.max(0, at - last) / 1000) * rate);
          last = at;
          return tokens;
        },
        tryRemove(count) {
          this.available();
          if (count > capacity || tokens + 1e-12 < count) return false;
          tokens -= count;
          return true;
        },
      };
    };

    const CAPACITY = 6;
    const RATE = 3;
    const clock = clockAt(123_456);
    const b = bucket({ capacity: CAPACITY, refillPerSecond: RATE }, clock);
    const m = model(CAPACITY, RATE, clock.now);

    let seed = 987654321;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };

    for (let i = 0; i < 500; i += 1) {
      const roll = next() % 10;
      if (roll < 5) {
        clock.advance(next() % 900);
      } else {
        const count = 1 + (next() % 3);
        assert.equal(
          b.tryRemove(count),
          m.tryRemove(count),
          'tryRemove(' + count + ') disagreed at step ' + i
        );
      }
      assert.ok(
        Math.abs(b.available - m.available()) < 1e-9,
        'available disagreed at step ' + i + ': ' + b.available + ' vs ' + m.available()
      );
      assert.ok(b.available >= 0, 'available must never be negative, at step ' + i);
      assert.ok(b.available <= CAPACITY + 1e-9, 'available must never exceed capacity, at step ' + i);
    }
  });
});
