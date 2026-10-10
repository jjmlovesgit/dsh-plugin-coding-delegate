/**
 * The destination decision for one delegation: which directory a worker may write into.
 *
 * `workspaceDir` is a model-visible tool argument, and it REPLACED the session root as the trusted
 * base for every emission check. Containment itself was never broken -- `evaluateEmissionPath`
 * canonicalises both sides, so a symlink or a `..` cannot escape whatever base it is given. What was
 * wrong is that the base was chosen by the caller being contained. A prompt-injected architect could
 * name any directory on the host and write there with no refusal, which turned "the worker cannot
 * escape its workspace" into "the worker cannot escape whatever directory it named".
 *
 * Four rows, and the third is what keeps external delegation possible:
 *
 *   omitted                              -> trusted, the session root
 *   within the session root              -> trusted
 *   outside, but under an allowlist root -> trusted, the operator's explicit grant
 *   outside and not allowlisted          -> operator prompt; refused when no approval is reachable
 *
 * Auto-resolved roots are NOT exempt. `resolveWorkspaceDir` reads environment variables and ctx
 * services, and a compromise there must not silently widen containment. Omission is trusted because
 * the caller said nothing, not because the resolved value is known good.
 */
export declare function resolveWorkspaceContainment(input: {
    requested?: string | null;
    sessionRoot: string;
    allowedRoots?: Array<string | undefined | null>;
    canPrompt: boolean;
}): {
    trusted: boolean;
    dir?: string;
    needsApproval: boolean;
    reason?: string;
    source: string;
};
