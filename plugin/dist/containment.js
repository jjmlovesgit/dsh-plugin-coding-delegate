"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkspaceContainment = resolveWorkspaceContainment;
const paths_1 = require("./paths");
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
function resolveWorkspaceContainment(input) {
    const norm = (p) => (0, paths_1.canonicalisePath)(String(p));
    const session = norm(input.sessionRoot);
    const requested = typeof input.requested === 'string' ? input.requested.trim() : '';
    if (!requested) {
        return { trusted: true, dir: session, needsApproval: false, source: 'session-root' };
    }
    const dest = norm(requested);
    // Segment-wise containment, not string prefixing: `isPathWithin` compares path parts, so a sibling
    // directory whose NAME merely begins with the root's name is not treated as inside it.
    if ((0, paths_1.isPathWithin)(session, dest)) {
        return { trusted: true, dir: dest, needsApproval: false, source: 'within-session-root' };
    }
    const granted = (input.allowedRoots || [])
        .filter((r) => typeof r === 'string' && r.trim().length > 0)
        .map(norm);
    if (granted.some((root) => (0, paths_1.isPathWithin)(root, dest))) {
        return { trusted: true, dir: dest, needsApproval: false, source: 'emitAllowlist' };
    }
    const reason = `Delegation requested workspaceDir '${requested}', which resolves to '${dest}' -- outside the ` +
        `session workspace '${session}' and outside every configured emitAllowlist root. Writing there ` +
        `is not authorised by configuration.`;
    if (input.canPrompt) {
        return {
            trusted: false,
            dir: dest,
            needsApproval: true,
            reason,
            source: 'outside-awaiting-approval',
        };
    }
    return {
        trusted: false,
        needsApproval: false,
        reason: reason + ' No approval service is reachable, so the delegation is refused.',
        source: 'outside-refused',
    };
}
