// The contract for LRUCache. Architect-authored: hashed before the unit runs and re-hashed after it, so
// the worker may not touch it and any change to it voids the verdict.
//
// WHAT DISCRIMINATES THIS SUITE. An LRU cache is a hash map plus a recency order, and the map half is
// trivially right. Everything that can be wrong lives in the ORDER: which entry is the eviction
// candidate, and which operations move an entry out of that position. An implementation that keeps a
// Map and relies on insertion order is correct until the first `get` of a key that is not already the
// most recent -- after which it evicts the entry a caller just read. That is the defect this contract
// is built to reach, and case 6 is the case that reaches it.
//
// TWO SEMANTICS ARE PINNED BECAUSE AN IMPLEMENTATION COULD REASONABLY GO EITHER WAY, and an unpinned
// choice would make the model in case 10 non-deterministic rather than wrong:
//
//   - `get` and `set` PROMOTE an entry; `set` on an existing key promotes it as well as updating it.
//   - `has` does NOT promote. It is a membership test, not an access, and a caller asking whether a key
//     is present should not silently reorder the cache underneath itself.
//
// ONE MECHANISM REQUIREMENT THE CASES CANNOT CHECK, stated here rather than implied: `get`, `set` and
// `delete` must be O(1). An array scan over the entries satisfies every assertion below while being
// O(n), because complexity is not observable through the public API. That requirement is carried by the
// worker prompt and by the negative fixture's sibling, not by this file. A reviewer looking for the
// check should know it is deliberately absent rather than overlooked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LRUCache } = require(path.join(__dirname, '..', '..', 'tools', 'lru-cache.ts'));

/** The recency semantics this contract pins, as a model to compare against. LRU first. */
function modelCache(capacity) {
  const map = new Map();
  const order = [];
  const promote = (key) => {
    const at = order.indexOf(key);
    if (at !== -1) order.splice(at, 1);
    order.push(key);
  };
  return {
    size: () => map.size,
    has: (key) => map.has(key),
    get(key) {
      if (!map.has(key)) return undefined;
      promote(key);
      return map.get(key);
    },
    set(key, value) {
      if (map.has(key)) {
        map.set(key, value);
        promote(key);
        return;
      }
      map.set(key, value);
      order.push(key);
      if (order.length > capacity) map.delete(order.shift());
    },
    delete(key) {
      if (!map.has(key)) return false;
      map.delete(key);
      order.splice(order.indexOf(key), 1);
      return true;
    },
    keys: () => [...order],
  };
}

