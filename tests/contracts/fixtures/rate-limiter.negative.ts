// A plausible wrong answer, for the discrimination gate only. Never required by anything.
//
// It is correct in every respect except one: refill rounds each increment DOWN to a whole token and
// restarts the interval from the read, so the fraction of a token earned between reads is discarded
// instead of carried. A bucket read at 400 ms intervals at 1 token/s therefore never fills, which is
// the starvation case the contract's "FRACTIONAL REFILL CARRIES" test exists to catch.
//
// Everything else -- validation, atomic refusals, saturation at capacity, the injected clock, reset --
// is implemented properly, so the contract's other cases pass against it. A fixture that fails
// everything is not evidence about any particular property.
export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export class TokenBucket {
  #capacity: number;
  #rate: number;
  #now: () => number;
  #tokens: number;
  #last: number;

  constructor(options: TokenBucketOptions) {
    const { capacity, refillPerSecond, now = Date.now } = options ?? ({} as TokenBucketOptions);
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive finite number');
    }
    if (typeof refillPerSecond !== 'number' || !Number.isFinite(refillPerSecond) || refillPerSecond < 0) {
      throw new RangeError('refillPerSecond must be a finite number >= 0');
    }
    this.#capacity = capacity;
    this.#rate = refillPerSecond;
    this.#now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  get capacity(): number {
    return this.#capacity;
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }

  tryRemove(count: number = 1): boolean {
    this.#requirePositive(count);
    this.#refill();
    if (count > this.#capacity || count > this.#tokens) return false;
    this.#tokens -= count;
    return true;
  }

  msUntil(count: number = 1): number {
    this.#requirePositive(count);
    if (count > this.#capacity) return Infinity;
    this.#refill();
    if (this.#tokens >= count) return 0;
    if (this.#rate === 0) return Infinity;
    return Math.ceil(((count - this.#tokens) / this.#rate) * 1000);
  }

  reset(): void {
    this.#tokens = this.#capacity;
    this.#last = this.#now();
  }

  #requirePositive(count: number): void {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
      throw new RangeError('count must be a positive finite number');
    }
  }

  #refill(): void {
    const at = this.#now();
    const elapsed = Math.max(0, at - this.#last);
    this.#tokens = Math.min(this.#capacity, this.#tokens + Math.floor((elapsed / 1000) * this.#rate));
    this.#last = at;
  }
}
