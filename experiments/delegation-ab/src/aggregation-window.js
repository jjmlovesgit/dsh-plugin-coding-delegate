'use strict';

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function isPositiveInteger(x) {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

function isPositiveFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function createAggregationWindow(options) {
  if (options === undefined || options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  const { capacity, windowMs, now } = options;

  if (!isPositiveInteger(capacity)) {
    throw new TypeError('capacity must be a positive integer');
  }
  if (!isPositiveFiniteNumber(windowMs)) {
    throw new TypeError('windowMs must be a positive finite number');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  // Retained sequence in acceptance order: oldest first, newest last.
  const samples = [];

  const counters = {
    accepted: 0,
    evicted: 0,
    expired: 0,
    queries: 0,
  };

  // Remove every sample expired at moment N, oldest first.
  function removeExpired(N) {
    while (samples.length > 0) {
      const oldest = samples[0];
      if (N < oldest.t + windowMs) {
        break;
      }
      samples.shift();
      counters.expired += 1;
    }
  }

  function accept(value) {
    if (!isFiniteNumber(value)) {
      throw new TypeError('value must be a finite number');
    }

    const N = now();

    // Record the sample at the current moment.
    samples.push({ value, t: N });
    counters.accepted += 1;

    // Reconcile, in normative order.
    // 1. Remove every retained sample expired at the current moment, oldest first.
    removeExpired(N);

    // 2. While retained exceeds capacity, remove the OLDEST remaining sample.
    while (samples.length > capacity) {
      samples.shift();
      counters.evicted += 1;
    }
  }

  function aggregate() {
    const N = now();
    removeExpired(N);
    counters.queries += 1;

    const count = samples.length;
    if (count === 0) {
      return { count: 0, sum: 0, min: undefined, max: undefined, mean: undefined };
    }

    let sum = 0;
    let min = samples[0].value;
    let max = samples[0].value;
    for (let i = 0; i < count; i++) {
      const v = samples[i].value;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    return { count, sum, min, max, mean: sum / count };
  }

  function values() {
    const N = now();
    removeExpired(N);
    counters.queries += 1;

    const out = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i].value;
    }
    return out;
  }

  function retainedCount() {
    const N = now();
    let count = 0;
    for (let i = 0; i < samples.length; i++) {
      if (N < samples[i].t + windowMs) {
        count += 1;
      }
    }
    return count;
  }

  function clear() {
    samples.length = 0;
  }

  function stats() {
    return {
      accepted: counters.accepted,
      evicted: counters.evicted,
      expired: counters.expired,
      queries: counters.queries,
    };
  }

  return {
    accept,
    aggregate,
    values,
    retainedCount,
    clear,
    stats,
  };
}

module.exports = { createAggregationWindow };
