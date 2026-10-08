'use strict';

// The specification for SPEC-2.md, expressed as checks the architect owns.
//
// Written from SPEC-2.md alone, before any implementation, and frozen before either arm of PROTOCOL.md
// runs. It is the second task's judge: the TTL cache suite is the first. Like that one it is a
// specification-conformance suite, not a contract -- it says what SPEC-2.md requires, and it must be
// readable without ever having seen an implementation.
//
// Two rules govern every check below and are the reason it is written this way:
//
//   * The module is required *inside* each test, so a missing or unloadable module yields one clean
//     failure per check rather than one load-time crash that hides which clauses are unmet.
//   * Only the interface in SPEC-2.md is touched. No check reads or depends on a retention structure,
//     an internal field, or the number of times the injected clock was called. Any module that satisfies
//     the specification must pass; any module that does not, must not.
//
// Its own limit matters: it is only as strong as its coverage. Each check names the clause it pins so
// that a gap is visible as a missing clause rather than as a passing green row.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MODULE = '../src/aggregation-window.js';

let t = 0;
const clock = () => t;

// A frozen-free default of capacity 4, window 100, clock at 0, for the checks whose subject is not one of
// those three. A check that cares about the clock sets `t` after calling fresh().
const fresh = (options = {}) => {
  t = 0;
  const { createAggregationWindow } = require(MODULE);
  return createAggregationWindow({ capacity: 4, windowMs: 100, now: clock, ...options });
};

// Every accepted value below is a small integer and every mean is exact, so no check depends on binary
// floating point. This is deliberate: a judge that fails over `0.1 + 0.2` would be unfair to a correct
// module, and fairness is the point.

test('SPEC-2: construction requires an options object and all three properties', () => {
  const { createAggregationWindow } = require(MODULE);
  assert.throws(() => createAggregationWindow(), TypeError, 'no options');
  assert.throws(() => createAggregationWindow({ windowMs: 100, now: clock }), TypeError, 'no capacity');
  assert.throws(() => createAggregationWindow({ capacity: 2, now: clock }), TypeError, 'no windowMs');
  assert.throws(() => createAggregationWindow({ capacity: 2, windowMs: 100 }), TypeError, 'no now');
  assert.throws(() => createAggregationWindow(null), TypeError, 'null options');
});

test('SPEC-2: construction rejects an invalid capacity', () => {
  const { createAggregationWindow } = require(MODULE);
  for (const bad of [0, -1, 1.5, '2', null, undefined, NaN, Infinity]) {
    assert.throws(() => createAggregationWindow({ capacity: bad, windowMs: 100, now: clock }), TypeError, `capacity=${String(bad)}`);
  }
});

test('SPEC-2: construction rejects an invalid windowMs', () => {
  const { createAggregationWindow } = require(MODULE);
  for (const bad of [0, -1, '100', null, undefined, NaN, Infinity, -Infinity]) {
    assert.throws(() => createAggregationWindow({ capacity: 2, windowMs: bad, now: clock }), TypeError, `windowMs=${String(bad)}`);
  }
});

test('SPEC-2: construction rejects an invalid now', () => {
  const { createAggregationWindow } = require(MODULE);
  for (const bad of [123, 'now', null, undefined, {}]) {
    assert.throws(() => createAggregationWindow({ capacity: 2, windowMs: 100, now: bad }), TypeError, `now=${String(bad)}`);
  }
});

test('SPEC-2: an empty window aggregates to 0 and undefined, and stats starts at zero', () => {
  const w = fresh();
  const start = w.stats();
  assert.deepEqual(Object.keys(start).sort(), ['accepted', 'evicted', 'expired', 'queries'], 'exactly the four counters');
  assert.deepEqual(start, { accepted: 0, evicted: 0, expired: 0, queries: 0 }, 'all four start at zero');
  const agg = w.aggregate();
  assert.deepEqual(Object.keys(agg).sort(), ['count', 'max', 'mean', 'min', 'sum'], 'exactly the five properties');
  assert.equal(agg.count, 0);
  assert.equal(agg.sum, 0);
  assert.equal(agg.min, undefined);
  assert.equal(agg.max, undefined);
  assert.equal(agg.mean, undefined);
  assert.deepEqual(w.values(), []);
  assert.equal(w.retainedCount(), 0);
  assert.deepEqual(w.stats(), { accepted: 0, evicted: 0, expired: 0, queries: 2 }, 'two queries were answered');
});

