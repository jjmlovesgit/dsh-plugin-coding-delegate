/**
 * @sdlc.tier1
 * @target tools/exponential-backoff.ts
 * @requirements
 * Export exactly one class, ExponentialBackoff, and nothing else.
 * Zero imports: no Node built-ins, no external packages, no type imports.
 * Constructor: new ExponentialBackoff({ baseDelayMs, maxDelayMs, factor, jitter }).
 * - baseDelayMs must be a positive finite number, else throw RangeError.
 * - maxDelayMs must be a positive finite number and must be >= baseDelayMs, else throw RangeError.
 * - factor defaults to 2 and must be a finite number >= 1, else throw RangeError.
 * - jitter defaults to 'none' and must be exactly 'none' or 'full', else throw RangeError.
 * computeDelay(attempt, rngSeed?): number
 * - attempt must be a non-negative integer, else throw RangeError.
 * - rngSeed, when provided, must be a finite number in [0, 1], else throw RangeError.
 * - raw delay = Math.min(maxDelayMs, baseDelayMs * factor ** attempt). It must stay finite for ANY
 *   attempt, including one large enough that factor ** attempt overflows to Infinity.
 * - jitter 'none': return Math.round(raw delay).
 * - jitter 'full': return Math.round(raw delay * seed), where seed is rngSeed when provided and
 *   exactly 0.5 when it is not.
 * - The result is never negative, never NaN, and never exceeds maxDelayMs.
 * reset(): void -- callable at any time, any number of times; a stateless implementation may do nothing.
 * State lives in #private fields.
 *
 * THE CONTRACT FOR ExponentialBackoff. Architect-authored: hashed before the unit runs and re-hashed
 * after it, so the worker may not touch it and any change to it voids the verdict.
 *
 * WHAT DISCRIMINATES THIS SUITE. The arithmetic is one line; every real defect lives in the
 * EXPONENT'S ORIGIN. An implementation that raises the factor to `attempt + 1` is correct in shape,
 * correct under clamping and correct for large attempts -- and every delay it returns is off by a
 * factor, which for a retry schedule means the first pause is already twice what the operator
 * configured. Case 4 is the case that reaches it, and
 * tests/contracts/fixtures/exponential-backoff.negative.ts is that implementation.
 *
 * TWO SEMANTICS ARE PINNED BECAUSE AN IMPLEMENTATION COULD REASONABLY GO EITHER WAY, and an unpinned
 * choice would make the randomised model ambiguous rather than able to fail:
 *   - `computeDelay` is PURE: calling it does not consume a seed, advance a counter, or change what
 *     the next call returns. `reset()` exists for implementations that keep such state, and this
 *     contract only requires that it is callable.
 *   - the no-seed jitter fallback is exactly 0.5, not "some deterministic value". A contract cannot
 *     assert against "some" value, and a retry delay nobody can predict is not testable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ExponentialBackoff } = require(path.join(__dirname, '..', '..', 'tools', 'exponential-backoff.ts'));

/**
 * Build a backoff and assert its surface before anything calls it. Against the null implementation
 * this fails at the first ASSERTION, which keeps a null run from reporting a TypeError as the
 * contract malfunctioning on its own account.
 */
function backoff(options) {
  const instance = new ExponentialBackoff(options);
  assert.equal(typeof instance.computeDelay, 'function', 'ExponentialBackoff must expose computeDelay(attempt, rngSeed?)');
  assert.equal(typeof instance.reset, 'function', 'ExponentialBackoff must expose reset()');
  return instance;
}

