"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROTECTED_WRITE_PATTERNS = void 0;
exports.evaluateProtectedWrite = evaluateProtectedWrite;
/**
 * Paths a delegated worker may never write, whoever declares them.
 *
 * `evaluateUnitScope` already refuses writes outside the targets the architect declared — but the
 * architect declares them. That bounds a confused unit, not a confused deputy: a delegation can name
 * `.github/workflows/ci.yml` or `plugin/src/sandbox.ts` as its target and the scope check will happily
 * authorise it. This fence is independent of the declaration, so the answer to "may the worker touch
 * the machinery that judges it?" is no regardless of what the task says.
 *
 * The list is deliberately about CONTROL SURFACE, not about file types: CI definitions, signing keys,
 * hooks, the gate scripts, the sandbox and policy modules, lint and dependency rules, manifests. A
 * worker cannot be allowed to edit the thing that will attest its own output.
 */
exports.PROTECTED_WRITE_PATTERNS = [
    '.github/',
    '.git/',
    'keys/',
    'scripts/git-hooks/',
    'scripts/attest-unit.cjs',
    'scripts/verify-delegation-ledger.cjs',
    'scripts/verify-tree-attestations.cjs',
    'scripts/check-promotion.cjs',
    'scripts/policy-config.cjs',
    'scripts/check-file-hygiene.cjs',
    'plugin/src/sandbox.ts',
    'plugin/src/verification.ts',
    'plugin/src/guard.ts',
    'plugin/src/emission.ts',
    'plugin/src/contracts.ts',
    'plugin/src/delegation.ts',
    'plugin/src/write-policy.ts',
    'eslint.config.mjs',
    '.dependency-cruiser.cjs',
    'tsconfig.json',
    'plugin/tsconfig.json',
    'package.json',
    'plugin/package.json',
    'package-lock.json',
    'plugin/package-lock.json',
];
const isProtected = (relative) => {
    const normalised = relative.replace(/\\/g, '/').toLowerCase();
    return exports.PROTECTED_WRITE_PATTERNS.some((pattern) => {
        const candidate = pattern.toLowerCase();
        return candidate.endsWith('/') ? normalised.startsWith(candidate) : normalised === candidate;
    });
};
/**
 * May this emission be written? Returns null when it may, or the refusal reason.
 *
 * Paths outside the workspace are containment's problem and are not judged here: answering "not
 * protected" for `../secrets` would be true and useless.
 */
function evaluateProtectedWrite(resolvedPath, baseDir) {
    const relative = require('node:path').relative(baseDir, resolvedPath);
    if (relative.startsWith('..') || require('node:path').isAbsolute(relative))
        return null;
    if (!isProtected(relative))
        return null;
    return ('REFUSED_PROTECTED_PATH: ' + relative + ' is control surface — CI definitions, signing keys, hooks, ' +
        'gate scripts, the sandbox or policy modules, or the manifests — and a delegated worker may not write ' +
        'it, whatever the task declares. This fence is independent of targetFiles on purpose: a unit must ' +
        'not be able to edit the machinery that judges or signs it. Change it as the operator, through review.');
}
