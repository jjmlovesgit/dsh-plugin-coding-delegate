"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_CONTEXT_WINDOW_LINES = void 0;
exports.parseFailureLocations = parseFailureLocations;
exports.retryContextRequests = retryContextRequests;
/**
 * The half-window, in lines, taken either side of a reported failure.
 *
 * A failure is a line, but the cause is usually a few lines up -- an import, a signature, a branch. Ten
 * is enough to cover that and small enough that several files still fit the injection budget.
 */
exports.RETRY_CONTEXT_WINDOW_LINES = 10;
// Greedy on the path so the LAST two numeric segments win. `C:\src\a.ts:12:5` has three colons in it, and
// reading the first would make the drive letter look like a line number.
const LOCATION_WITH_COLUMN = /^(.*):(\d+):(\d+)$/;
const LOCATION_WITHOUT_COLUMN = /^(.*):(\d+)$/;
/**
 * The usable locations in a failure list. A failure without one is skipped rather than guessed at: a
 * wrong path costs a wasted read, and a wrong line costs a misleading window.
 */
function parseFailureLocations(failures) {
    if (!Array.isArray(failures))
        return [];
    const locations = [];
    for (const failure of failures) {
        const location = typeof failure?.location === 'string' ? failure.location.trim() : '';
        if (!location)
            continue;
        const withColumn = LOCATION_WITH_COLUMN.exec(location);
        const match = withColumn ?? LOCATION_WITHOUT_COLUMN.exec(location);
        if (!match)
            continue;
        const path = match[1].trim();
        const line = Number(match[2]);
        if (!path || !Number.isInteger(line) || line < 1)
            continue;
        locations.push({ path, line });
    }
    return locations;
}
/**
 * One window per file, covering every failure reported in it.
 *
 * Per file rather than per failure, because injecting the same file twice would spend the byte budget
 * twice for the same bytes. The window spans the earliest and latest reported lines, so two failures far
 * apart in one file produce one request that covers both.
 */
function retryContextRequests(locations, windowLines = exports.RETRY_CONTEXT_WINDOW_LINES) {
    const window = Number.isInteger(windowLines) && windowLines >= 0 ? windowLines : exports.RETRY_CONTEXT_WINDOW_LINES;
    const spans = new Map();
    for (const location of locations ?? []) {
        if (!location || typeof location.path !== 'string' || !location.path)
            continue;
        if (!Number.isInteger(location.line) || location.line < 1)
            continue;
        const prior = spans.get(location.path);
        if (!prior)
            spans.set(location.path, { min: location.line, max: location.line });
        else
            spans.set(location.path, {
                min: Math.min(prior.min, location.line),
                max: Math.max(prior.max, location.line),
            });
    }
    const requests = [];
    for (const [path, span] of spans) {
        requests.push({
            path,
            startLine: Math.max(1, span.min - window),
            endLine: span.max + window,
        });
    }
    return requests;
}
