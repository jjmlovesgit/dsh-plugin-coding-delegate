/**
 * sha256 of a file, or null when it cannot be read. Callers treat null as a failure rather than as
 * absence: a contract file that vanished is a violation, not an empty string.
 */
export declare function sha256File(filePath: string): string | null;
/**
 * Resolve the architect's declared contract paths against the workspace. Names only: the architect
 * never supplies contents, and the resolved list is what the worker is forbidden to write.
 */
export declare function resolveContractFiles(files: string[] | undefined, baseDir: string): string[];
/** Keyed by canonical path so two spellings of one file cannot pass as two files. */
export declare function contractFileHashes(paths: Iterable<string>): Record<string, string | null>;
/**
 * Anything that changed a declared file during a unit invalidates the verdict, whatever the tests
 * then reported. A missing declaration is reported too, because failing closed is the only safe
 * reading of "the architect declared a contract file that is not there".
 */
export declare function contractViolations(before: Record<string, string | null>, after: Record<string, string | null>): string[];
/**
 * The read guard's memory of what a delegated worker wrote, and its bound.
 *
 * It is exported because the guard and the plugin's startup both add to it: a module that owns the
 * registry cannot own the set as well without an accessor for each caller, and the set is the
 * registry's state, not the guard's.
 */
export declare const delegatedPaths: Set<string>;
export declare const DELEGATED_PATH_LIMIT = 500;
/**
 * The record for a delegated file, by canonical path. `undefined` means no verdict covers it, and the
 * guard has to read that as unsettled rather than as a pass.
 */
export declare function lookupDelegatedRecord(canonicalPath: string): DelegatedRecord | undefined;
/**
 * What a unit's verification said about the content it wrote.
 *
 * `UNIT_UNVERIFIED` is the honest third answer: a delegated edit whose contract was never checked is
 * neither a pass nor a failure. Only `UNIT_PASSED` has had its content checked, so every other value
 * must be read as unsettled.
 *
 * There are two routes to it, and a record does not say which was taken. The common one is that no
 * verification command was supplied at all. The other is that a command was supplied and the gate
 * stopped it -- typically approval was refused, and nothing ran. The first is an absence of evidence
 * and the second is a decision not to gather any, but both leave the content exactly as unestablished,
 * which is the only thing this field is for. Consumers must therefore word their explanations in terms
 * of the contract that went unchecked rather than of whether a command was written down.
 *
 * `UNIT_FLAKY` is the fourth answer, and it exists because the first three are unsafe for a
 * NON-DETERMINISTIC oracle. A property test or a concurrency harness can pass a broken implementation
 * on a run where the defect simply did not trigger, and `UNIT_PASSED` is what makes a file settled --
 * so the old three-state taxonomy could promote a race condition into the codebase and present it as
 * verified work. That is the most dangerous output this plugin can emit, and it is silent.
 *
 * A flaky verdict is a statement about the ORACLE, not about the code: the contract disagreed with
 * itself across repeated runs, so nothing has been established about the content either way. It is not
 * a pass, it does not settle the file, and the reason names the oracle rather than the implementation.
 */
export type DelegatedOutcome = 'UNIT_PASSED' | 'UNIT_FAILED' | 'UNIT_UNVERIFIED' | 'UNIT_FLAKY';
/** One delegated file as it is persisted: where it is, and what was written there. */
export interface DelegatedRecord {
    path: string;
    sha256: string | null;
    at: number;
    /**
     * How the worker touched this file. `created` means it produced the whole thing and the architect has
     * never seen it, so reading it back is the thing rule 3 forbids. `patched` means it changed part of a
     * file the architect already had -- the architect must stay able to read that, or iterating on an
     * existing file becomes impossible the moment a patch to it has been delegated once.
     */
    mode: 'created' | 'patched';
    /**
     * The verdict of the delegation that last wrote this file, and when it was reached. Absent means no
     * verdict covers the content in the record: nothing has verified it yet, or the file was rewritten
     * since and the content the verdict described is gone.
     */
    outcome?: DelegatedOutcome;
    succeeded?: boolean;
    verdictAt?: number;
}
export declare function resolveDelegatedRegistryPath(): string;
/**
 * Parse a registry file. Anything unreadable, malformed, or entry-shaped-but-wrong yields no records
 * rather than an exception: a corrupt registry must never be able to stop the plugin loading.
 */
export declare function parseDelegatedRegistry(text: string): DelegatedRecord[];
/**
 * Newest wins per path, and the oldest fall off the end once the limit is reached. The hash is not
 * used to relax anything — a delegated file stays protected however it later changes — it makes the
 * record answerable, and gives the prune below something to reason about.
 */
export declare function mergeDelegatedRecords(existing: DelegatedRecord[], incoming: DelegatedRecord[], limit?: number): DelegatedRecord[];
/** A path whose file is gone protects nothing, so it is dropped. */
export declare function pruneDelegatedRecords(records: DelegatedRecord[], exists?: (p: string) => boolean): DelegatedRecord[];
/** Best effort by design: failing to persist must not fail a delegation that was already paid for. */
export declare function saveDelegatedRegistry(records: DelegatedRecord[]): boolean;
/** Load, validate and prune. Called at startup so a restart does not forget what was delegated. */
export declare function loadDelegatedRegistry(): DelegatedRecord[];
export declare function rememberDelegated(paths: string[], mode?: 'created' | 'patched'): void;
/**
 * Stamp a unit's verdict onto the registry records for the files that unit wrote.
 *
 * A delegation writes the registry before its verification has run, so the record it creates cannot
 * carry the verdict. This is the second half of that write, and the only thing that joins a per-file
 * sha256 to a per-unit verdict -- without it "is this file settled?" has no answer, and the read guard
 * has to ask about every delegated file for ever.
 *
 * Best effort, for the same reason the first half is: failing to persist must not fail a delegation that
 * was already paid for, and an absent stamp reads as "no verdict", which is the conservative answer
 * rather than a permissive one. Returns how many records were stamped, so a caller can tell a no-op
 * from a write.
 */
export declare function recordDelegatedOutcome(paths: string[], outcome: DelegatedOutcome, succeeded: boolean, at?: number): number;