test('LRUCache strict specification contract', async (t) => {
  await t.test('enforces exact generic class signature and exports', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/lru-cache.ts'), 'utf8');
    assert.match(src, /export\s+class\s+LRUCache\s*<\s*K\s*,\s*V\s*>/, 'Must export generic class LRUCache<K, V>');
  });

  await t.test('rejects a capacity that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => new LRUCache(bad), RangeError, 'capacity ' + String(bad) + ' must throw RangeError');
    }
    assert.doesNotThrow(() => new LRUCache(1), 'a capacity of 1 is legal');
  });

  await t.test('reports the empty boundary without throwing', () => {
    const cache = new LRUCache(2);
    assert.equal(cache.size, 0);
    assert.equal(cache.capacity, 2);
    assert.equal(cache.get('missing'), undefined);
    assert.equal(cache.has('missing'), false);
    assert.equal(cache.delete('missing'), false, 'deleting an absent key reports false');
    assert.equal(cache.size, 0);
  });

  await t.test('stores and retrieves, and set on an existing key updates in place', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.size, 2);

    cache.set('a', 99);
    assert.equal(cache.get('a'), 99, 'set on an existing key replaces the value');
    assert.equal(cache.size, 2, 'and must not grow the cache');
  });

  await t.test('evicts the least recently used entry on overflow', () => {
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a': never accessed since insertion

    assert.equal(cache.size, 2);
    assert.equal(cache.has('a'), false, 'the oldest entry is the eviction candidate');
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
  });

  await t.test('PROMOTES on get: a read entry is no longer the eviction candidate', () => {
    // The case a map-plus-insertion-order implementation cannot pass. Once 'a' has been read it is the
    // most recently used entry, so 'b' -- not 'a' -- is what an overflow must drop.
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);

    assert.equal(cache.get('a'), 1, 'reading a promotes it');
    cache.set('c', 3);

    assert.equal(cache.has('a'), true, "'a' was just read and must survive the eviction");
    assert.equal(cache.has('b'), false, "'b' is now the least recently used entry");
    assert.equal(cache.size, 2);
  });

  await t.test('PROMOTES on set of an existing key', () => {
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.set('a', 11); // updates AND promotes
    cache.set('c', 3);

    assert.equal(cache.has('a'), true, 'an updated entry must survive the eviction');
    assert.equal(cache.get('a'), 11);
    assert.equal(cache.has('b'), false, "'b' is now the least recently used entry");
  });

  await t.test('has() is a membership test and does NOT promote', () => {
    // Pinned, not incidental: with the opposite choice case 10's model would be ambiguous rather than
    // able to fail, and a caller asking "is this present?" would be reordering the cache silently.
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);

    assert.equal(cache.has('a'), true);
    cache.set('c', 3);

    assert.equal(cache.has('a'), false, 'a membership test must not have promoted "a"');
    assert.equal(cache.has('b'), true);
    assert.equal(cache.get('b'), 2);
    assert.equal(cache.get('c'), 3);
  });

  await t.test('delete removes an entry and reports whether it was there; clear empties', () => {
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);

    assert.equal(cache.delete('a'), true);
    assert.equal(cache.delete('a'), false, 'a second delete reports false');
    assert.equal(cache.size, 1);
    assert.equal(cache.has('a'), false);
    assert.equal(cache.has('b'), true, 'deleting one key must not disturb the other');

    cache.set('c', 3); // room was freed, so nothing is evicted
    assert.equal(cache.size, 2);
    assert.equal(cache.has('b'), true);
    assert.equal(cache.has('c'), true);

    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.get('c'), undefined);
    cache.set('d', 4); // and it is reusable
    assert.equal(cache.get('d'), 4);
  });

  await t.test('matches a recency model across randomised operations', () => {
    const CAPACITY = 3;
    const cache = new LRUCache(CAPACITY);
    const model = modelCache(CAPACITY);

    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const KEYS = ['k0', 'k1', 'k2', 'k3', 'k4'];

    for (let i = 0; i < 600; i += 1) {
      const key = KEYS[next() % KEYS.length];
      const roll = next() % 10;

      if (roll < 4) {
        const value = next();
        cache.set(key, value);
        model.set(key, value);
      } else if (roll < 7) {
        assert.equal(cache.get(key), model.get(key), 'get mismatch at step ' + i + ' for ' + key);
      } else if (roll < 9) {
        assert.equal(cache.has(key), model.has(key), 'has mismatch at step ' + i + ' for ' + key);
      } else {
        assert.equal(cache.delete(key), model.delete(key), 'delete mismatch at step ' + i + ' for ' + key);
      }

      assert.equal(cache.size, model.size(), 'size mismatch at step ' + i);
      assert.ok(cache.size <= CAPACITY, 'size must never exceed capacity, at step ' + i);
    }
  });

  await t.test('does not expose a corruptible backing store', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Deliberately NO get() before the overflow below. get promotes, and promotion has its own case;
    // depending on it here would make this case fail for a reason that is not encapsulation. Measured:
    // the first version of this case called get('a') and consequently failed against a fixture whose
    // only defect was the missing promotion -- evidence about the wrong property.

    // Walk everything reachable from the instance and destroy any container found: an Array is emptied,
    // a Map or Set is cleared, and plain objects are descended into so a node graph is reached too. A
    // #private field is not an own property and cannot be reached at all, which is the design this case
    // requires. `seen` and the depth bound keep the walk finite over a linked list that points at
    // itself, which is exactly the shape a doubly-linked implementation has.
    const seen = new Set();
    const corrupt = (value, depth) => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.length = 0;
        value.push('CORRUPT');
        return;
      }
      if (value instanceof Map || value instanceof Set) {
        value.clear();
        return;
      }
      if (depth <= 0) return;
      for (const key of Object.getOwnPropertyNames(value)) {
        try {
          corrupt(value[key], depth - 1);
        } catch {
          /* an accessor that refuses to be read leaves nothing to corrupt */
        }
      }
    };

    const names = new Set(Object.getOwnPropertyNames(cache));
    let proto = Object.getPrototypeOf(cache);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        corrupt(cache[name], 4);
      } catch {
        /* ignore: the point is what survives, not what could be reached */
      }
    }

    assert.equal(cache.size, 3, 'size must survive an attempt to corrupt the backing store');
    assert.equal(cache.capacity, 3, 'capacity must survive');
    assert.equal(cache.has('a'), true, "'a' must survive");
    assert.equal(cache.has('b'), true, "'b' must survive");
    assert.equal(cache.has('c'), true, "'c' must survive");

    // ORDER must survive as well, not just membership. No get() has run, so 'a' is the least recently
    // used entry under EVERY semantics this contract allows, and an overflow must drop it. A store the
    // walk had destroyed would drop something else, or nothing.
    cache.set('d', 4);
    assert.equal(cache.has('a'), false, 'the oldest entry must still be the one evicted');
    assert.equal(cache.has('b'), true, "'b' must survive");
    assert.equal(cache.has('c'), true, "'c' must survive");
    assert.equal(cache.size, 3);
    assert.equal(cache.get('b'), 2, 'stored values must survive');
    assert.equal(cache.get('d'), 4);
  });
});
