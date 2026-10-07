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
exports.isPathWithin = isPathWithin;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Resolve `p` to a canonical path, following symlinks for the part of it that exists.
 * A destination that does not exist yet has no realpath of its own, so the deepest
 * existing ancestor is resolved and the remaining segments are re-appended.
 */
function canonicalisePath(p) {
    let current = path.resolve(p);
    const tail = [];
    for (;;) {
        if (fs.existsSync(current))
            break;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        tail.unshift(path.basename(current));
        current = parent;
    }
    try {
        current = fs.realpathSync(current);
    }
    catch {
        // An unresolvable ancestor is not a reason to trust the path; keep it as written.
    }
    return tail.length > 0 ? path.join(current, ...tail) : current;
}
/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
function isPathWithin(root, candidate) {
    const flatten = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const from = flatten(path.resolve(root));
    const to = flatten(path.resolve(candidate));
    if (from === to)
        return true;
    const rel = path.relative(from, to);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
/** Extensions treated as source code: writes must come from the local worker. */
exports.CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs', '.vb',
    '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.php', '.scala', '.lua', '.dart',
    '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
]);
