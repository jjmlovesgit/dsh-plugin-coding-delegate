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
import { type Result } from '../primitives/result';
export type TerminalState = 'CONTRACT_MODIFIED' | 'VERIFICATION_NOT_APPROVED' | 'FLAKY' | 'INCOHERENT' | 'VERIFICATION_FAILED' | 'UNVERIFIED' | 'SUCCESS';
export type TaskState = 'DRAFT' | 'DISPATCHED' | 'EVALUATING' | TerminalState;
/** The six inputs the verdict is decided from — the same shape `resolveDelegateStatus` takes. */
export interface EvaluationPayload {
    readonly contractViolationsFound: boolean;
    readonly verificationGatePassed: boolean;
    readonly flaky: boolean;
    readonly coherenceFailed: boolean;
    readonly unverified: boolean;
    readonly isSuccess: boolean;
}
export type TaskEvent = {
    readonly type: 'DISPATCH';
} | {
    readonly type: 'REFUSE';
} | {
    readonly type: 'BEGIN_EVALUATION';
} | {
    readonly type: 'EVALUATE';
    readonly payload: EvaluationPayload;
};
export type ProtocolErrorCode = 'ILLEGAL_TRANSITION' | 'UNKNOWN_STATE' | 'UNKNOWN_EVENT';
export interface ProtocolError {
    readonly code: ProtocolErrorCode;
    readonly state: string;
    readonly event: string;
    readonly message: string;
}
export declare const TERMINAL_STATES: ReadonlySet<TaskState>;
export declare function isTerminal(state: TaskState): boolean;
/** The lattice, as code: the first true condition wins, and the order IS the contract. */
export declare function resolveVerdict(payload: EvaluationPayload): TerminalState;
/**
 * How a verdict is projected into the ledger's coarser vocabulary.
 *
 * BEHAVIOUR-PRESERVING, DELIBERATELY. The naive projection — "anything that is not SUCCESS, FLAKY or
 * UNVERIFIED is UNIT_FAILED" — would change two ledger outcomes that the existing code got right:
 *
 *   INCOHERENT        the UNIT passed and the PROJECT failed. The registry records the unit's own
 *                     result, so it stays UNIT_PASSED; reporting UNIT_FAILED would say the worker's
 *                     work failed when the tree did.
 *   VERIFICATION_NOT_APPROVED  nothing ran. That is absence of evidence, not evidence of failure, and
 *                     the registry already calls it UNIT_UNVERIFIED.
 *
 * `OPERATOR_ATTESTED` is NOT here on purpose: it is a human signing event that happens after this
 * cycle has ended, and no execution path may reach it.
 */
export type DelegatedOutcomeProjection = 'UNIT_PASSED' | 'UNIT_FAILED' | 'UNIT_UNVERIFIED' | 'UNIT_FLAKY';
export declare function projectOutcome(verdict: TerminalState): DelegatedOutcomeProjection;
/**
 * Apply one event. Returns the next state, or an `Err` naming why the move was refused.
 *
 * A payload-free transition out of EVALUATING is refused, and so is an `EVALUATE` anywhere else: the
 * verdict can only be reached by evaluating, and evaluation can only happen once dispatched.
 */
export declare function transition(state: TaskState, event: TaskEvent): Result<TaskState, ProtocolError>;
