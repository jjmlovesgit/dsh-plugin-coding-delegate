'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('../src/ttl-cache.js');

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

function makeCache({ maxEntries = 3, ttlMs = 1000, start = 0 } = {}) {
  const clock = makeClock(start);
  const cache = createTtlCache({ maxEntries, ttlMs, now: clock.now });
  return { cache, clock };
}

test('construction rejects invalid maxEntries', () => {
  const clock = makeClock();
  for (const bad of [0, -1, 1.5, '3', null, undefined, NaN, Infinity]) {
    assert.throws(
      () => createTtlCache({ maxEntries: bad, ttlMs: 1000, now: clock.now }),
      TypeError,
      `maxEntries=${String(bad)} should throw TypeError`,
    );
  }
});

test('construction rejects invalid ttlMs', () => {
  const clock = makeClock();
  for (const bad of [0, -1, '1000', null, undefined, NaN, Infinity, -Infinity]) {
    assert.throws(
      () => createTtlCache({ maxEntries: 3, ttlMs: bad, now: clock.now }),
      TypeError,
      `ttlMs=${String(bad)} should throw TypeError`,
    );
  }
});

test('construction rejects invalid now', () => {
  for (const bad of [123, 'now', null, undefined, 42]) {
    assert.throws(
      () => createTtlCache({ maxEntries: 3, ttlMs: 1000, now: bad }),
      TypeError,
      `now=${String(bad)} should throw TypeError`,
    );
  }
});

test('set then get returns value; absent key returns undefined and counts a miss', () => {
  const { cache } = makeCache();
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('missing'), undefined);
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

test('get of expired key returns undefined, counts miss and expiration, removes entry', () => {
  const { cache, clock } = makeCache({ ttlMs: 100 });
  cache.set('a', 1);
  clock.advance(100); // now >= expiry
  assert.equal(cache.get('a'), undefined);
  const s = cache.stats();
  assert.equal(s.misses, 1);
  assert.equal(s.expirations, 1);
  assert.equal(cache.size, 0);
});

test('has() has no side effects', () => {
  const { cache, clock } = makeCache({ ttlMs: 100, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  const before = cache.stats();
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('missing'), false);
  const after = cache.stats();
  assert.deepEqual(after, before, 'has must not change counters');
  // has must not change recency: 'a' was set first, so it is LRU.
  // If has('a') refreshed recency, 'b' would be LRU and evicted next.
  cache.set('c', 3); // should evict 'a' (LRU), not 'b'
  assert.equal(cache.has('a'), false, 'a should have been evicted');
  assert.equal(cache.has('b'), true, 'b should still be present');
  // has must not remove an expired entry
  clock.advance(100);
  assert.equal(cache.has('b'), false, 'b is expired, has returns false');
  assert.equal(cache.size, 0, 'size excludes expired');
  // entry still physically present (not removed by has)
  assert.equal(cache.stats().expirations, 0, 'has must not increment expirations');
});

test('size excludes expired entries and has no side effects', () => {
  const { cache, clock } = makeCache({ ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);
  const before = cache.stats();
  clock.advance(100);
  assert.equal(cache.size, 0, 'size should be 0 when all expired');
  const after = cache.stats();
  assert.deepEqual(after, before, 'size must not change counters');
  assert.equal(after.expirations, 0, 'size must not increment expirations');
});

test('LRU eviction evicts least recently used; get refreshes recency', () => {
  const { cache } = makeCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // refresh 'a' recency; 'b' is now LRU
  cache.set('c', 3); // should evict 'b'
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false, 'b should be evicted');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.stats().evictions, 1);
});

test('eviction chooses strictly by recency, not by expiry', () => {
  const { cache, clock } = makeCache({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  // 'a' is LRU, 'b' is MRU. Expire 'b' (MRU).
  clock.advance(100);
  // Now 'b' is expired, 'a' is also expired (same ttl). But recency: 'a' < 'b'.
  // Eviction must pick 'a' (LRU), not 'b' (expired MRU).
  cache.set('c', 3);
  assert.equal(cache.has('a'), false, 'a (LRU) should be evicted');
  assert.equal(cache.has('b'), true, 'b (MRU, expired) should NOT be evicted');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.stats().evictions, 1);
});

test('replacing an existing key refreshes expiry and recency, not counted as eviction', () => {
  const { cache, clock } = makeCache({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  // Replace 'a': refreshes its expiry and makes it MRU.
  clock.advance(50);
  cache.set('a', 99);
  // 'b' is now LRU. 'a' expiry is now 50+100=150.
  clock.advance(50); // t=100. 'b' expired (set at t=0, expiry=100). 'a' live (expiry=150).
  cache.set('c', 3); // should evict 'b' (LRU), not 'a'
  assert.equal(cache.has('a'), true, 'a should still be present');
  assert.equal(cache.get('a'), 99, 'a should have the replaced value');
  assert.equal(cache.has('b'), false, 'b should be evicted');
  assert.equal(cache.stats().evictions, 1);
});

test('delete removes live and expired entries, returns true/false, no counter change', () => {
  const { cache, clock } = makeCache({ ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  const before = cache.stats();
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('missing'), false);
  clock.advance(100);
  assert.equal(cache.delete('b'), true, 'delete should remove expired entry');
  const after = cache.stats();
  assert.equal(after.evictions, before.evictions, 'delete must not increment evictions');
  assert.equal(after.expirations, before.expirations, 'delete must not increment expirations');
  assert.equal(cache.size, 0);
});

test('clear removes everything without resetting counters', () => {
  const { cache } = makeCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3); // evicts 'b'
  const before = cache.stats();
  assert.equal(before.hits, 1);
  assert.equal(before.evictions, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  const after = cache.stats();
  assert.equal(after.hits, before.hits, 'clear must not reset hits');
  assert.equal(after.misses, before.misses, 'clear must not reset misses');
  assert.equal(after.evictions, before.evictions, 'clear must not reset evictions');
  assert.equal(after.expirations, before.expirations, 'clear must not reset expirations');
});

test('purge removes only expired entries, returns count, increments expirations', () => {
  const { cache, clock } = makeCache({ ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  clock.advance(100);
  const removed = cache.purge();
  assert.equal(removed, 2);
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().expirations, 2);
  // purge again: nothing to remove
  assert.equal(cache.purge(), 0);
  assert.equal(cache.stats().expirations, 2, 'purge of empty should not increment');
});

test('stats() returns a fresh copy that cannot mutate the cache', () => {
  const { cache } = makeCache();
  cache.set('a', 1);
  cache.get('a');
  const s = cache.stats();
  assert.equal(s.hits, 1);
  s.hits = 999;
  s.misses = 999;
  s.evictions = 999;
  s.expirations = 999;
  const s2 = cache.stats();
  assert.equal(s2.hits, 1, 'mutating returned stats must not affect cache');
  assert.equal(s2.misses, 0);
  assert.equal(s2.evictions, 0);
  assert.equal(s2.expirations, 0);
});
