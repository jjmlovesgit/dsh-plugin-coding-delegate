/**
 * Resolve `p` to a canonical path, following symlinks for the part of it that exists.
 * A destination that does not exist yet has no realpath of its own, so the deepest
 * existing ancestor is resolved and the remaining segments are re-appended.
 */
export declare function canonicalisePath(p: string): string;
/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
export declare function isPathWithin(root: string, candidate: string): boolean;
/** Extensions treated as source code: writes must come from the local worker. */
export declare const CODE_EXTENSIONS: Set<string>;
