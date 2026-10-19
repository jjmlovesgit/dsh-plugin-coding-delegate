export class ExponentialBackoff {
  #baseDelayMs: number;
  #maxDelayMs: number;
  #factor: number;
  #jitter: 'none' | 'full';

  constructor(options: {
    baseDelayMs: number;
    maxDelayMs: number;
    factor?: number;
    jitter?: 'none' | 'full';
  }) {
    const { baseDelayMs, maxDelayMs, factor = 2, jitter = 'none' } = options;

    if (typeof baseDelayMs !== 'number' || !Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
      throw new RangeError('baseDelayMs must be a positive finite number');
    }
    if (typeof maxDelayMs !== 'number' || !Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
      throw new RangeError('maxDelayMs must be a positive finite number');
    }
    if (maxDelayMs < baseDelayMs) {
      throw new RangeError('maxDelayMs must be >= baseDelayMs');
    }
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 1) {
      throw new RangeError('factor must be a finite number >= 1');
    }
    if (jitter !== 'none' && jitter !== 'full') {
      throw new RangeError("jitter must be exactly 'none' or 'full'");
    }

    this.#baseDelayMs = baseDelayMs;
    this.#maxDelayMs = maxDelayMs;
    this.#factor = factor;
    this.#jitter = jitter;
  }

  computeDelay(attempt: number, rngSeed?: number): number {
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) {
      throw new RangeError('attempt must be a non-negative integer');
    }

    if (rngSeed !== undefined) {
      if (typeof rngSeed !== 'number' || !Number.isFinite(rngSeed) || rngSeed < 0 || rngSeed > 1) {
        throw new RangeError('rngSeed must be a finite number in [0, 1]');
      }
    }

    const raw = Math.min(this.#maxDelayMs, this.#baseDelayMs * Math.pow(this.#factor, attempt));

    if (this.#jitter === 'none') {
      return Math.round(raw);
    }

    const seed = rngSeed !== undefined ? rngSeed : 0.5;
    return Math.round(raw * seed);
  }

  reset(): void {
    // Stateless implementation: no-op
  }
}
