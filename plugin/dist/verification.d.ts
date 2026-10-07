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
export interface VerificationPolicy {
    mode: 'ask' | 'allow' | 'deny';
    allowlist: string[];
    allowInProcessFallback: boolean;
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
}): TestResults;
