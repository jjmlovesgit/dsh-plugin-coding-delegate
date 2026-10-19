export class SlidingWindowLog {
  #windowMs: number;
  #maxRequests: number;
  #timestamps: Map<string, number[]>;

  constructor(windowMs: number, maxRequests: number) {
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be a positive finite number');
    }
    if (typeof maxRequests !== 'number' || !Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new RangeError('maxRequests must be a positive integer');
    }
    this.#windowMs = windowMs;
    this.#maxRequests = maxRequests;
    this.#timestamps = new Map();
  }

  allow(key: string, now: number): boolean {
    const existing = this.#timestamps.get(key);
    if (existing) {
      const filtered = existing.filter((t) => now - t < this.#windowMs);
      if (filtered.length < this.#maxRequests) {
        filtered.push(now);
        this.#timestamps.set(key, filtered);
        return true;
      }
      this.#timestamps.set(key, filtered);
      return false;
    }
    this.#timestamps.set(key, [now]);
    return true;
  }

  getRemaining(key: string, now: number): number {
    const existing = this.#timestamps.get(key);
    if (existing) {
      const filtered = existing.filter((t) => now - t < this.#windowMs);
      this.#timestamps.set(key, filtered);
      return this.#maxRequests - filtered.length;
    }
    return this.#maxRequests;
  }

  reset(key?: string): void {
    if (key !== undefined) {
      this.#timestamps.delete(key);
    } else {
      this.#timestamps.clear();
    }
  }
}
