/**
 * A plausible wrong answer, for the discrimination gate only. Never required by anything.
 *
 * It implements the whole interface, clamps correctly, survives extreme attempts, and honours both
 * jitter modes and a custom growth factor. Its one defect is the exponent's origin: it raises the
 * factor to `attempt + 1`, so the first retry already waits `baseDelayMs * factor` instead of
 * `baseDelayMs`. That is the mistake a model makes when it reads "exponential backoff" as "the delay
 * grows by the factor each time" and indexes from 1 -- and it is invisible to every check except a
 * zero-indexed assertion.
 */
export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  factor?: number;
  jitter?: 'none' | 'full';
}

export class ExponentialBackoff {
  #baseDelayMs: number;
  #maxDelayMs: number;
  #factor: number;
  #jitter: 'none' | 'full';

  constructor(options: BackoffOptions) {
    this.#baseDelayMs = options.baseDelayMs;
    this.#maxDelayMs = options.maxDelayMs;
    this.#factor = options.factor !== undefined ? options.factor : 2.0;
    this.#jitter = options.jitter || 'none';
  }

  computeDelay(attempt: number, rngSeed?: number): number {
    // The defect: one-indexed exponentiation rather than zero-indexed.
    const raw = this.#baseDelayMs * Math.pow(this.#factor, attempt + 1);
    const clamped = Math.min(this.#maxDelayMs, raw);

    if (this.#jitter === 'full') {
      const seed = rngSeed !== undefined ? rngSeed : 0.5;
      return Math.round(clamped * seed);
    }

    return Math.round(clamped);
  }

  reset(): void {
    /* stateless */
  }
}

export default ExponentialBackoff;
