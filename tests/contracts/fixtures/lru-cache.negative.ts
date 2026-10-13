// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE, and it is the most likely wrong answer to this specification: a Map
// already preserves insertion order, so an implementation that deletes and re-inserts on `set` has a
// working LRU until the first `get` of a key that is not already the most recent. It is wrong in
// exactly one respect -- `get` does not promote.
//
// Everything else is right, which is the point: capacity validation, in-place update on `set` of an
// existing key, eviction of the oldest entry on overflow, `has` as a pure membership test, `delete`,
// `clear`, and a #private store that the encapsulation case cannot reach.
//
// Expected, MEASURED in the pre-flight rather than assumed: the contract passes every case EXCEPT
// "PROMOTES on get" and "matches a recency model across randomised operations".
export class LRUCache<K, V> {
  #map = new Map<K, V>();
  #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('LRUCache capacity must be a positive integer, received ' + String(capacity));
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#map.size;
  }

  get capacity(): number {
    return this.#capacity;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  get(key: K): V | undefined {
    // THE DEFECT. A read must move the entry to the most-recently-used end. Without it the map's
    // insertion order is treated as recency order, and the next overflow evicts the entry a caller
    // just read.
    return this.#map.get(key);
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    }
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) {
      const oldest = this.#map.keys().next().value as K;
      this.#map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}