test('SPEC-2: an accepted sample changes counts, sum and the answer', () => {
  const w = fresh();
  w.accept(1);
  w.accept(2);
  w.accept(3);
  const agg = w.aggregate();
  assert.equal(agg.count, 3);
  assert.equal(agg.sum, 6);
  assert.equal(agg.min, 1);
  assert.equal(agg.max, 3);
  assert.equal(agg.mean, 2);
  assert.deepEqual(w.values(), [1, 2, 3], 'acceptance order, oldest first');
  assert.equal(w.stats().accepted, 3);
});

test('SPEC-2: values are retained in acceptance order, duplicates included', () => {
  const w = fresh();
  w.accept(3);
  w.accept(1);
  w.accept(3);
  assert.deepEqual(w.values(), [3, 1, 3]);
  assert.equal(w.retainedCount(), 3);
});

test('SPEC-2: capacity discards the OLDEST sample and the aggregate excludes it', () => {
  const w = fresh({ capacity: 2 });
  w.accept(1);
  w.accept(2);
  w.accept(3);
  assert.equal(w.stats().evicted, 1, 'one sample over capacity, one capacity discard');
  assert.deepEqual(w.values(), [2, 3], 'the oldest went, not the newest');
  const agg = w.aggregate();
  assert.equal(agg.count, 2);
  assert.equal(agg.sum, 5, 'the discarded 1 must not contribute');
  assert.equal(agg.min, 2, 'the discarded 1 was the minimum and must not contribute');
  assert.equal(agg.max, 3);
  assert.equal(agg.mean, 2.5);
  assert.deepEqual(w.values(), [2, 3], 'aggregate did not itself discard anything');
});

test('SPEC-2: oldest-first discarding holds when the values are unordered', () => {
  const w = fresh({ capacity: 2 });
  w.accept(100);
  w.accept(-5);
  w.accept(7);
  assert.deepEqual(w.values(), [-5, 7], 'the first accepted left, whatever its value');
  assert.equal(w.stats().evicted, 1);
  const agg = w.aggregate();
  assert.equal(agg.sum, 2);
  assert.equal(agg.min, -5);
  assert.equal(agg.max, 7);
});

test('SPEC-2: the aggregate is order- and discard-sensitive, step by step', () => {
  const w = fresh({ capacity: 3 });
  w.accept(1);
  assert.equal(w.aggregate().sum, 1);
  w.accept(2);
  assert.equal(w.aggregate().sum, 3);
  w.accept(3);
  assert.equal(w.aggregate().sum, 6);
  w.accept(4); // 1 is discarded for capacity
  w.accept(5); // 2 is discarded for capacity
  assert.equal(w.stats().evicted, 2);
  assert.deepEqual(w.values(), [3, 4, 5]);
  const agg = w.aggregate();
  assert.equal(agg.sum, 12, 'a running total that forgot two discards would say 15');
  assert.equal(agg.min, 3);
  assert.equal(agg.max, 5);
  assert.equal(agg.count, 3);
});

test('SPEC-2: repeated accepts past capacity keep exactly the newest samples', () => {
  const w = fresh({ capacity: 2 });
  for (const v of [1, 2, 3, 4, 5, 6]) w.accept(v);
  assert.deepEqual(w.values(), [5, 6]);
  assert.equal(w.stats().evicted, 4);
  assert.equal(w.stats().accepted, 6);
  assert.equal(w.aggregate().sum, 11);
});

test('SPEC-2: the boundary moment is expired, not retained (window is half-open)', () => {
  const w = fresh({ windowMs: 100 });
  w.accept(7); // accepted at 0
  t = 0;
  assert.equal(w.retainedCount(), 1, 'age 0 is inside');
  t = 99;
  assert.equal(w.retainedCount(), 1, 'age 99 is inside');
  t = 100;
  assert.equal(w.retainedCount(), 0, 'age === windowMs is expired');
  assert.deepEqual(w.values(), []);
  assert.equal(w.stats().expired, 1, 'the one expired sample was removed once');
});

test('SPEC-2: a sample is expired against the current moment, not against the newest sample', () => {
  const w = fresh({ capacity: 8, windowMs: 100 });
  w.accept(1); // timestamp 0
  t = 90;
  w.accept(2); // timestamp 90; gap between samples is 90
  t = 90;
  assert.deepEqual(w.values(), [1, 2], 'a gap smaller than the window leaves both inside');
  t = 150; // 1 is 150 old, 2 is 60 old
  const agg = w.aggregate();
  assert.equal(agg.sum, 2, 'only the sample that is inside the window contributes');
  assert.equal(agg.count, 1);
  assert.deepEqual(w.values(), [2]);
  assert.equal(w.stats().expired, 1, 'the older sample was removed for age, and counted once');
});

