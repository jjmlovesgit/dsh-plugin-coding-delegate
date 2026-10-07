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
export declare function extractAndEmitFiles(content: string, targetFilesHint?: string[] | string, baseDir?: string, allowedRoots?: string[], protectedPaths?: string[]): {
    filesWritten: FileEmissionResult[];
    errors: string[];
    cleanContent: string;
};
