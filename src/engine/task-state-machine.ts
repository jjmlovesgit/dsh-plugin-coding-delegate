/**
 * Deterministic task lifecycle for a delegated unit (Tier 2, protocol engine).
 *
 * WHY A STATE MACHINE AND NOT BOOLEAN FLAGS. The lifecycle has one terminal fork and one retry loop,
 * and every defect this repository has paid for in that shape was a flag that could be set in an
 * order nobody intended: a unit marked COMPLETED while a retry was in flight, a timeout arriving
 * after completion, a failure that reset the attempt counter. A table of legal transitions makes
 * those states unrepresentable rather than merely unvisited, and it makes the audit trail a
 * byproduct: every accepted transition is recorded with the time and attempt that produced it.
 *
 * DETERMINISM IS A PARAMETER, NOT A PROMISE. `now` is supplied by the caller on every transition and
 * the retry delay comes from an injected `computeDelay`. Nothing in this module reads a clock, a
 * random source, or process state, so the same call sequence always produces the same snapshot and
 * the same transitions -- which is what lets the loopback suite assert an exact trail rather than an
 * approximate shape.
 *
 * THE BACKOFF IS INJECTED AND CONSUMED, NOT REIMPLEMENTED. `tools/exponential-backoff.ts` is the
 * attested implementation of the delay curve; this engine calls `computeDelay(completedAttempt - 1)`
 * so the FIRST retry waits the base delay, exactly as that contract defines attempt 0. Tier 2 may
 * depend on Tier 1 -- the fence enforces that direction and forbids the reverse.
 */
import { ExponentialBackoff } from '../../tools/exponential-backoff.ts';

export type TaskState = 'IDLE' | 'DELEGATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT';

export interface TaskTransition {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly at: number;
  readonly attempt: number;
}

export interface TaskSnapshot {
  readonly state: TaskState;
  readonly attempt: number;
  readonly transitions: readonly TaskTransition[];
}

export interface FailureOutcome {
  readonly state: TaskState;
  readonly retryDelayMs: number | null;
}

export interface TaskStateMachineOptions {
  /** Anything exposing `computeDelay(attempt: number): number`; the attested backoff is the default. */
  backoff?: Pick<ExponentialBackoff, 'computeDelay'>;
  /** How many failed attempts are tolerated before the unit settles as FAILED. Default 3. */
  maxAttempts?: number;
}

/** Transitions the machine will accept. Anything absent is refused, terminal states included. */
const LEGAL: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  IDLE: Object.freeze(['DELEGATED']),
  DELEGATED: Object.freeze(['RUNNING']),
  RUNNING: Object.freeze(['COMPLETED', 'TIMED_OUT', 'DELEGATED', 'FAILED']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  TIMED_OUT: Object.freeze([]),
});

export class TaskStateMachine {
  #state: TaskState = 'IDLE';
  #attempt = 0;
  #maxAttempts: number;
  #backoff: Pick<ExponentialBackoff, 'computeDelay'>;
  #transitions: TaskTransition[] = [];

  constructor(options: TaskStateMachineOptions = {}) {
    const { backoff = new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: 30000 }), maxAttempts = 3 } = options;
    if (!backoff || typeof backoff.computeDelay !== 'function') {
      throw new TypeError('backoff must expose computeDelay(attempt)');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    this.#backoff = backoff;
    this.#maxAttempts = maxAttempts;
  }

  get state(): TaskState {
    return this.#state;
  }

  get attempt(): number {
    return this.#attempt;
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /** A frozen copy: mutating it cannot reach the machine, and the machine cannot reach it. */
  snapshot(): TaskSnapshot {
    const transitions = this.#transitions.map((t) => Object.freeze({ ...t }));
    return Object.freeze({
      state: this.#state,
      attempt: this.#attempt,
      transitions: Object.freeze(transitions),
    });
  }

  delegate(now: number): TaskSnapshot {
    return this.#move('DELEGATED', now);
  }

  start(now: number): TaskSnapshot {
    return this.#move('RUNNING', now);
  }

  complete(now: number): TaskSnapshot {
    return this.#move('COMPLETED', now);
  }

  timeout(now: number): TaskSnapshot {
    return this.#move('TIMED_OUT', now);
  }

  /**
   * Record a failed attempt. A unit with attempts left returns to DELEGATED with the delay the
   * backoff computes for the attempt just completed; the last one settles as FAILED with no delay.
   */
  fail(now: number): FailureOutcome {
    this.#requireAttempt(now);
    if (this.#state !== 'RUNNING') {
      throw new Error('TASK_ILLEGAL_TRANSITION: fail() from ' + this.#state + ' is not a running attempt');
    }
    this.#attempt += 1;
    if (this.#attempt >= this.#maxAttempts) {
      this.#transition('FAILED', now);
      return Object.freeze({ state: this.#state, retryDelayMs: null });
    }
    // Attempts are zero-indexed in the backoff contract: the first retry waits attempt 0's delay.
    const retryDelayMs = this.#backoff.computeDelay(this.#attempt - 1);
    this.#transition('DELEGATED', now);
    return Object.freeze({ state: this.#state, retryDelayMs });
  }

  #move(to: TaskState, now: number): TaskSnapshot {
    this.#requireAttempt(now);
    const legal = LEGAL[this.#state];
    if (!legal.includes(to)) {
      throw new Error('TASK_ILLEGAL_TRANSITION: ' + this.#state + ' -> ' + to + ' is not a legal transition');
    }
    this.#transition(to, now);
    return this.snapshot();
  }

  #transition(to: TaskState, now: number): void {
    this.#transitions.push(Object.freeze({ from: this.#state, to, at: now, attempt: this.#attempt }));
    this.#state = to;
  }

  #requireAttempt(now: number): void {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new RangeError('now must be a finite number (milliseconds)');
    }
  }
}
