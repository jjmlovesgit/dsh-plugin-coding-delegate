"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_STATES = void 0;
exports.isTerminal = isTerminal;
exports.resolveVerdict = resolveVerdict;
exports.projectOutcome = projectOutcome;
exports.transition = transition;
/**
 * The unit's execution lifecycle, terminating in one of the seven verdicts that
 * `resolveDelegateStatus` already emits.
 *
 * WHY THE VERDICT VOCABULARY AND NOT THE REGISTRY ONE. `DelegatedOutcome` (`UNIT_PASSED`,
 * `UNIT_FAILED`, …) is a projection for ledger consumers: it collapses `CONTRACT_MODIFIED`,
 * `VERIFICATION_NOT_APPROVED`, `INCOHERENT` and `VERIFICATION_FAILED` into one bucket, and it carries
 * `OPERATOR_ATTESTED`, which is a human signing event that happens after this cycle has ended. A
 * machine built on it could not tell a boundary breach from an assertion failure. The seven verdicts
 * are how the cycle actually terminates, so they are what the machine terminates in.
 *
 * THE ONE MAPPING THAT IS NOT VERBATIM. A refusal before dispatch (`CONTEXT_REFUSED` at the tool
 * boundary) is not a verdict, because no worker ran and nothing was evaluated. It terminates as
 * `VERIFICATION_NOT_APPROVED`, which is the verdict that already means "nothing ran, so the outcome is
 * unknown" — the same claim, made by the same rule.
 *
 * THE LATTICE IS THE SPECIFICATION, and `resolveVerdict` is its executable form. Order:
 * boundary breach > nothing ran > flaky oracle > project coherence > absence of evidence > success.
 */
const result_1 = require("../primitives/result");
exports.TERMINAL_STATES = new Set([
    'CONTRACT_MODIFIED',
    'VERIFICATION_NOT_APPROVED',
    'FLAKY',
    'INCOHERENT',
    'VERIFICATION_FAILED',
    'UNVERIFIED',
    'SUCCESS',
]);
const STATES = new Set([
    'DRAFT',
    'DISPATCHED',
    'EVALUATING',
    ...exports.TERMINAL_STATES,
]);
const EVENT_TYPES = new Set([
    'DISPATCH',
    'REFUSE',
    'BEGIN_EVALUATION',
    'EVALUATE',
]);
/** The two edges that do not depend on a payload. `EVALUATE` is computed by `resolveVerdict`. */
const TRANSITIONS = new Map([
    ['DRAFT:DISPATCH', 'DISPATCHED'],
    ['DRAFT:REFUSE', 'VERIFICATION_NOT_APPROVED'],
    ['DISPATCHED:BEGIN_EVALUATION', 'EVALUATING'],
]);
function isTerminal(state) {
    return exports.TERMINAL_STATES.has(state);
}
/** The lattice, as code: the first true condition wins, and the order IS the contract. */
function resolveVerdict(payload) {
    if (payload.contractViolationsFound)
        return 'CONTRACT_MODIFIED';
    if (!payload.verificationGatePassed)
        return 'VERIFICATION_NOT_APPROVED';
    if (payload.flaky)
        return 'FLAKY';
    if (payload.coherenceFailed)
        return payload.isSuccess ? 'INCOHERENT' : 'VERIFICATION_FAILED';
    if (payload.unverified)
        return 'UNVERIFIED';
    return payload.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED';
}
function projectOutcome(verdict) {
    if (verdict === 'FLAKY')
        return 'UNIT_FLAKY';
    if (verdict === 'VERIFICATION_NOT_APPROVED' || verdict === 'UNVERIFIED')
        return 'UNIT_UNVERIFIED';
    if (verdict === 'SUCCESS' || verdict === 'INCOHERENT')
        return 'UNIT_PASSED';
    return 'UNIT_FAILED';
}
/**
 * Apply one event. Returns the next state, or an `Err` naming why the move was refused.
 *
 * A payload-free transition out of EVALUATING is refused, and so is an `EVALUATE` anywhere else: the
 * verdict can only be reached by evaluating, and evaluation can only happen once dispatched.
 */
function transition(state, event) {
    const type = event?.type;
    if (!STATES.has(state)) {
        return (0, result_1.Err)({ code: 'UNKNOWN_STATE', state: String(state), event: String(type), message: 'unknown state' });
    }
    if (!type || !EVENT_TYPES.has(type)) {
        return (0, result_1.Err)({ code: 'UNKNOWN_EVENT', state: String(state), event: String(type), message: 'unknown event' });
    }
    if (type === 'EVALUATE') {
        if (state !== 'EVALUATING') {
            return (0, result_1.Err)({
                code: 'ILLEGAL_TRANSITION',
                state,
                event: type,
                message: state + ' cannot be evaluated: evaluation happens after dispatch, once',
            });
        }
        return (0, result_1.Ok)(resolveVerdict(event.payload));
    }
    const next = TRANSITIONS.get(state + ':' + type);
    if (next === undefined) {
        return (0, result_1.Err)({
            code: 'ILLEGAL_TRANSITION',
            state,
            event: type,
            message: state + ' has no transition for ' + type,
        });
    }
    return (0, result_1.Ok)(next);
}
