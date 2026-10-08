'use strict';

function createTtlCache(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }

  const { maxEntries, ttlMs, now } = options;

  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('maxEntries must be a positive integer');
  }
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive finite number');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  // Map preserves insertion order. We maintain it so that the first key is
  // the least-recently-used and the last key is the most-recently-used.
  const store = new Map();

  const stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
  };

  function isExpired(entry) {
    return now() >= entry.expiry;
  }

  function liveCount() {
    let count = 0;
    for (const entry of store.values()) {
      if (!isExpired(entry)) count += 1;
    }
    return count;
  }

  function evictUntilWithinBound() {
    // Evict least-recently-used first (front of the Map), strictly by recency,
    // until the number of live entries is at or below maxEntries.
    while (liveCount() > maxEntries) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  function set(key, value) {
    const expiry = now() + ttlMs;

    if (store.has(key)) {
      // Replace: refresh value + expiry, and move to most-recently-used.
      store.delete(key);
      store.set(key, { value, expiry });
    } else {
      store.set(key, { value, expiry });
    }

    evictUntilWithinBound();
  }

  function get(key) {
    if (!store.has(key)) {
      stats.misses += 1;
      return undefined;
    }

    const entry = store.get(key);

    if (isExpired(entry)) {
      store.delete(key);
      stats.expirations += 1;
      stats.misses += 1;
      return undefined;
    }

    // Live: refresh recency by re-inserting at the end.
    store.delete(key);
    store.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  function has(key) {
    if (!store.has(key)) return false;
    const entry = store.get(key);
    return !isExpired(entry);
  }

  function deleteKey(key) {
    if (!store.has(key)) return false;
    store.delete(key);
    return true;
  }

  function clear() {
    store.clear();
  }

  function purge() {
    let removed = 0;
    for (const [key, entry] of store) {
      if (isExpired(entry)) {
        store.delete(key);
        removed += 1;
      }
    }
    stats.expirations += removed;
    return removed;
  }

  function size() {
    return liveCount();
  }

  function statsSnapshot() {
    return {
      hits: stats.hits,
      misses: stats.misses,
      evictions: stats.evictions,
      expirations: stats.expirations,
    };
  }

  const cache = {
    set,
    get,
    has,
    delete: deleteKey,
    clear,
    purge,
    stats: statsSnapshot,
  };

  Object.defineProperty(cache, 'size', {
    enumerable: true,
    configurable: true,
    get: size,
  });

  return cache;
}

module.exports = { createTtlCache };
