/**
 * What a declarations-mode egress check decided.
 *
 * `action` and `skeleton` are the field names the committed oracle asserts on
 * (`plugin/tests/oracles/declaration-egress-scope.test.cjs`). They are not `decision`/`declarationPath`:
 * the test file is the frozen contract for this unit, so the implementation follows it rather than the
 * other way round.
 */
export interface DeclarationEgressVerdict {
    action: 'allow' | 'serve-declaration' | 'block';
    skeleton?: string;
    /**
     * The declaration BYTES to serve when a route can only be refused by refusing -- a search, whose
     * output is matched lines from no single file. Structurally identical to `skeleton` in the read
     * branch's terms: `skeleton` names the artefact, this carries it.
     */
    declarationText?: string;
    reason?: string;
}
/** One file a directory or file scope was resolved into, and the declaration that stands for it. */
export interface ResolvedDeclaration {
    source: string;
    skeleton: string;
    exists: boolean;
    text?: string;
    /** A reason the declaration cannot stand for the source, from the injected staleness check. */
    staleReason?: string;
}
export interface DeclarationEgressInput {
    toolKind: 'read' | 'search' | 'shell' | string;
    /** The path argument for a read or a search scope; the command text for a shell command. */
    target: string;
    sourceReadEgress?: 'source' | 'declarations' | string;
    declarationRoot?: string;
    /** Injected so this module does not depend on guard.ts internals. See `mappableSourceFile` below. */
    isCodeExtension?: (filePath: string) => boolean;
    declarationPathFor?: (filePath: string, root?: string) => string | null;
    commandReadsContent?: (cmd: string) => boolean;
    commandNamesSource?: (cmd: string) => boolean;
    /**
     * Is this scope a DIRECTORY rather than a file?
     *
     * WHY THE SEARCH BRANCH NEEDS IT, and what it closes. `isCodeExtension` answers with the scope's
     * extension, and a directory has none -- so `src` came back as "not code" and was allowed. MEASURED
     * against the built artefact before this input existed:
     *
     *     evaluateDeclarationEgress({toolKind:'search', target:'src', ...}) => {"action":"allow"}
     *
     * while `src/guard.ts` in the same tree blocked and `plugin/src/guard.ts` alone holds 167 lines
     * matching an implementation-body test. A search scoped to a directory therefore returned real
     * implementation lines to the context this mode exists to keep them from. An extension test cannot
     * see that, because the thing that makes a directory dangerous is what is UNDER it.
     */
    directoryScope?: (target: string) => boolean;
    /**
     * The source files a scope names, resolved from disk: every file under it when it is a directory,
     * or itself when it is one source file. The empty list means positively resolved and no source
     * beneath. Omitted means the route cannot resolve a scope at all, which fails closed below.
     */
    listSourceFiles?: (scope: string) => string[];
    /** The declaration bytes for one source file, or its absence, plus any injected staleness verdict. */
    readDeclaration?: (sourceFile: string, root?: string) => Omit<ResolvedDeclaration, 'source' | 'skeleton'>;
    /**
     * The SESSION WORKSPACE, which is the base every relative scope is resolved against.
     *
     * WHY THIS IS NOT `declarationRoot`, and why it is not the process cwd. `declarationRoot` is where the
     * built `.d.ts` files live; it says nothing about where the source does. The process cwd is where the
     * host happened to be launched -- and this repository has already paid for that substitution once: the
     * delegated-read gate resolved a relative target against the cwd instead of the workspace and was
     * therefore off in normal use, because the architect names paths relatively essentially always. The
     * same string, the same defect, one module over.
     */
    workspaceRoot?: string;
    /** Does this RESOLVED path exist? Decides whether a non-code scope is an ordinary file or nothing. */
    pathExists?: (resolvedPath: string) => boolean;
}
/**
 * Resolve a search scope against the session workspace, which is what makes the decision independent of
 * where the host was launched.
 *
 * MEASURED, which is why this function exists at all: with the scope resolved against the cwd, a search
 * scoped to a workspace-relative `src` from a host launched anywhere else stat'ed as absent, fell through
 * to the extension test, and came back `{"action":"allow"}` -- while the same scope resolved against the
 * workspace came back `"serve-declaration"`. A control whose answer depends on the launching directory is
 * not a control.
 */
export declare function resolveScopePath(rawScope: string, workspaceRoot?: string): string;
/**
 * Decide whether one tool call may proceed under declarations mode.
 *
 * Pure, with every environment-dependent question injected, so the whole policy is testable without a
 * host -- the shape `containment.ts` and `attestation.ts` already use. Callers pass the real
 * `declarationPathFor` and `commandReadsContent`; `SHELL_TOOLS` is not referenced here because it is
 * module-private in `guard.ts` and the caller already knows which kind of tool it is holding.
 *
 * The setting is a ceiling checked first: when it is not the string 'declarations' this function is a
 * complete no-op, so nobody who has not opted in is affected by anything below.
 */
export declare function evaluateDeclarationEgress(input: DeclarationEgressInput): DeclarationEgressVerdict;
