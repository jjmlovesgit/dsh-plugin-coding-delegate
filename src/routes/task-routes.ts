/**
 * Route adapter for the task engine (Tier 3, imperative shell).
 *
 * This is the first production file under `src/routes/`, and its shape is a deliberate test of the
 * Tier 3 ratchets rather than an accident of style: one job per function, a switch instead of a
 * dispatch table of closures, and no function anywhere near the 40-line ceiling. If the ceiling ever
 * forces boilerplate here, that is a signal about the policy and should be argued then -- not
 * silently exempted now.
 *
 * THE ADAPTER DOES NOT LET ENGINE ERRORS ESCAPE. `TaskStateMachine` throws on an illegal transition
 * and on a malformed timestamp; a route that let those propagate would turn a caller's mistake into
 * a 500. Mapping is explicit and narrow: 409 for a lifecycle violation (the request was well-formed
 * and the machine refused it), 400 for an argument the contract rejects, 500 for anything else --
 * because an unexpected error is ours, not theirs.
 *
 * INWARD IMPORTS ARE ALLOWED AND OUTWARD ONES ARE NOT. Tier 3 may depend on Tier 2, which is why
 * this file imports the engine directly; the fence forbids the reverse, and the specifier carries
 * its `.ts` extension because Node's type stripping resolves it literally.
 */
import { TaskStateMachine } from '../engine/task-state-machine.ts';

export interface RouteResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const ACTIONS = ['delegate', 'start', 'complete', 'timeout', 'fail'] as const;

export type TaskAction = (typeof ACTIONS)[number];

export interface TaskTransitionRequest {
  readonly action?: unknown;
  readonly now?: unknown;
}

function isAction(value: unknown): value is TaskAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** The current lifecycle state, serialized for a caller. */
export function handleGetSnapshot(machine: TaskStateMachine): RouteResponse {
  const snapshot = machine.snapshot();
  return {
    status: 200,
    body: {
      state: snapshot.state,
      attempt: snapshot.attempt,
      maxAttempts: machine.maxAttempts,
      transitions: snapshot.transitions.length,
    },
  };
}

/** One transition, with the engine's verdict flattened into a response shape. */
function applyAction(machine: TaskStateMachine, action: TaskAction, now: number): RouteResponse {
  const outcome =
    action === 'fail'
      ? machine.fail(now)
      : action === 'delegate'
        ? machine.delegate(now)
        : action === 'start'
          ? machine.start(now)
          : action === 'complete'
            ? machine.complete(now)
            : machine.timeout(now);
  const retryDelayMs = 'retryDelayMs' in outcome ? outcome.retryDelayMs : null;
  return { status: 200, body: { state: outcome.state, retryDelayMs } };
}

function mapError(error: unknown): RouteResponse {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith('TASK_ILLEGAL_TRANSITION')) {
    return { status: 409, body: { error: 'ILLEGAL_TRANSITION', detail } };
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return { status: 400, body: { error: 'INVALID_ARGUMENT', detail } };
  }
  return { status: 500, body: { error: 'INTERNAL', detail } };
}

/** Validate, dispatch, and translate; never throws. */
export function handleTaskTransition(machine: TaskStateMachine, request: TaskTransitionRequest = {}): RouteResponse {
  if (!isAction(request.action)) {
    return { status: 400, body: { error: 'UNKNOWN_ACTION', action: request.action === undefined ? null : request.action } };
  }
  if (typeof request.now !== 'number' || !Number.isFinite(request.now)) {
    return { status: 400, body: { error: 'INVALID_TIMESTAMP' } };
  }
  try {
    return applyAction(machine, request.action, request.now);
  } catch (error) {
    return mapError(error);
  }
}
