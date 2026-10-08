'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('../src/ttl-cache.js');

function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function makeCache({ maxEntries = 3, ttlMs = 1000 } = {}) {
  const clock = makeClock();
  return { cache: createTtlCache({ maxEntries, ttlMs, now: clock.now }), clock };
}

test('construction rejects an invalid maxEntries', () => {
  const bad = [0, -1, 1.5, '3', null, undefined, NaN, Infinity];
  for (const v of bad) {
    assert.throws(() => createTtlCache({ maxEntries: v, ttlMs: 1000, now: () => 0 }), TypeError, `maxEntries ${String(v)} should throw`);
  }
});

test('construction rejects an invalid ttlMs', () => {
  const bad = [0, -1, '1000', null, undefined, NaN, Infinity, -Infinity];
  for (const v of bad) {
    assert.throws(() => createTtlCache({ maxEntries: 3, ttlMs: v, now: () => 0 }), TypeError, `ttlMs ${String(v)} should throw`);
  }
});

test('construction rejects an invalid now', () => {
  const bad = [123, 'now', null, undefined, 42];
  for (const v of bad) {
    assert.throws(() => createTtlCache({ maxEntries: 3, ttlMs: 1000, now: v }), TypeError, `now ${String(v)} should throw`);
  }
});

test('set then get returns the value; an absent key returns undefined and counts one miss', () => {
  const { cache } = makeCache();
  cache.set('k', 'v');
  assert.equal(cache.get('k'), 'v');
  assert.equal(cache.get('missing'), undefined);
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

test('get of an expired key returns undefined, counts one miss and one expiration, and removes the entry', () => {
  const { cache, clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  cache.set('k', 'v');
  clock.advance(100); // now >= expiry
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
  const s = cache.stats();
  assert.equal(s.misses, 1);
  assert.equal(s.expirations, 1);
  assert.equal(s.hits, 0);
});

test('has() has no side effects: no counter change, no recency change, no removal of an expired entry', () => {
  const { cache, clock } = makeCache({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  const before = cache.stats();
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), true);
  const after = cache.stats();
  assert.deepEqual(after, before, 'has must not change counters');
  // Recency: 'a' is LRU, 'b' is MRU. If has changed recency, eviction would differ.
  cache.set('c', 3); // live {a,b,c} = 3 > 2 -> evict LRU 'a'
  assert.equal(cache.has('a'), false, 'a (LRU) should be evicted');
  assert.equal(cache.has('b'), true, 'b should survive');
  // has must not remove an expired entry
  const { cache: c2, clock: c2clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  c2.set('x', 1);
  c2clock.advance(100);
  assert.equal(c2.has('x'), false, 'has must report liveness, not presence');
  assert.equal(c2.delete('x'), true, 'the expired entry must still be physically present');
});

test('size counts live entries only and has no side effects', () => {
  const { cache, clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);
  const before = cache.stats();
  clock.advance(100); // both expired
  assert.equal(cache.size, 0, 'size must count live entries only');
  const after = cache.stats();
  assert.deepEqual(after, before, 'size must not change counters');
  assert.equal(cache.delete('a'), true, 'expired entry must still be present');
  assert.equal(cache.delete('b'), true, 'expired entry must still be present');
});

test('LRU eviction evicts the least recently used entry; a successful get refreshes recency', () => {
  const { cache } = makeCache({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'a' is MRU, 'b' is LRU
  cache.set('c', 3); // live {a,b,c} = 3 > 2 -> evict 'b'
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false, 'b (LRU) should be evicted');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.stats().evictions, 1);
});

test('eviction chooses strictly by recency, not by expiry', () => {
  const { cache, clock } = makeCache({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  clock.advance(50);
  cache.set('b', 2);
  clock.advance(40); // t=90
  cache.get('a'); // 'a' is MRU again, 'b' is LRU
  clock.advance(20); // t=110
  assert.equal(cache.size, 1); // 'a' expired (expiry 100); 'b' live (expiry 150)
  cache.set('c', 3); // live {b, c} = 2, at the bound -> no eviction
  assert.equal(cache.stats().evictions, 0);
  cache.set('d', 4); // live {b, c, d} = 3 > 2 -> evict the LRU, which is 'b' and is LIVE
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.has('b'), false, 'b was the victim');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);
  assert.equal(cache.delete('a'), true, 'the EXPIRED entry was not the victim; it is still present');
});

test('replacing an existing key refreshes expiry and recency, is not counted as an eviction, and does not change size', () => {
  const { cache, clock } = makeCache({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  clock.advance(50);
  cache.set('a', 99); // replace: 'a' expiry becomes 150, 'a' becomes MRU, 'b' is now LRU
  assert.equal(cache.stats().evictions, 0);
  assert.equal(cache.size, 2);
  cache.set('c', 3); // live {a, b, c} = 3 > 2 -> evict the LRU, which must be 'b'
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.get('a'), 99);
  assert.equal(cache.get('c'), 3);
  clock.advance(90); // t=140
  assert.equal(cache.has('a'), true, 'the replace refreshed expiry to 150');
  clock.advance(10); // t=150
  assert.equal(cache.has('a'), false, 'now >= 150');
});

test('delete removes live and expired entries, returns true/false, and changes no counter', () => {
  const { cache, clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  const before = cache.stats();
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('missing'), false);
  const after = cache.stats();
  assert.deepEqual(after, before, 'delete must not change counters');
  clock.advance(100);
  assert.equal(cache.delete('b'), true, 'delete must remove an expired entry');
  assert.equal(cache.delete('b'), false, 'second delete of the same key returns false');
});

test('clear removes everything without resetting counters', () => {
  const { cache, clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  clock.advance(100);
  cache.get('b'); // expired -> miss + expiration
  const before = cache.stats();
  cache.clear();
  assert.equal(cache.size, 0);
  const after = cache.stats();
  assert.deepEqual(after, before, 'clear must not reset counters');
});

test('purge removes only expired entries, increments expirations by the number removed, returns that number, and leaves recency of survivors unchanged', () => {
  const { cache, clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  clock.advance(100); // both expired
  const removed = cache.purge();
  assert.equal(removed, 2);
  assert.equal(cache.stats().expirations, 2);
  assert.equal(cache.size, 0);

  // Recency of survivors unchanged
  const { cache: c2, clock: c2clock } = makeCache({ maxEntries: 3, ttlMs: 100 });
  c2.set('x', 1);
  c2clock.advance(50);              // t=50
  c2.set('y', 2);
  c2.set('z', 3);              // x, y and z are all live
  assert.equal(c2.size, 3);

  c2clock.advance(60);              // t=110: x expired (expiry 100); y and z live (expiry 150)
  assert.equal(c2.size, 2, 'size counts live entries only');

  const removed2 = c2.purge();
  assert.equal(removed2, 1, 'purge removes exactly the expired entries');
  assert.equal(c2.stats().expirations, 1);
  assert.equal(c2.has('x'), false, 'x was expired and has been removed');
  assert.equal(c2.has('y'), true, 'y is live and must survive the purge');
  assert.equal(c2.has('z'), true, 'z is live and must survive the purge');
  assert.equal(c2.size, 2);

  // The recency of the survivors must be unchanged: y is LRU, z is MRU.
  // If purge disturbed recency, the eviction below would choose the wrong victim.
  c2.set('w', 4);              // live {y, z, w} = 3, at the bound
  assert.equal(c2.stats().evictions, 0, 'no eviction while the live count is within the bound');
  c2.set('v', 5);              // live {y, z, w, v} = 4 > 3 -> evict the LRU, which is y
  assert.equal(c2.stats().evictions, 1);
  assert.equal(c2.has('y'), false, 'y (LRU) should have been evicted');
  assert.equal(c2.has('z'), true, 'z should survive');
  assert.equal(c2.has('w'), true);
  assert.equal(c2.has('v'), true);
});

test('stats() returns a fresh copy: mutating the returned object must not affect the cache', () => {
  const { cache } = makeCache();
  cache.set('a', 1);
  cache.get('a');
  const s = cache.stats();
  s.hits = 999;
  s.misses = 999;
  s.evictions = 999;
  s.expirations = 999;
  const s2 = cache.stats();
  assert.equal(s2.hits, 1);
  assert.equal(s2.misses, 0);
  assert.equal(s2.evictions, 0);
  assert.equal(s2.expirations, 0);
});
