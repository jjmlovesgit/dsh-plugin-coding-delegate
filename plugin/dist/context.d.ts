/** One file the architect wants the worker to see. Names and ranges only, never contents. */
export interface ContextRequest {
    path: string;
    startLine?: number;
    endLine?: number;
}
/**
 * What the architect is told about an injection. Deliberately has no `content` field — the whole
 * point is that the code travels to the worker and does not travel back.
 */
export interface ContextInjection {
    path: string;
    relativeName: string;
    lineRange: {
        start: number;
        end: number;
    } | null;
    lines: number;
    bytes: number;
    sha256: string;
}
export interface ContextResolution {
    injected: ContextInjection[];
    text: string;
    errors: string[];
}
/**
 * Injected context competes with the instruction for the worker's input window, so the budget is a
 * safety bound rather than a caller preference. Over budget refuses; it never truncates quietly,
 * because a worker given half a file answers confidently about a file it only half saw.
 */
export declare const DEFAULT_CONTEXT_MAX_BYTES = 32768;
/**
 * Read the files the architect named and render them for the worker's prompt. Containment matches
 * emission exactly: the same resolution, and the same refusal of escapes and absolute paths outside
 * the root, because reading a file in order to transmit it is an egress route and deserves the same
 * scepticism as writing one.
 */
export declare function resolveContextFiles(requests: ContextRequest[] | undefined, baseDir: string, allowedRoots?: string[], maxBytes?: number): ContextResolution;
