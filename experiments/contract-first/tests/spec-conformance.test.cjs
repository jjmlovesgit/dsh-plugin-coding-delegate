'use strict';

// The specification, expressed as checks the architect owns.
//
// This is not a contract. A contract says what a unit must do to be accepted; this says what SPEC.md
// requires, and it exists so that a contract can be measured against something the architect can author
// and read without ever seeing implementation. It is the mirror image of the null implementation used by
// `scripts/check-contract.cjs`: null proves the module cannot be blamed, and this proves the module CAN be
// trusted -- after which a contract that still rejects it is the artifact at fault.
//
// It was written from SPEC.md alone, and it is deliberately independent of both contracts in this
// directory: tests/ttl-cache.test.js (the transcribed one, which failed a module that satisfies all of
// this) and tests/ttl-cache.spec.test.js (the corrected one). Running the guard with this suite and the
// transcribed contract reproduces the experiment's real defect as a verdict rather than as a story.
//
// Its own limit matters and is stated in the guard's output: it is only as strong as its coverage. An
// incomplete suite makes a non-conforming module look conformant, and the disagreement verdict then
// over-fires -- which is why that verdict names both possibilities instead of condemning the contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache } = require('../src/ttl-cache.js');

let t = 0;
const clock = () => t;
const fresh = (options = {}) => {
  t = 0;
  return createTtlCache({ maxEntries: 2, ttlMs: 100, now: clock, ...options });
};

test('SPEC: construction rejects an invalid maxEntries', () => {
  for (const bad of [0, -1, 1.5, '2', null, undefined, NaN, Infinity]) {
    assert.throws(() => createTtlCache({ maxEntries: bad, ttlMs: 100, now: clock }), TypeError, `maxEntries=${String(bad)}`);
  }
});

test('SPEC: construction rejects an invalid ttlMs', () => {
  for (const bad of [0, -1, '100', null, undefined, NaN, Infinity, -Infinity]) {
    assert.throws(() => createTtlCache({ maxEntries: 2, ttlMs: bad, now: clock }), TypeError, `ttlMs=${String(bad)}`);
  }
});

test('SPEC: construction rejects an invalid now', () => {
  for (const bad of [123, 'now', null, undefined]) {
    assert.throws(() => createTtlCache({ maxEntries: 2, ttlMs: 100, now: bad }), TypeError, `now=${String(bad)}`);
  }
});

test('SPEC: set then get returns the value, and an absent key counts one miss', () => {
  const cache = fresh();
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('missing'), undefined);
  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
});

test('SPEC: get of an expired key removes it, counting one expiration and one miss', () => {
  const cache = fresh({ ttlMs: 100 });
  cache.set('a', 1);
  t = 100; // now() >= expiry
  assert.equal(cache.get('a'), undefined);
  const stats = cache.stats();
  assert.equal(stats.expirations, 1);
  assert.equal(stats.misses, 1);
  assert.equal(cache.size, 0);
});

test('SPEC: eviction is bounded by the LIVE count, so an expired entry does not occupy capacity', () => {
  const cache = fresh({ maxEntries: 1, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2); // live 2 > 1 -> a is evicted
  assert.equal(cache.stats().evictions, 1);
  t = 150; // b is now expired
  cache.set('c', 3); // live {c} = 1, so no eviction may happen
  assert.equal(cache.stats().evictions, 1, 'the live count is within the bound');
  assert.equal(cache.delete('b'), true, 'the expired entry must still be present');
});

test('SPEC: an expired entry is not a preferred victim', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  t = 150; // both expired, live count 0
  cache.set('c', 3);
  cache.set('d', 4); // live 2, still at the bound
  assert.equal(cache.stats().evictions, 0, 'no eviction is warranted within the bound');
  assert.equal(cache.delete('a'), true, 'a must survive');
  assert.equal(cache.delete('b'), true, 'b must survive');
});

test('SPEC: when eviction is warranted it removes the least recently used entry', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // live 3 > 2 -> evict the LRU, which is a
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
});

test('SPEC: a successful get refreshes recency', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3); // evict the LRU, which is now b
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
});

test('SPEC: has is an observation and refreshes nothing', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.has('a');
  cache.set('c', 3); // evict the LRU, which is still a
  assert.equal(cache.has('a'), false, 'has must not have refreshed recency');
});

test('SPEC: size and stats are observations and refresh nothing', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);
  void cache.size;
  cache.stats();
  cache.set('c', 3); // evict the LRU, which is still a
  assert.equal(cache.has('a'), false, 'size and stats must not have refreshed recency');
});

test('SPEC: replacing refreshes expiry, recency and value, and is not an eviction', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  t = 50;
  cache.set('a', 9); // replace: a expiry becomes 150 and a becomes MRU
  assert.equal(cache.stats().evictions, 0, 'a replace is not an eviction');
  assert.equal(cache.size, 2);
  t = 120; // a is live (150), b is expired (100)
  assert.equal(cache.size, 1, 'size counts live entries only');
  cache.set('c', 3); // live {a, c} = 2, at the bound
  assert.equal(cache.stats().evictions, 0, 'the live count is within the bound');
  assert.equal(cache.delete('b'), true, 'the expired entry must still be present');
  assert.equal(cache.get('a'), 9, 'a survived with its replaced value');
});

test('SPEC: replacing an expired key revives it', () => {
  const cache = fresh({ maxEntries: 1, ttlMs: 100 });
  cache.set('a', 1);
  t = 150; // a is expired
  cache.set('a', 2);
  assert.equal(cache.stats().evictions, 0, 'reviving a key is not an eviction');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('a'), 2);
});

test('SPEC: has and size never remove an expired entry', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  t = 150;
  assert.equal(cache.has('a'), false, 'has answers liveness');
  assert.equal(cache.size, 0, 'size counts live entries only');
  assert.equal(cache.stats().expirations, 0, 'neither may increment expirations');
  t = 50; // rewind: nothing removed it, so it is live again
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 1);
});

test('SPEC: delete removes live and expired entries and touches no counter', () => {
  const cache = fresh({ maxEntries: 2, ttlMs: 100 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('missing'), false);
  assert.equal(cache.delete('a'), true);
  t = 150;
  assert.equal(cache.delete('b'), true, 'an expired entry can be deleted');
  assert.equal(cache.stats().evictions, 0);
  assert.equal(cache.stats().expirations, 0);
});

test('SPEC: clear keeps the counters, purge removes exactly the expired entries, stats returns a copy', () => {
  const cache = fresh({ maxEntries: 4, ttlMs: 100 });
  cache.set('a', 1);
  cache.get('a');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().hits, 1, 'clear describes the cache life, not its contents');

  const c2 = fresh({ maxEntries: 4, ttlMs: 100 });
  c2.set('x', 1);
  c2.set('y', 2);
  t = 150; // both expired
  assert.equal(c2.purge(), 2);
  assert.equal(c2.stats().expirations, 2);
  assert.equal(c2.size, 0);

  const c3 = fresh();
  c3.set('a', 1);
  const snapshot = c3.stats();
  snapshot.hits = 99;
  assert.equal(c3.stats().hits, 0, 'the returned object is a copy');
});
