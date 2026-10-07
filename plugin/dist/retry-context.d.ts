/**
 * Recovery: a failed unit's failure locations become the next attempt's context.
 *
 * The ordinary cause of a unit that "failed for no visible reason" is that the worker was never shown the
 * code it had to change. The architect declares `contextFiles` from its own reading; when that reading is
 * too narrow the worker guesses, and the verdict comes back as a failure that already names the file.
 *
 * That location was being produced and thrown away. `RedactedFailure.location` carries `file:line` or
 * `file:line:col`, `delegateWorker` returns it to the architect, and nothing used it.
 *
 * Recovering it is unusually cheap here, and that is the point: this plugin reads the file and puts it in
 * the WORKER's prompt, while the architect receives metadata only. So the loop can widen the worker's
 * view on a retry without widening the architect's window -- this plugin's own thesis, applied to its own
 * failure path.
 *
 * Two properties the callers must keep, neither of which lives in this file:
 *
 * 1. **Best-effort.** Auto-injected context must never turn a delegation that would have run into a
 *    refusal. An automatic convenience that can fail a unit is worse than no convenience, so the caller
 *    keeps the declared injection unless the widened one resolves cleanly.
 * 2. **Once.** The caller consumes the locations and clears them, so an old failure cannot silently
 *    influence every later unit in the session.
 */
/** Where a failure happened, as the redactor reported it. */
export interface FailureLocation {
    path: string;
    line: number;
}
/**
 * The half-window, in lines, taken either side of a reported failure.
 *
 * A failure is a line, but the cause is usually a few lines up -- an import, a signature, a branch. Ten
 * is enough to cover that and small enough that several files still fit the injection budget.
 */
export declare const RETRY_CONTEXT_WINDOW_LINES = 10;
/**
 * The usable locations in a failure list. A failure without one is skipped rather than guessed at: a
 * wrong path costs a wasted read, and a wrong line costs a misleading window.
 */
export declare function parseFailureLocations(failures: any): FailureLocation[];
/**
 * One window per file, covering every failure reported in it.
 *
 * Per file rather than per failure, because injecting the same file twice would spend the byte budget
 * twice for the same bytes. The window spans the earliest and latest reported lines, so two failures far
 * apart in one file produce one request that covers both.
 */
export declare function retryContextRequests(locations: FailureLocation[], windowLines?: number): Array<{
    path: string;
    startLine: number;
    endLine: number;
}>;
