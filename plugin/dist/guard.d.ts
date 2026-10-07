/**
 * Tools that read a file's contents into the caller's context. Exported because `describeSourceRead`
 * asks the same question — is this tool a read? — and two lists would drift.
 */
export declare const READ_TOOLS: Set<string>;
export interface GuardVerdict {
    kind: 'deny' | 'ask';
    target: string;
    reason: string;
}
/**
 * The file a tool call names, from whichever argument shape that tool uses. Exported because `apply`
 * passes it to `describeSourceRead`, which asks the same question about the same call.
 */
export declare function extractWriteTarget(args: any): string | undefined;
/**
 * Does this command line carry a write signal? A redirection counts only when it is a
 * real one: an `=>` in inline program text and a `2>&1` must not turn a read-only
 * command into an approval prompt.
 */
export declare function hasCommandWriteSignal(command: string): boolean;
/**
 * Delete-capable constructs, checked against BOTH a command line and a script body.
 * Destroying a source file is at least as consequential as overwriting it, and the first
 * version of this guard left deletion entirely ungated. API-level removals are included
 * because inline program text (`python -c "os.remove(...)"`) never names a verb the
 * command line displays. Word-anchored for the same reason as the write list: unanchored,
 * `rm` matches inside unrelated paths and `Move-Item` matches inside `Remove-Item`.
 */
export declare const DELETE_PRIMITIVES: RegExp;
/** Does this command line or script body carry a delete signal? */
export declare function hasCommandDeleteSignal(text: string): boolean;
export type DelegateReadPolicy = 'ask' | 'allow' | 'deny';
/**
 * What happens when an agent reads a file a delegated worker wrote.
 *
 * The guard cannot yet tell the architect from a lead, so it gates any agent reading delegated code.
 * `ask` is the right default: pulling that code back into the architect's context defeats the point of
 * having delegated it, but reviewing a line is sometimes exactly what an operator wants.
 *
 * `allow` is an escape hatch for a lead tier that has to read the code it writes contracts about. It is
 * an honest weakening of rule 3 rather than a fix, so the reason says which rule it costs — the config
 * entry documents its own price instead of quietly being a bypass.
 */
export declare function evaluateDelegatedReadPolicy(policy?: DelegateReadPolicy): {
    kind: 'allow' | 'ask' | 'deny';
    reason: string;
};
export declare function evaluateCodeWriteGuard(exec: any, config?: {
    askPaths?: string[];
    /** Injectable reader, so the script scan is testable without touching disk. */
    readScript?: (script: string) => string | undefined;
    /** How deep to follow script-invokes-script (default 2). */
    scriptDepth?: number;
    /** Paths a delegated worker wrote; reads of them are gated. Injectable for tests. */
    delegatedPaths?: Iterable<string>;
    /** ask | allow | deny for reading a delegated file back. Defaults to ask. */
    delegateReadPolicy?: DelegateReadPolicy;
    /** Paths the architect may author as the specification. Defaults to tests/. */
    contractPaths?: string[];
    /** allow | ask | deny for a write to a contract path. Defaults to ask. */
    contractWriteMode?: 'allow' | 'ask' | 'deny';
}): GuardVerdict | null;