test('SPEC-2: a query at a later moment sees a window that has slid', () => {
  const w = fresh({ capacity: 8, windowMs: 100 });
  w.accept(1); // 0
  t = 50;
  w.accept(2); // 50
  t = 120; // 1 is expired, 2 is inside
  assert.deepEqual(w.values(), [2]);
  const agg = w.aggregate();
  assert.equal(agg.count, 1);
  assert.equal(agg.sum, 2);
  assert.equal(agg.mean, 2);
  assert.equal(w.stats().expired, 1);
});

test('SPEC-2: an old sample does not expel a newer one that is still inside the window', () => {
  const w = fresh({ capacity: 2, windowMs: 100 });
  w.accept(1); // 0
  t = 90;
  w.accept(2); // 90
  t = 95;
  w.accept(3); // 95 -> capacity 2 already reached, so the oldest (1) goes
  assert.equal(w.stats().evicted, 1, 'exactly one capacity discard');
  assert.equal(w.stats().expired, 0, 'nothing was outside the window yet');
  assert.deepEqual(w.values(), [2, 3]);
});

test('SPEC-2: an accept removes expired samples and counts them', () => {
  const w = fresh({ capacity: 8, windowMs: 100 });
  w.accept(1);
  w.accept(2);
  t = 150; // both expired
  w.accept(3); // the sweep runs, then 3 is appended
  const s = w.stats();
  assert.equal(s.expired, 2, 'both stale samples were removed by the accept');
  assert.equal(s.evicted, 0, 'removal for age is never a capacity discard');
  assert.equal(s.accepted, 3);
  assert.deepEqual(w.values(), [3]);
});

test('SPEC-2: samples too old to remain are counted as expired, not evicted, even over capacity', () => {
  const w = fresh({ capacity: 1, windowMs: 100 });
  w.accept(1);
  w.accept(2); // capacity 1 -> 1 is discarded for capacity
  t = 200; // 2 is now expired
  w.accept(3); // 2 leaves for age; 3 fits within capacity
  const s = w.stats();
  assert.equal(s.evicted, 1, 'the capacity counter is unchanged by the age removal');
  assert.equal(s.expired, 1, 'the age removal is counted as expired');
  assert.deepEqual(w.values(), [3]);
});

test('SPEC-2: aggregate and values each sweep expired samples and count them once', () => {
  const w = fresh({ capacity: 8, windowMs: 100 });
  w.accept(1);
  w.accept(2);
  t = 150; // both expired
  assert.deepEqual(w.values(), [], 'values answers over what is retained');
  assert.deepEqual(w.values(), [], 'the second sweep has nothing left to remove');
  assert.equal(w.stats().expired, 2, 'each sample was removed exactly once');
  assert.equal(w.stats().evicted, 0);
  assert.equal(w.stats().accepted, 2);

  const w2 = fresh({ capacity: 8, windowMs: 100 });
  w2.accept(1);
  w2.accept(2);
  t = 150;
  assert.equal(w2.aggregate().count, 0);
  assert.equal(w2.stats().expired, 2, 'aggregate sweeps too');
});

test('SPEC-2: min and max survive negatives where a zero-seeded implementation would not', () => {
  const w = fresh();
  w.accept(-5);
  w.accept(-2);
  const agg = w.aggregate();
  assert.equal(agg.min, -5);
  assert.equal(agg.max, -2);
  assert.equal(agg.sum, -7);
  assert.equal(agg.mean, -3.5);
});

test('SPEC-2: retainedCount is an observation and removes nothing', () => {
  const w = fresh({ windowMs: 100, capacity: 4 });
  w.accept(1); // 0
  t = 150; // outside the window
  assert.equal(w.retainedCount(), 0, 'the count reflects the window');
  assert.equal(w.stats().expired, 0, 'observing must not count an expiration');
  assert.equal(w.stats().accepted, 1, 'observing must not change another counter');
  assert.equal(w.stats().queries, 0, 'retainedCount is not a query');
  t = 50; // rewind: if sampling had removed it, it could not be here
  assert.equal(w.retainedCount(), 1, 'it was never removed');
  assert.equal(w.stats().expired, 0, 'still no expiration');
  assert.deepEqual(w.values(), [1], 'and it is a real retained sample, not a ghost count');
  assert.equal(w.stats().expired, 0);
});

