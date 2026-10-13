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
}
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
