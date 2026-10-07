class TTLCache {
  constructor({ maxEntries = Infinity, ttlMs = Infinity } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError('ttlMs must be a non-negative number');
    }
    this._maxEntries = maxEntries;
    this._ttlMs = ttlMs;
    this._map = new Map();
    this._now = 0;
    this._stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  }

  set now(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError('now must be a non-negative number');
    }
    this._now = ms;
  }

  get now() {
    return this._now;
  }

  set(key, value) {
    const existing = this._map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = this._now + this._ttlMs;
      this._map.delete(key);
      this._map.set(key, existing);
      return;
    }
    if (this._map.size >= this._maxEntries) {
      const lruKey = this._map.keys().next().value;
      this._map.delete(lruKey);
      this._stats.evictions++;
    }
    this._map.set(key, { value, expiresAt: this._now + this._ttlMs });
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) {
      this._stats.misses++;
      return undefined;
    }
    if (this._now >= entry.expiresAt) {
      this._map.delete(key);
      this._stats.expirations++;
      this._stats.misses++;
      return undefined;
    }
    this._map.delete(key);
    this._map.set(key, entry);
    this._stats.hits++;
    return entry.value;
  }

  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    return this._now < entry.expiresAt;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }

  stats() {
    return { ...this._stats };
  }
}

module.exports = { TTLCache };