test('SPEC-2: stats is not a query and does not count itself', () => {
  const w = fresh();
  w.accept(1);
  w.stats();
  w.stats();
  assert.equal(w.stats().queries, 0, 'stats is an observation');
  w.aggregate();
  assert.equal(w.stats().queries, 1, 'aggregate is a query');
  w.values();
  assert.equal(w.stats().queries, 2, 'values is a query');
  w.retainedCount();
  assert.equal(w.stats().queries, 2, 'retainedCount is not a query');
});

test('SPEC-2: clear removes every sample, counts nothing, and keeps the counters', () => {
  const w = fresh({ capacity: 4, windowMs: 100 });
  w.accept(1);
  w.accept(2);
  w.aggregate();
  const before = w.stats();
  assert.deepEqual(before, { accepted: 2, evicted: 0, expired: 0, queries: 1 });
  w.clear();
  assert.deepEqual(w.values(), [], 'every sample is gone at once');
  assert.equal(w.retainedCount(), 0);
  assert.deepEqual(w.stats(), { accepted: 2, evicted: 0, expired: 0, queries: 2 }, 'clear increments no counter');
  w.accept(3);
  assert.deepEqual(w.values(), [3]);
  assert.deepEqual(w.stats(), { accepted: 3, evicted: 0, expired: 0, queries: 3 }, 'counters survive clear');
});

test('SPEC-2: clear removes expired samples without counting them as expired', () => {
  const w = fresh({ capacity: 4, windowMs: 100 });
  w.accept(1);
  w.accept(2);
  t = 150; // both outside the window
  w.clear();
  assert.equal(w.stats().expired, 0, 'clear attributes no removal to age');
  assert.equal(w.stats().evicted, 0);
  assert.equal(w.retainedCount(), 0);
  assert.deepEqual(w.values(), []);
});

test('SPEC-2: accept rejects a non-finite value, records nothing and counts nothing', () => {
  const w = fresh({ capacity: 2, windowMs: 100 });
  w.accept(5);
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, {}]) {
    assert.throws(() => w.accept(bad), TypeError, `value=${String(bad)}`);
  }
  assert.equal(w.stats().accepted, 1, 'a rejected accept records nothing');
  assert.equal(w.stats().evicted, 0);
  assert.equal(w.stats().expired, 0);
  assert.deepEqual(w.values(), [5], 'the rejected values never entered the sequence');
});

test('SPEC-2: a rejected accept does not sweep, so it discards nothing', () => {
  const w = fresh({ capacity: 2, windowMs: 100 });
  w.accept(1);
  t = 150; // the retained sample is now outside the window
  assert.throws(() => w.accept(NaN), TypeError);
  assert.equal(w.stats().expired, 0, 'a call that throws leaves the window reconciled as it was');
  assert.equal(w.retainedCount(), 0, 'it is still outside the window, and still present');
  t = 50; // rewind: nothing removed it
  assert.equal(w.retainedCount(), 1, 'the failed accept discarded nothing');
});

test('SPEC-2: the injected clock is the only source of time', () => {
  const pinned = () => 5; // a reading from 1970, so any use of the real clock is unmistakable
  const { createAggregationWindow } = require(MODULE);
  const w = createAggregationWindow({ capacity: 2, windowMs: 50, now: pinned });
  w.accept(1);
  w.accept(2);
  w.accept(3); // capacity 2 -> the oldest goes, and only for capacity
  assert.deepEqual(w.values(), [2, 3], 'all three are far inside a 50ms window measured from 5');
  assert.equal(w.aggregate().sum, 5);
  assert.deepEqual(w.stats(), { accepted: 3, evicted: 1, expired: 0, queries: 2 }, 'nothing was aged out');
});

test('SPEC-2: stats, aggregate and values each return a fresh copy', () => {
  const w = fresh();
  w.accept(2);
  const stats = w.stats();
  stats.accepted = 99;
  stats.expired = 99;
  assert.deepEqual(w.stats(), { accepted: 1, evicted: 0, expired: 0, queries: 0 }, 'stats returns a copy');

  const agg = w.aggregate();
  agg.count = 99;
  agg.sum = 99;
  const agg2 = w.aggregate();
  assert.equal(agg2.count, 1);
  assert.equal(agg2.sum, 2, 'the aggregate object is rebuilt, not handed out');

  const values = w.values();
  values.push(1234);
  values[0] = 1234;
  assert.deepEqual(w.values(), [2], 'values returns a copy');
});
