/**
 * Resolve `p` to a canonical path: the path a write there would actually land on.
 *
 * A destination that does not exist yet has no realpath of its own, so the deepest existing ancestor
 * is resolved and the remaining segments are re-appended. The subtlety is what "not existing yet"
 * means: `fs.existsSync` FOLLOWS links, so it answers false for a link whose target is missing. A
 * dangling link was therefore treated as a directory the write would create, the walk descended past
 * it, and the link's own name was re-appended to a canonicalised in-workspace parent -- so the
 * "canonical" path stayed inside the workspace while a later write followed the link out of it. That
 * is measured, not supposed: with `workspace/link -> outside/` junctioned to a directory that does
 * not exist, `canonicalisePath(workspace/link/payload.ts)` returned the in-workspace spelling and
 * `isPathWithin(workspace, ...)` answered true. Containment cannot be evaluated against a spelling
 * the write will not use, so a link is resolved by its own target instead of being walked past.
 *
 * Ordinary paths are unaffected: an existing path resolves through realpathSync exactly as before,
 * and a genuinely absent one still resolves through its nearest existing ancestor.
 */
export declare function canonicalisePath(p: string): string;
/**
 * The first symbolic-link component of `p`, as measured by `fs.lstatSync`, or null when none is one.
 *
 * This exists because the project prohibits links in generated artifacts outright: if lstat indicates
 * isSymbolicLink(), the path is rejected, not resolved. `canonicalisePath` is the detection that has
 * to be correct for containment; this is the separate, explicit refusal, so a caller can report which
 * component is a link rather than only that the destination landed outside.
 *
 * An absolute path is walked from its root, so a link ANYWHERE in it is found -- not only the leaf.
 * `canonicalisePath` resolves a link that exists, which would hide it from a check made afterwards.
 *
 * `within` BOUNDS WHICH LINKS COUNT, and without it the rule breaks every workspace reached through a
 * link. Walking from the filesystem root finds the environment's links as well as the artifact's: a
 * junctioned project directory, a mapped drive, or `/var` on macOS, which is a symlink to
 * `/private/var`. Those are not paths a worker created and cannot be paths it escapes through --
 * containment already handles them, because canonicalisePath resolves the root and the destination
 * alike. Measured before this parameter existed: with `junction-parent -> real-parent` above the
 * workspace, an ordinary `workspace/plain.ts` emission was refused as "is a symbolic link" and zero
 * files were written. Callers that guard writes therefore pass their roots, so only links STRICTLY
 * BELOW a root -- the ones a worker can create -- are refused. A root may itself be a link: the
 * operator chose that workspace, and resolving it is the intended behaviour rather than an escape.
 */
export declare function describeSymlinkInPath(p: string, within?: string | string[]): {
    path: string;
    target: string | null;
} | null;
/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
export declare function isPathWithin(root: string, candidate: string): boolean;
/**
 * Extensions treated as source code: writes must come from the local worker.
 * Kept last in the file so the path-resolution machinery above reads as one block.
 */
export declare const CODE_EXTENSIONS: Set<string>;
