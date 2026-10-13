const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PriorityQueue } = require('../../src/priority-queue.ts');

test('PriorityQueue strict specification contract', async (t) => {
  await t.test('enforces exact generic class signature and exports', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/priority-queue.ts'), 'utf8');
    assert.match(
      src,
      /export\s+class\s+PriorityQueue\s*<\s*T\s*>/,
      'Must export generic class PriorityQueue<T>'
    );
  });

  await t.test('defaults to min-heap behavior with natural numbers', () => {
    const pq = new PriorityQueue();
    pq.push(50);
    pq.push(10);
    pq.push(30);
    pq.push(5);

    assert.equal(pq.size, 4);
    assert.equal(pq.peek(), 5);
    assert.equal(pq.pop(), 5);
    assert.equal(pq.pop(), 10);
    assert.equal(pq.pop(), 30);
    assert.equal(pq.pop(), 50);
    assert.equal(pq.size, 0);
    assert.equal(pq.isEmpty(), true);
  });

  await t.test('supports custom comparator for complex objects', () => {
    // Max-heap on score: (a, b) => b.score - a.score
    const pq = new PriorityQueue((a, b) => b.score - a.score);
    pq.push({ id: 'task-1', score: 10 });
    pq.push({ id: 'task-2', score: 99 });
    pq.push({ id: 'task-3', score: 45 });

    assert.equal(pq.pop().id, 'task-2');
    assert.equal(pq.pop().id, 'task-3');
    assert.equal(pq.pop().id, 'task-1');
  });

  await t.test('handles empty boundary conditions cleanly', () => {
    const pq = new PriorityQueue();
    assert.equal(pq.peek(), undefined);
    assert.equal(pq.pop(), undefined);
    assert.equal(pq.size, 0);
    assert.equal(pq.isEmpty(), true);
  });

  await t.test('maintains heap invariant across randomized interleaved push/pop', () => {
    const pq = new PriorityQueue((a, b) => a - b);
    const expected = [];

    // Deterministic pseudo-random sequence
    let seed = 42;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % 1000;
    };

    for (let i = 0; i < 150; i++) {
      const val = nextRand();
      pq.push(val);
      expected.push(val);
    }
    expected.sort((a, b) => a - b);

    const actual = [];
    while (!pq.isEmpty()) {
      actual.push(pq.pop());
    }

    assert.deepEqual(actual, expected, 'Extracted elements must match sorted array');
  });

  await t.test('prevents internal array corruption via direct mutation', () => {
    const pq = new PriorityQueue();
    [3, 1, 2].forEach((v) => pq.push(v));

    // The earlier revision of this case called peek() and asserted size, and mutated NOTHING -- so it
    // named a guarantee it never exercised, and every corruptible implementation passed it. Measured:
    // an implementation exposing its heap as an own array property passes that version of this case
    // and is destroyed by a caller in one line (`pq.heap.length = 0`), size 3 -> 1, peek 1 -> 999.
    //
    // This version actually attacks the instance: it walks every property reachable from the object
    // and empties any array it finds, then asserts the queue still behaves. Asserting BEHAVIOUR rather
    // than the absence of an array property is deliberate -- a getter that returns a defensive copy is
    // harmless and must not be failed, while a leaked live store cannot survive this.
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

    const names = new Set(Object.getOwnPropertyNames(pq));
    let proto = Object.getPrototypeOf(pq);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        corrupt(pq[name]);
      } catch {
        /* ignore: the point is what survives, not what could be reached */
      }
    }

    assert.equal(pq.size, 3, 'size must survive an attempt to corrupt the backing store');
    assert.equal(pq.peek(), 1, 'peek must survive an attempt to corrupt the backing store');
    assert.equal(pq.isEmpty(), false, 'isEmpty must survive an attempt to corrupt the backing store');
    assert.deepEqual(
      [pq.pop(), pq.pop(), pq.pop()],
      [1, 2, 3],
      'extraction order must survive an attempt to corrupt the backing store'
    );
    assert.equal(pq.isEmpty(), true);
  });
});
