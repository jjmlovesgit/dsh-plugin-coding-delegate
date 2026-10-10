/**
 * The wiring for declarations-mode egress control, kept out of `index.ts` on purpose.
 *
 * WHY THIS MODULE EXISTS. The control was first written inline in `index.ts`'s
 * `tools/post-execute` handler, and it only ever inspected READ_TOOLS -- so a search or a shell command
 * returned raw implementation bodies to the architect with nothing looking at them. Extending the
 * inline handler meant a large, multi-region edit in the plugin's largest file. Extracting the decision
 * to here makes the call site two lines and leaves the classification, the argument extraction and the
 * dispatch testable without a host.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not serve declarations for READS. `index.ts` already does
 * that, and its read branch does two things this module must not bypass --
 *
 *   1. it refuses a STALE declaration (`staleDeclarationReason`), so the architect cannot be served
 *      yesterday's signature while believing it is current, and
 *   2. it prefixes the served text with the "SERVED AS TYPE DECLARATIONS, NOT SOURCE" banner that
 *      `egress-guard.test.cjs` asserts on.
 *
 * So a read returns null here and falls through to the path that is already covered by tests. Only the
 * two routes that can act on nothing except by refusing -- search and shell -- are handled below.
 */
export interface PostExecuteExec {
    name?: string;
    arguments?: Record<string, unknown>;
}
export interface PostExecuteOptions {
    sourceReadEgress?: string;
    declarationRoot?: string;
}
export interface EgressHookResult {
    kind: 'accept';
    content: Array<{
        type: 'text';
        text: string;
    }>;
}
/**
 * Decide whether this tool call may return its output under declarations mode.
 *
 * Returns a replacement decision when the call must be refused, or null when it may proceed. A null is
 * the caller's signal to keep going, which is why every pass-through path returns null rather than a
 * decision: the handler's contract is (exec, result, next) => decision, and a decision invented here
 * would replace the tool's real output with nothing.
 */
export declare function handleDeclarationPostExecute(exec: PostExecuteExec, options?: PostExecuteOptions): EgressHookResult | null;
