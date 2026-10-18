export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export class TokenBucket {
  #capacity: number;
  #refillPerSecond: number;
  #now: () => number;
  #available: number;
  #lastObserved: number;

  constructor(options: TokenBucketOptions) {
    const { capacity, refillPerSecond, now } = options;

    if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive finite number");
    }
    if (typeof refillPerSecond !== "number" || !Number.isFinite(refillPerSecond) || refillPerSecond < 0) {
      throw new RangeError("refillPerSecond must be a finite number >= 0");
    }
    if (now !== undefined && typeof now !== "function") {
      throw new TypeError("now must be a function");
    }

    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
    this.#now = now ?? Date.now;
    this.#available = capacity;
    this.#lastObserved = this.#now();
  }

  get capacity(): number {
    return this.#capacity;
  }

  get available(): number {
    this.#refill();
    return this.#available;
  }

  tryRemove(count = 1): boolean {
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      throw new RangeError("count must be a positive finite number");
    }
    this.#refill();
    if (count <= this.#available && count <= this.#capacity) {
      this.#available -= count;
      return true;
    }
    return false;
  }

  msUntil(count = 1): number {
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      throw new RangeError("count must be a positive finite number");
    }
    this.#refill();
    if (count > this.#capacity) {
      return Infinity;
    }
    if (this.#refillPerSecond === 0) {
      return count <= this.#available ? 0 : Infinity;
    }
    if (count <= this.#available) {
      return 0;
    }
    return Math.ceil(((count - this.#available) / this.#refillPerSecond) * 1000);
  }

  reset(): void {
    this.#available = this.#capacity;
    this.#lastObserved = this.#now();
  }

  #refill(): void {
    const current = this.#now();
    let elapsed = current - this.#lastObserved;
    if (elapsed < 0) {
      elapsed = 0;
    }
    if (elapsed > 0 && this.#refillPerSecond > 0) {
      const increment = (elapsed / 1000) * this.#refillPerSecond;
      this.#available = Math.min(this.#capacity, this.#available + increment);
    }
    this.#lastObserved = current;
  }
}
