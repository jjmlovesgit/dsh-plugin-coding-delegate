/**
 * The unit verdict lifecycle, as a pure transition table.
 *
 * WHAT THIS MODELS, AND WHAT IT DELIBERATELY DOES NOT. It models what happened to a UNIT of delegated
 * work: drafted, dispatched, verified, attested -- or refused, failed, flaked, starved. It does NOT
 * model an attempt: retries, backoff and timeouts belong to `src/engine/task-state-machine.ts`, which
 * already owns them. Two machines describing one process is how a codebase ends up with two meanings
 * for "dispatched", so the split is stated here rather than discovered later.
 *
 * THE STATE NAMES ARE THE SHIPPED STATUS STRINGS. `UNIT_PASSED`, `VERIFICATION_FAILED`,
 * `UNIT_FLAKY` and the rest are what the tool returns to the architect today. A protocol module that
 * invented `BOUND` and `UNBOUND` would need a mapping table back to those strings, and that table
 * would be the drift surface. The one rename is `UNIT_PASSED` -> `VERIFIED`: the attestation step
 * distinguishes "the contract passed" from "a note was signed", which the shipped string conflated.
 * `ATTESTED` is the state that means the unit is finished and signed.
 *
 * ILLEGAL TRANSITIONS ARE VALUES, NOT THROWS. `transition` returns `Result`, and an illegal move is
 * an `Err` the caller must handle. This is the first real consumer of the attested `Result` primitive:
 * a caller that ignores the error gets a compile-time complaint rather than a runtime surprise.
 */
import { Err, Ok, type Result } from '../primitives/result.ts';

export type TaskState =
  | 'DRAFT'
  | 'DISPATCHED'
  | 'CONTEXT_REFUSED'
  | 'VERIFIED'
  | 'VERIFICATION_FAILED'
  | 'UNIT_FLAKY'
  | 'WORKER_OUTPUT_STARVED'
  | 'ERROR'
  | 'ATTESTED';

export type TaskEvent =
  | 'DISPATCH_SUCCESS'
  | 'REFUSE_CONTEXT'
  | 'VERIFY_PASS'
  | 'VERIFY_FAIL'
  | 'VERIFY_FLAKE'
  | 'OUTPUT_EMPTY'
  | 'TRANSPORT_ERROR'
  | 'ATTEST_PASS'
  | 'ATTEST_FAIL';

export type ProtocolErrorCode = 'ILLEGAL_TRANSITION' | 'UNKNOWN_STATE' | 'UNKNOWN_EVENT';

export interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly state: string;
  readonly event: string;
  readonly message: string;
}

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'CONTEXT_REFUSED',
  'VERIFICATION_FAILED',
  'UNIT_FLAKY',
  'WORKER_OUTPUT_STARVED',
  'ERROR',
  'ATTESTED',
]);

const STATES: ReadonlySet<string> = new Set([
  'DRAFT',
  'DISPATCHED',
  'CONTEXT_REFUSED',
  'VERIFIED',
  'VERIFICATION_FAILED',
  'UNIT_FLAKY',
  'WORKER_OUTPUT_STARVED',
  'ERROR',
  'ATTESTED',
]);

const EVENTS: ReadonlySet<string> = new Set([
  'DISPATCH_SUCCESS',
  'REFUSE_CONTEXT',
  'VERIFY_PASS',
  'VERIFY_FAIL',
  'VERIFY_FLAKE',
  'OUTPUT_EMPTY',
  'TRANSPORT_ERROR',
  'ATTEST_PASS',
  'ATTEST_FAIL',
]);

/** The legal edges, as `STATE:EVENT` -> next state. A table is the specification, so it is one. */
const TRANSITIONS: ReadonlyMap<string, TaskState> = new Map([
  ['DRAFT:DISPATCH_SUCCESS', 'DISPATCHED'],
  ['DRAFT:REFUSE_CONTEXT', 'CONTEXT_REFUSED'],
  ['DISPATCHED:VERIFY_PASS', 'VERIFIED'],
  ['DISPATCHED:VERIFY_FAIL', 'VERIFICATION_FAILED'],
  ['DISPATCHED:VERIFY_FLAKE', 'UNIT_FLAKY'],
  ['DISPATCHED:OUTPUT_EMPTY', 'WORKER_OUTPUT_STARVED'],
  ['DISPATCHED:TRANSPORT_ERROR', 'ERROR'],
  ['VERIFIED:ATTEST_PASS', 'ATTESTED'],
  ['VERIFIED:ATTEST_FAIL', 'VERIFICATION_FAILED'],
]);

/** The edge from `state` under `event`, or undefined when the move is not in the table. */
export function nextState(state: TaskState, event: TaskEvent): TaskState | undefined {
  return TRANSITIONS.get(state + ':' + event);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Apply one event. Returns the next state, or an `Err` naming why the move was refused.
 *
 * Unknown states and events are rejected rather than coerced: TypeScript prevents them at compile
 * time, but this module is also callable from JavaScript (the harness, tests, a host embedding it),
 * and a protocol that silently accepts an event it has never heard of is not a protocol.
 */
export function transition(state: TaskState, event: TaskEvent): Result<TaskState, ProtocolError> {
  if (!STATES.has(state)) {
    return Err({ code: 'UNKNOWN_STATE', state: String(state), event: String(event), message: 'unknown state' });
  }
  if (!EVENTS.has(event)) {
    return Err({ code: 'UNKNOWN_EVENT', state: String(state), event: String(event), message: 'unknown event' });
  }
  const next = nextState(state, event);
  if (next === undefined) {
    return Err({
      code: 'ILLEGAL_TRANSITION',
      state: String(state),
      event: String(event),
      message: String(state) + ' has no transition for ' + String(event),
    });
  }
  return Ok(next);
}
