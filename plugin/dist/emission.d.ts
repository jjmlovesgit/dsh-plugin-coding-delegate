export interface FileEmissionResult {
    path: string;
    relativeName: string;
    lines: number;
    bytes: number;
    /** How the change arrived: a whole file, or a delta against the file already there. */
    mode?: 'write' | 'patch';
    /** Search/replace blocks applied, when the emission was a patch. */
    hunks?: number;
}
/** A delta block: the bytes to find, and what to put there instead. */
export interface SearchReplaceBlock {
    search: string;
    replace: string;
}
/** Called once by the composition root, which holds both halves of the delta machinery. */
export declare function configurePatchEngine(engine: {
    parse: (body: string) => SearchReplaceBlock[] | null;
    apply: (content: string, blocks: SearchReplaceBlock[]) => {
        ok: boolean;
        content?: string;
        reason?: string;
    };
}): void;
/**
 * The containment decision for one delegated write. `baseDir` is the session workspace
 * and `allowedRoots` is the operator's explicit extension list. Both sides are
 * canonicalised, so a symlink inside the workspace cannot be used to escape it.
 */
export declare function evaluateEmissionPath(resolvedPath: string, baseDir: string, allowedRoots?: string[]): {
    allowed: boolean;
    reason?: string;
};
/**
 * The scope decision for one delegated write: is this path one the unit declared?
 *
 * `targetFiles` used to be entirely passive — it became prompt text and it chose a fallback path when a
 * fenced block named no file of its own — so a unit told to change one file could rewrite another, and
 * nothing refused it, reported it, or noticed. That is the precondition for two units disagreeing, and it
 * lands strictly before any project-level check could see it.
 *
 * A declared directory covers its subtree, because `isPathWithin` counts a path as within itself or
 * beneath it. That makes `src`, `src/` and an exact file name all usable declarations, with one rule.
 *
 * An empty or absent declaration constrains nothing. A unit that declared no targets has not exceeded
 * them, and refusing everything for an empty list would break every caller that never set the field.
 */
export declare function evaluateUnitScope(resolvedPath: string, declaredTargets: string[] | string | undefined, baseDir: string): {
    allowed: boolean;
    reason?: string;
};
/**
 * Parse the model's final content into file emissions and write them to disk.
 *
 * The model may emit either whole files (fenced code blocks with a file path in the
 * header) or search/replace patch blocks. This function handles both, writes the
 * resulting files under the workspace root, and returns a per-file summary plus any
 * errors encountered.
 *
 * `content` is the raw model output. `workspaceRoot` is the directory all emissions
 * are anchored to. `parseSearchReplaceBlocks` and `applySearchReplaceBlocks` are the
 * delta machinery, injected so this module does not import the composition root back.
 */
export declare function extractAndEmitFiles(content: string, targetFilesHint?: string[] | string, baseDir?: string, allowedRoots?: string[], protectedPaths?: string[], options?: {
    enforceUnitScope?: boolean;
}): {
    filesWritten: FileEmissionResult[];
    errors: string[];
    cleanContent: string;
};
