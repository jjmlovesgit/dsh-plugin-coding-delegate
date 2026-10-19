"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExponentialBackoff = void 0;
/** True for a finite number greater than zero. */
function isPositiveFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
/**
 * Constructor validation, split out of the constructor.
 *
 * The checks are unchanged and so are the messages; what changed is where they live. Inlined, five
 * conditions with three clauses each put the constructor at complexity 15, which is the point at
 * which a reader stops being able to check the validation by reading it -- and validation is exactly
 * the code a reader checks by reading it.
 */
function assertOptions(baseDelayMs, maxDelayMs, factor, jitter) {
    if (!isPositiveFinite(baseDelayMs))
        throw new RangeError('baseDelayMs must be a positive finite number');
    if (!isPositiveFinite(maxDelayMs))
        throw new RangeError('maxDelayMs must be a positive finite number');
    if (maxDelayMs < baseDelayMs)
        throw new RangeError('maxDelayMs must be >= baseDelayMs');
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 1) {
        throw new RangeError('factor must be a finite number >= 1');
    }
    if (jitter !== 'none' && jitter !== 'full') {
        throw new RangeError("jitter must be exactly 'none' or 'full'");
    }
}
function assertAttempt(attempt) {
    // Number.isInteger rejects a non-number, so the typeof clause the first version carried was
    // redundant; the error message is the same either way.
    if (!Number.isInteger(attempt) || attempt < 0) {
        throw new RangeError('attempt must be a non-negative integer');
    }
}
function assertSeed(rngSeed) {
    if (typeof rngSeed !== 'number' || !Number.isFinite(rngSeed) || rngSeed < 0 || rngSeed > 1) {
        throw new RangeError('rngSeed must be a finite number in [0, 1]');
    }
}
class ExponentialBackoff {
    #baseDelayMs;
    #maxDelayMs;
    #factor;
    #jitter;
    constructor(options) {
        const { baseDelayMs, maxDelayMs, factor = 2, jitter = 'none' } = options;
        assertOptions(baseDelayMs, maxDelayMs, factor, jitter);
        this.#baseDelayMs = baseDelayMs;
        this.#maxDelayMs = maxDelayMs;
        this.#factor = factor;
        this.#jitter = jitter;
    }
    computeDelay(attempt, rngSeed) {
        assertAttempt(attempt);
        if (rngSeed !== undefined)
            assertSeed(rngSeed);
        const raw = Math.min(this.#maxDelayMs, this.#baseDelayMs * Math.pow(this.#factor, attempt));
        if (this.#jitter === 'none') {
            return Math.round(raw);
        }
        return Math.round(raw * (rngSeed !== undefined ? rngSeed : 0.5));
    }
    reset() {
        // Stateless implementation: no-op
    }
}
exports.ExponentialBackoff = ExponentialBackoff;
