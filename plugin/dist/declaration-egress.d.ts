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
    reason?: string;
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
