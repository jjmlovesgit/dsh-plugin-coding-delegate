"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODE_EXTENSIONS = void 0;
exports.canonicalisePath = canonicalisePath;
exports.describeSymlinkInPath = describeSymlinkInPath;
exports.isPathWithin = isPathWithin;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
function canonicalisePath(p) {
    return resolveReal(path.resolve(p), new Set(), 0);
}
/**
 * 64 hops is far past any legitimate layout and is the backstop for the one shape neither realpath nor
 * the visited set stops: a chain that is long rather than circular. The budget is spent only by links
 * that had to be read by hand, so an ordinary tree of hundreds of directories never touches it.
 */
const MAX_SYMLINK_HOPS = 64;
/**
 * The engine behind `canonicalisePath`. It carries a visited set for the circular case -- a link
 * written to point at its own ancestor, which a hand-walked resolution would otherwise descend
 * forever. `fs.realpathSync` is tried first because it is authoritative and reports ELOOP for a
 * cycle; the hand-walked branch only runs for what realpath cannot resolve at all.
 */
function resolveReal(absolute, visited, depth) {
    const join = (base, tail) => tail.length > 0 ? path.join(base, ...tail) : base;
    if (depth > MAX_SYMLINK_HOPS)
        return path.resolve(absolute);
    const chain = nearestExistingAncestor(absolute);
    if (chain === null)
        return path.resolve(absolute);
    const { ancestor, tail } = chain;
    try {
        // realpathSync resolves links at EVERY level, including ones nested inside the ancestor -- so when
        // it succeeds the job is done, with no need to re-walk the result. It throws for a dangling link,
        // which is the case this module exists to handle, so the throw means "take over", not "give up".
        return join(fs.realpathSync(ancestor), tail);
    }
    catch {
        // fall through to the hand-walked resolution
    }
    const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
    if (!stat || !stat.isSymbolicLink()) {
        // The ancestor is real or absent, but a dangling link can still sit in the tail. Recursing
        // re-enters at the resolved position, so the walk stops as soon as no tail segment is a link --
        // immediately for an ordinary path, once per dangling link otherwise. The depth budget and the
        // visited set bound the recursion without needing a fixed-point test that could stop too early.
        return resolveReal(join(ancestor, tail), visited, depth + 1);
    }
    const key = flatten(ancestor);
    if (visited.has(key))
        return join(ancestor, tail);
    visited.add(key);
    let target;
    try {
        target = fs.readlinkSync(ancestor);
    }
    catch {
        // A link whose target cannot even be read is not a path to trust or to create; the spelling is
        // returned so that a containment check compares against what was asked for rather than a guess.
        return join(ancestor, tail);
    }
    const linkTarget = path.resolve(path.dirname(ancestor), target);
    // The tail is re-appended to the link's TARGET, not to the link, because that is where the bytes
    // land. Resolution recurses so a chain of links is followed to the end rather than one hop.
    return resolveReal(path.join(linkTarget, ...tail), visited, depth + 1);
}
/**
 * Split `absolute` into its deepest existing ancestor and the segments below it, or null when nothing
 * in the path exists. `fs.lstatSync` rather than `fs.existsSync` decides "exists", because existsSync
 * follows links and so cannot see a dangling one -- the exact blindness this walk is here to avoid.
 */
function nearestExistingAncestor(absolute) {
    let current = path.resolve(absolute);
    const tail = [];
    for (;;) {
        if (fs.lstatSync(current, { throwIfNoEntry: false }))
            return { ancestor: current, tail };
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        tail.unshift(path.basename(current));
        current = parent;
    }
}
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
function describeSymlinkInPath(p, within) {
    const absolute = path.resolve(p);
    const roots = (Array.isArray(within) ? within : within === undefined ? [] : [within])
        .filter((root) => typeof root === 'string' && root.trim().length > 0)
        .map((root) => path.resolve(root));
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter((part) => part.length > 0);
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat || !stat.isSymbolicLink())
            continue;
        if (roots.length > 0 && !roots.some((bound) => isStrictlyWithin(bound, current)))
            continue;
        let target = null;
        try {
            target = fs.readlinkSync(current);
        }
        catch {
            // A link Node cannot read is still a link, and lstat already said so; the refusal does not depend
            // on knowing where it points, only on the fact that following it would leave the described path.
        }
        return { path: current, target };
    }
    return null;
}
/** True when `candidate` lies strictly below `root` -- `root` itself does not count. */
function isStrictlyWithin(root, candidate) {
    return (isPathWithin(root, candidate) && flatten(path.resolve(root)) !== flatten(path.resolve(candidate)));
}
/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
function isPathWithin(root, candidate) {
    const from = flatten(path.resolve(root));
    const to = flatten(path.resolve(candidate));
    if (from === to)
        return true;
    const rel = path.relative(from, to);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function flatten(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
/**
 * Extensions treated as source code: writes must come from the local worker.
 * Kept last in the file so the path-resolution machinery above reads as one block.
 */
exports.CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs', '.vb',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.php', '.scala', '.lua', '.dart',
    '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
]);
