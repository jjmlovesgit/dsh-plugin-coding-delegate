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
export declare const PROTECTED_WRITE_PATTERNS: readonly string[];
/**
 * May this emission be written? Returns null when it may, or the refusal reason.
 *
 * Paths outside the workspace are containment's problem and are not judged here: answering "not
 * protected" for `../secrets` would be true and useless.
 */
export declare function evaluateProtectedWrite(resolvedPath: string, baseDir: string): string | null;