test('ExponentialBackoff strict specification contract', async (t) => {
  await t.test('is self-contained and exports exactly one class', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/exponential-backoff.ts'), 'utf8');
    assert.match(src, /export\s+class\s+ExponentialBackoff/, 'Must export class ExponentialBackoff');
    assert.doesNotMatch(src, /^\s*import\s/m, 'the module must be self-contained: no imports');
  });

  await t.test('rejects options that cannot describe a backoff', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.throws(() => new ExponentialBackoff({ baseDelayMs: bad, maxDelayMs: 1000 }), RangeError, 'baseDelayMs ' + String(bad));
      assert.throws(() => new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: bad }), RangeError, 'maxDelayMs ' + String(bad));
    }
    assert.throws(() => new ExponentialBackoff({ baseDelayMs: 500, maxDelayMs: 100 }), RangeError, 'maxDelayMs below baseDelayMs');
    for (const bad of [0, 0.5, NaN, Infinity]) {
      assert.throws(() => new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: 1000, factor: bad }), RangeError, 'factor ' + String(bad));
    }
    assert.throws(
      () => new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 'partial' }),
      RangeError,
      'an unknown jitter mode'
    );
  });

  await t.test('zero-indexed growth, clamped at maxDelayMs', () => {
    const b = backoff({ baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'none' });
    assert.equal(b.computeDelay(0), 100, 'attempt 0 is exactly baseDelayMs');
    assert.equal(b.computeDelay(1), 200);
    assert.equal(b.computeDelay(2), 400);
    assert.equal(b.computeDelay(3), 800);
    assert.equal(b.computeDelay(4), 1000, 'the clamp applies as soon as the growth passes the ceiling');
    assert.equal(b.computeDelay(10), 1000);
  });

  await t.test('a custom growth factor is honoured, and factor 1 is flat', () => {
    const cubic = backoff({ baseDelayMs: 50, maxDelayMs: 500, factor: 3, jitter: 'none' });
    assert.equal(cubic.computeDelay(0), 50);
    assert.equal(cubic.computeDelay(1), 150);
    assert.equal(cubic.computeDelay(2), 450);
    assert.equal(cubic.computeDelay(3), 500);

    const flat = backoff({ baseDelayMs: 75, maxDelayMs: 500, factor: 1, jitter: 'none' });
    assert.equal(flat.computeDelay(0), 75);
    assert.equal(flat.computeDelay(9), 75, 'factor 1 never grows');
  });

  await t.test('defaults: factor 2, jitter none', () => {
    const b = backoff({ baseDelayMs: 10, maxDelayMs: 1000 });
    assert.equal(b.computeDelay(0), 10);
    assert.equal(b.computeDelay(2), 40);
  });

  await t.test('full jitter multiplies the clamped delay by the supplied seed', () => {
    const b = backoff({ baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'full' });
    assert.equal(b.computeDelay(2, 0.5), 200, '400 * 0.5');
    assert.equal(b.computeDelay(2, 0), 0, 'a zero seed is a legal zero wait');
    assert.equal(b.computeDelay(2, 1), 400, 'a seed of 1 is the full delay');
    // Rounding is applied to the product, not before it.
    assert.equal(b.computeDelay(0, 0.333), 33, '100 * 0.333 = 33.3 rounds to 33');
  });

  await t.test('full jitter without a seed uses exactly 0.5', () => {
    const b = backoff({ baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 'full' });
    assert.equal(b.computeDelay(1), 100, 'the documented fallback is 200 * 0.5');
  });

  await t.test('rejects attempts and seeds that are not usable', () => {
    const b = backoff({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' });
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => b.computeDelay(bad), RangeError, 'attempt ' + String(bad));
    }
    const jittered = backoff({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 'full' });
    for (const bad of [-0.1, 1.1, NaN, Infinity]) {
      assert.throws(() => jittered.computeDelay(0, bad), RangeError, 'rngSeed ' + String(bad));
    }
  });

  await t.test('extreme attempts clamp instead of overflowing', () => {
    const b = backoff({ baseDelayMs: 1000, maxDelayMs: 60000, factor: 2, jitter: 'none' });
    const huge = b.computeDelay(1024);
    assert.equal(huge, 60000, '2 ** 1024 is Infinity, and the clamp must absorb it');
    assert.ok(Number.isFinite(huge), 'the result must be finite, not Infinity');
    assert.ok(!Number.isNaN(huge), 'the result must not be NaN');
  });

  await t.test('computeDelay is pure and reset is callable at any time', () => {
    const b = backoff({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' });
    const first = b.computeDelay(3);
    assert.equal(b.computeDelay(3), first, 'a repeated call returns the same value');
    assert.equal(b.computeDelay(1), 200, 'and a lower attempt is unaffected by the higher one');
    assert.doesNotThrow(() => b.reset());
    assert.equal(b.computeDelay(3), first, 'reset does not change a pure calculation');
    assert.doesNotThrow(() => b.reset(), 'reset is idempotent');
  });

  await t.test('matches a reference formula across randomised configurations', () => {
    const reference = (baseDelayMs, maxDelayMs, factor, jitter, attempt, seed) => {
      const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt));
      return Math.round(jitter === 'full' ? raw * seed : raw);
    };

    let state = 987654321;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state;
    };

    for (let i = 0; i < 200; i += 1) {
      const baseDelayMs = 1 + (next() % 500);
      const maxDelayMs = baseDelayMs + (next() % 60000);
      const factor = 1 + (next() % 300) / 100;
      const jitter = next() % 2 === 0 ? 'none' : 'full';
      const attempt = next() % 40;
      const seed = (next() % 1001) / 1000;

      const b = backoff({ baseDelayMs, maxDelayMs, factor, jitter });
      const actual = b.computeDelay(attempt, seed);
      assert.equal(
        actual,
        reference(baseDelayMs, maxDelayMs, factor, jitter, attempt, seed),
        'disagreed for base ' + baseDelayMs + ' max ' + maxDelayMs + ' factor ' + factor +
          ' jitter ' + jitter + ' attempt ' + attempt + ' seed ' + seed
      );
      assert.ok(actual >= 0 && actual <= maxDelayMs, 'result outside [0, maxDelayMs] at iteration ' + i);
    }
  });
});
