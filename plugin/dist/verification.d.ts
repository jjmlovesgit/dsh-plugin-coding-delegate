/**
 * A failure described without source: enough to diagnose, not enough to leak code.
 */
export interface RedactedFailure {
    kind: 'assertion' | 'compile' | 'timeout' | 'runtime' | 'unknown';
    /** Subtest name, when the runner reports one. */
    name?: string;
    /** file:line or file:line:col. */
    location?: string;
    /** Runner or compiler error code, e.g. TS1434 or ERR_ASSERTION. */
    code?: string;
    /** The assertion label, kept only when it reads as prose rather than code. */
    message?: string;
}
export interface TestResults {
    passed: number;
    failed: number;
    /** Redacted summary. Raw output never leaves the machine by default. */
    output: string;
    errorSummary?: string;
    /** Structured failures: names, locations, error kinds. */
    failures?: RedactedFailure[];
    /** True when the output above was passed through the redactor. */
    redacted?: boolean;
    /** Where the FULL raw output was written locally, for the worker and the operator. */
    rawOutputPath?: string;
}
/**
 * Reduce raw verification output to a source-free structure.
 *
 * Only named fields are ever copied out of a failure block; every other line inside it
 * (stack frames, expected/actual, diff markers, quoted code) is discarded by omission
 * rather than by pattern-matching each leak shape.
 */
export declare function redactVerificationOutput(raw: string): RedactedFailure[];
/** One line per failure: kind, name, location, code, prose message. Never source. */
export declare function describeFailures(failures: RedactedFailure[]): string[];
export declare function parseTestOutput(output: string, exitCode?: number, options?: {
    redact?: boolean;
    rawOutputPath?: string;
}): TestResults;
/**
 * The bound on how long a verification command may run, in milliseconds.
 *
 * 30 s was the value hardcoded inside `runSandboxVerification`, and it is kept as the default so that an
 * operator who configures nothing sees no change. It is exported because it is the answer to "how long
 * do I have?", and previously that answer was only available by reading the source.
 */
export declare const DEFAULT_VERIFICATION_TIMEOUT_MS = 30000;
/**
 * Coerce a configured timeout, falling back to the default rather than to *no bound*.
 *
 * The direction matters. "No timeout" on a command that is model-selected and runs with the DSH
 * process's authority is not a permission, it is a hang — so a value that is not a positive finite
 * number is refused and the default applies. A fractional value is floored to a whole millisecond
 * because that is the unit the spawn takes.
 */
export declare function resolveVerificationTimeoutMs(value: unknown): number;
export interface VerificationPolicy {
    mode: 'ask' | 'allow' | 'deny';
    allowlist: string[];
    allowInProcessFallback: boolean;
    /**
     * How long the verification command may run. Never absent: there is always a bound, because the
     * alternative is a command that never returns.
     */
    timeoutMs: number;
    /**
     * The PROJECT's own check -- a build, a full suite -- run after the unit's contract, and given the
     * power to void an otherwise passing unit.
     *
     * Operator configuration rather than model input. That is why it is deliberately absent from the tool
     * schema and is not put through the approval seam: the operator wrote this string in their profile
     * patch, exactly as they would write it in CI, so there is nothing for them to approve that they did
     * not already write. `runVerification` is model-selected and is gated for precisely that reason.
     *
     * It exists because every other check in this plugin is per unit: `contractFiles` judges one unit's
     * tests, verification runs one unit's command, and nothing asks whether the tree still works.
     */
    coherenceVerification?: string;
}
export declare const DEFAULT_VERIFICATION_POLICY: VerificationPolicy;
/** The program a shell command would run, normalised for allowlist comparison. */
export declare function commandProgram(command: string): string;
/**
 * Decide whether a model-supplied verification command may run. Pure, so the policy is
 * testable without a server or an approval seam. `runVerification` is model-selected and
 * executes with the DSH process's full authority, so silence is never consent: anything
 * not explicitly permitted resolves to `ask`, and `ask` with no approver available is a
 * refusal at the call site.
 */
export declare function evaluateVerificationPolicy(command: string, policy?: VerificationPolicy): {
    kind: 'allow' | 'ask' | 'deny';
    program: string;
    reason: string;
};
export declare function runInProcessFallback(cmd: string, workspaceDir: string): string;
export declare function runSandboxVerification(verificationCommand: string, workspaceDir?: string, options?: {
    redact?: boolean;
    rawLogPath?: string;
    allowInProcessFallback?: boolean;
    /** Overrides the default bound; an unusable value falls back to it rather than removing it. */
    timeoutMs?: number;
}): TestResults;
