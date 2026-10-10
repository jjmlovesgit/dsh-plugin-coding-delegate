/**
 * All plugin state (debug log, savings ledger) lives under one derived directory.
 * It must never be a hard-coded absolute path: the previous build wrote its log
 * into the plugin author's own project directory on every machine, which was
 * correct on exactly one of them.
 * Precedence: explicit env override, then DSH_HOME, then ~/.dsh.
 */
export declare function resolveDataDir(): string;
/**
 * Remove prompt text from a trace payload before it is written to disk.
 *
 * A debug log outlives the session, and call sites pass a prompt slice into it. No prompt content may
 * be persisted, so the value is replaced with its length rather than scanned for secrets: pattern
 * detection has false negatives, and a replacement is a guarantee where a pattern is a probability.
 * Every other field is preserved, because redaction that succeeds by writing nothing removes the
 * diagnostic value the log exists for.
 *
 * Pure and exported so it is testable directly. The caller's object is not mutated.
 */
export declare function redactTracePayload(data: any): any;
export declare function trace(event: string, data: any): void;
