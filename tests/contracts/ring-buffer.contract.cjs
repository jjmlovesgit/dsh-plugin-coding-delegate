// The contract for RingBuffer. Architect-authored: hashed before the unit runs and re-hashed after it,
// so the worker may not touch it and any change to it voids the verdict.
//
// WHAT THIS SUITE IS FOR. A ring buffer's whole reason to exist is the wrap: the backing store is
// reused, so the write position is not the array length and the OLDEST element is not at index 0. An
// implementation that ignores the bound -- a plain array with push/shift -- is FIFO-correct for the
// first `capacity` writes and wrong from the next one on. That is the failure this contract is built to
// reach, and every case below either crosses the wrap or crosses the bound.
//
// Cases are named for the property they exercise. Two earlier suites in this repository shipped cases
// whose names promised more than their bodies did, and one of them passed on an implementation it was
// written to reject; the discrimination gate (scripts/check-contract-fixtures.cjs) now exists to make
// that failure mode fail the build instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RingBuffer } = require(path.join(__dirname, '..', '..', 'tools', 'ring-buffer.ts'));

test('RingBuffer strict specification contract', async (t) => {
  await t.test('enforces exact generic class signature and exports', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/ring-buffer.ts'), 'utf8');
    assert.match(src, /export\s+class\s+RingBuffer\s*<\s*T\s*>/, 'Must export generic class RingBuffer<T>');
  });

  await t.test('rejects a capacity that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () => new RingBuffer(bad),
        RangeError,
        'capacity ' + String(bad) + ' must throw RangeError'
      );
    }
    assert.doesNotThrow(() => new RingBuffer(1), 'a capacity of 1 is legal');
  });

  await t.test('reports the empty boundary without throwing', () => {
    const rb = new RingBuffer(3);
    assert.equal(rb.size, 0);
    assert.equal(rb.capacity, 3);
    assert.equal(rb.isEmpty(), true);
    assert.equal(rb.isFull(), false);
    assert.equal(rb.peek(), undefined);
    assert.equal(rb.pop(), undefined);
    assert.equal(rb.size, 0, 'a pop on empty must not change the size');
  });

  await t.test('is FIFO within capacity, and peek does not consume', () => {
    const rb = new RingBuffer(3);
    assert.equal(rb.push('a'), true);
    assert.equal(rb.push('b'), true);
    assert.equal(rb.push('c'), true);
    assert.equal(rb.size, 3);
    assert.equal(rb.isFull(), true);
    assert.equal(rb.peek(), 'a');
    assert.equal(rb.peek(), 'a', 'peek is idempotent');
    assert.equal(rb.size, 3, 'peek must not consume');
    assert.deepEqual([rb.pop(), rb.pop(), rb.pop()], ['a', 'b', 'c']);
    assert.equal(rb.isEmpty(), true);
    assert.equal(rb.isFull(), false);
  });

  await t.test('refuses a push into a full buffer and changes nothing', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);

    assert.equal(rb.push(4), false, 'a full buffer must refuse the write');
    assert.equal(rb.size, 3, 'a refused push must not grow the buffer');
    assert.equal(rb.isFull(), true);
    assert.deepEqual(
      [rb.pop(), rb.pop(), rb.pop()],
      [1, 2, 3],
      'a refused push must not overwrite or reorder what is already stored'
    );
  });

  await t.test('recovers the freed slot after a pop and preserves FIFO across it', () => {
    // MEASURED LIMIT, recorded because the first version of this case claimed more than it delivered.
    // It was named "wraps around the backing store", and the discrimination pre-flight showed that an
    // UNBOUNDED array -- one that never wraps, and grows past its capacity -- PASSES it: a shift-then-
    // push is observationally identical to a ring reuse for as long as the bound is respected. So this
    // case does not test ring reuse; nothing at the public API can, since a correct array-backed queue
    // and a correct ring are equivalent to every caller.
    //
    // What it does test is RECOVERY: an implementation that latches full and never accepts again, or
    // that leaves stale indices behind, fails here. The BOUND is what cases 5 and 7 discriminate, and
    // that is where a non-wrapping implementation is actually caught.
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);

    assert.equal(rb.pop(), 1, 'the oldest element leaves first');
    assert.equal(rb.push(4), true, 'the freed slot must accept the next write');
    assert.equal(rb.size, 3);
    assert.equal(rb.peek(), 2, 'the oldest is now the second element written, not the newest');

    assert.deepEqual([rb.pop(), rb.pop(), rb.pop()], [2, 3, 4], 'order must survive the wrap');
    assert.equal(rb.pop(), undefined);

    // And the buffer is reusable once drained, which a broken head/tail would not be.
    rb.push(9);
    assert.equal(rb.peek(), 9);
    assert.equal(rb.pop(), 9);
  });

  await t.test('stays FIFO and bounded across many cycles against a model', () => {
    const CAPACITY = 3;
    const rb = new RingBuffer(CAPACITY);
    const model = [];

    for (let i = 0; i < 200; i += 1) {
      if (i % 3 === 2 && model.length > 0) {
        assert.equal(rb.pop(), model.shift(), 'pop must return the oldest, at step ' + i);
      } else {
        const shouldAccept = model.length < CAPACITY;
        assert.equal(rb.push(i), shouldAccept, 'push acceptance, at step ' + i);
        if (shouldAccept) model.push(i);
      }
      assert.equal(rb.size, model.length, 'size must track the model at step ' + i);
    }

    const drained = [];
    while (!rb.isEmpty()) drained.push(rb.pop());
    assert.deepEqual(drained, model, 'the remainder must drain oldest-first');
    assert.equal(rb.size, 0);
  });

  await t.test('does not expose a corruptible backing store', () => {
    const rb = new RingBuffer(4);
    [3, 1, 4, 2].forEach((v) => rb.push(v));
    assert.equal(rb.pop(), 3);
    rb.push(5);

    // Walk everything reachable from the instance and empty any array found. An implementation that
    // keeps its store in an enumerable own property hands the caller the live array and fails here; one
    // that keeps it in a #private field is untouched, because a private field is not an own property.
    // Asserting BEHAVIOUR rather than the absence of an array property means a getter returning a
    // defensive copy is not failed, while a leaked live store cannot survive.
    const corrupt = (value) => {
      if (Array.isArray(value)) {
        value.length = 0;
        value.push(999);
        return;
      }
      if (value && typeof value === 'object') {
        for (const key of Object.getOwnPropertyNames(value)) {
          try {
            corrupt(value[key]);
          } catch {
            /* an accessor that refuses to be read leaves nothing to corrupt */
          }
        }
      }
    };

    const names = new Set(Object.getOwnPropertyNames(rb));
    let proto = Object.getPrototypeOf(rb);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        corrupt(rb[name]);
      } catch {
        /* ignore: the point is what survives, not what could be reached */
      }
    }

    assert.equal(rb.size, 4, 'size must survive an attempt to corrupt the backing store');
    assert.equal(rb.peek(), 1, 'peek must survive an attempt to corrupt the backing store');
    assert.equal(rb.capacity, 4, 'capacity must survive an attempt to corrupt the backing store');
    assert.deepEqual(
      [rb.pop(), rb.pop(), rb.pop(), rb.pop()],
      [1, 4, 2, 5],
      'FIFO order must survive an attempt to corrupt the backing store'
    );
    assert.equal(rb.isEmpty(), true);
  });
});
