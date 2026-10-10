import type { DelegatedRecord } from './contracts';
/**
 * Tools that read a file's contents into the caller's context. Exported because `describeSourceRead`
 * asks the same question — is this tool a read? — and two lists would drift.
 */
export declare const READ_TOOLS: Set<string>;
/**
 * Search tools return file content, so the read gate has to treat them as reads. This is the read
 * gate's copy of the vocabulary `READ_ONLY_INSPECTORS` already carries for the write guard: a tool
 * which reads files in one guard and is invisible in the other is how rule 3 was bypassed — an agent
 * was refused by the read guard and read the same files with search.
 */
export declare const SEARCH_TOOLS: Set<string>;
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
/**
 * Normalise one shell token to a bare program name.
 *
 * The extension strip has to match everywhere a program is recognised, or an alias is half-known: the
 * prefilter compared raw lowercased tokens while `commandReadsContent` and `isReadArgument` both
 * stripped `.exe`/`.cmd`/`.bat`/`.ps1`, so `gc.ps1` was rejected by the first and accepted by the
 * others. One normaliser, one answer.
 */
export declare function shellCommandName(token: string): string;
/**
 * Does this command READ FILE CONTENT, rather than list, test or compare?
 *
 * `CONTENT_READERS` and only `CONTENT_READERS`. An earlier attempt took the union with
 * `READ_ONLY_INSPECTORS` here and `control-bypass.test.cjs` failed on the very next run: that set
 * exists to answer "is this token read as data rather than invoked", which is a *different* question,
 * and it carries `ls`, `get-childitem`, `test-path`, `stat` and friends. Treating those as byte
 * readers is the false positive the two-set split was introduced to remove.
 *
 * Note what this predicate is NOT responsible for. A metadata command passes the prefilter and then
 * correctly reports "does not read content" here, so it is allowed -- which is why the prefilter
 * cannot use this set as its membership test without also un-gating nothing. See the read gate.
 */
export declare function commandReadsContent(command: string): boolean;
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
export interface SettledVerdict {
    allowed: boolean;
    reason: string;
}
/**
 * Is this delegated file settled -- written by a unit that passed, with its content unchanged since?
 *
 * `succeeded` alone is not the test, because a verdict describes CONTENT. A file that passed and was then
 * edited is not the version anything verified, so the hash is compared too, and a file that cannot be
 * hashed fails closed rather than open. Pure and exported so the rule is testable without a registry.
 */
export declare function evaluateSettledFile(record: DelegatedRecord | undefined, currentHash: string | null): SettledVerdict;
/**
 * Where the TYPE SKELETON for a source file lives, relative to a declarations root.
 *
 * This is the mapping that lets a read be served as declarations instead of implementation. It is a pure
 * string transform on purpose: the caller decides whether the result exists, because a mapping function
 * that silently invents a path is worse than one that returns the path it computed and lets the caller
 * refuse.
 *
 * Returns null for anything that is not a TypeScript or JavaScript source file, so a caller can treat null
 * as "this read is out of scope" rather than as a failure.
 *
 * The transform mirrors what `tsc --declaration --emitDeclarationOnly` emits for a `rootDir` of the source
 * directory: the tree below the root is preserved and only the extension changes.
 */
export declare function declarationPathFor(sourcePath: string, declarationRoot: string): string | null;
/**
 * Is a declaration STALE relative to the source it is supposed to describe?
 *
 * The egress control redirects a source read to `<root>/x.d.ts`. Until this existed it verified only that
 * the file EXISTED, never that it still described the source — so editing an interface and skipping the
 * build served the architect yesterday's signature, and nothing anywhere would have said so. That is the
 * same shape as every false green this repository has caught: healthy under test, because a test suite
 * always runs against a freshly built tree, and wrong exactly when a human is working.
 *
 * Returns a reason when stale, or null when the declaration is fresh OR when either timestamp cannot be
 * read. An unreadable stat deliberately returns null rather than a reason: the caller's next step is to read
 * the declaration, which has its own fail-closed path when that file is missing, and inventing a staleness
 * verdict from a failed stat would report a cause it has not established.
 *
 * WHAT THIS IS NOT: a content digest. mtime is evidence that a rebuild happened after an edit, and a
 * checkout, a `touch`, or clock skew can defeat it. It closes the common case -- an operator planning
 * without running the build -- and it does not prove the declaration corresponds to the source. Binding
 * those two cryptographically is a larger change than this gap warrants, and claiming it here would be the
 * overstatement this file exists to avoid.
 */
export declare function staleDeclarationReason(sourcePath: string, declarationPath: string): string | null;
/**
 * Decide whether a tool call would author source code from the cloud context.
 * Pure and exported so it can be unit-tested without a running server.
 * Returns null when the call has nothing to do with code authoring.
 */
export declare function evaluateCodeWriteGuard(exec: any, config?: {
    askPaths?: string[];
    /** Injectable reader, so the script scan is testable without touching disk. */
    readScript?: (script: string) => string | undefined;
    /** How deep to follow script-invokes-script (default 2). */
    scriptDepth?: number;
    /** Paths a delegated worker wrote; reads of them are gated. Injectable for tests. */
    delegatedPaths?: Iterable<string>;
    /**
     * How to find the record for a delegated file, by canonical path. Injectable so the settled rule can
     * be exercised against synthetic verdicts; the default reads the index the delegation itself wrote.
     */
    delegatedRecordFor?: (canonicalPath: string) => DelegatedRecord | undefined;
    /** ask | allow | deny for reading a delegated file back. Defaults to ask. */
    delegateReadPolicy?: DelegateReadPolicy;
    /** Paths the architect may author as the specification. Defaults to tests/. */
    contractPaths?: string[];
    /** allow | ask | deny for a write to a contract path. Defaults to ask. */
    contractWriteMode?: 'allow' | 'ask' | 'deny';
}): GuardVerdict | null;
