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
exports.handleDeclarationPostExecute = handleDeclarationPostExecute;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const guard_1 = require("./guard");
// CODE_EXTENSIONS is declared in ./paths and is deliberately not re-exported from ./guard, so it is
// imported from its own module. Importing it from './guard' fails to compile.
const paths_1 = require("./paths");
const declaration_egress_1 = require("./declaration-egress");
/**
 * Decide whether this tool call may return its output under declarations mode.
 *
 * Returns a replacement decision when the call must be refused, or null when it may proceed. A null is
 * the caller's signal to keep going, which is why every pass-through path returns null rather than a
 * decision: the handler's contract is (exec, result, next) => decision, and a decision invented here
 * would replace the tool's real output with nothing.
 */
function handleDeclarationPostExecute(exec, options) {
    // The setting is the ceiling and is checked first, so this is a complete no-op for anyone who has not
    // opted in. index.ts also gates registration on the same value; both checks are kept because a
    // mis-ordered load must not be able to turn the control off.
    if (options?.sourceReadEgress !== 'declarations')
        return null;
    const name = String(exec?.name || '');
    if (!name)
        return null;
    let toolKind = 'other';
    if (guard_1.READ_TOOLS.has(name))
        toolKind = 'read';
    else if (guard_1.SEARCH_TOOLS.has(name))
        toolKind = 'search';
    else if (guard_1.SHELL_TOOLS.has(name))
        toolKind = 'shell';
    // Not an egress route, and -- for a read -- handled by index.ts's own branch, which does more than
    // this module can. See the note at the top.
    if (toolKind !== 'search' && toolKind !== 'shell')
        return null;
    // Reads carry `path`, searches carry a scope, shell commands carry `command`. Reading the wrong field
    // yields an empty target, which the evaluator treats as scope-free and refuses -- a fail-closed but
    // wrong answer, so the extraction is per kind rather than guessed.
    const args = exec?.arguments ?? {};
    const target = toolKind === 'search'
        ? String(args.path ?? args.directory ?? args.target ?? '')
        : String(args.command ?? args.cmd ?? '');
    // CODE_EXTENSIONS is a Set of EXTENSIONS, not of paths. Testing a whole path against it returns false
    // for every source file and would silently disable the gate, so the extension is derived here.
    const isCodeExtension = (p) => paths_1.CODE_EXTENSIONS.has(path.extname(String(p)).toLowerCase());
    // longestCodeReference returns the longest code-looking token, or undefined. The evaluator wants a
    // predicate, so presence becomes a boolean here rather than a second vocabulary of source extensions.
    const commandNamesSource = (cmd) => (0, guard_1.longestCodeReference)(cmd) !== undefined;
    // THE SCOPE IS RESOLVED AGAINST THE SESSION WORKSPACE HERE, with the one exported resolver, so the
    // answer does not depend on where the host was launched. MEASURED before this: a workspace-relative
    // `src` stat'ed as absent from any other cwd, the evaluator fell through to the extension test, and the
    // search came back allowed while the same scope against the workspace was served as declarations.
    const resolveScope = (scope) => (0, declaration_egress_1.resolveScopePath)(scope, options?.workspaceRoot) || scope;
    const directoryScope = (scope) => {
        try {
            return fs.statSync(resolveScope(scope)).isDirectory();
        }
        catch {
            // Nothing there. Not a directory this route can resolve, so it is not cleared here; the evaluator
            // decides what an unresolved scope means, and refuses a path-shaped one.
            return false;
        }
    };
    // Does the command read content out of a DIRECTORY it names? `rg SECRET src` names no file, so the
    // extension-bearing reference test cannot see it: measured, `longestCodeReference('rg SECRET src')` is
    // undefined while the command does read content. The search route has refused that shape since its
    // directory branch landed; this is the same test for the shell route (SECURITY-REVIEW-4 [7]). The
    // resolver is the one above, so the answer does not depend on where the host was launched.
    const commandReadsDirectoryScope = (cmd) => {
        if ((0, guard_1.commandReadsContent)(String(cmd || '')) !== true)
            return false;
        const tokens = String(cmd || '').match(/[^\s"']+/g) || [];
        for (const token of tokens) {
            if (token.startsWith('-'))
                continue;
            try {
                if (fs.statSync(resolveScope(token)).isDirectory())
                    return true;
            }
            catch {
                // Not a directory. The next token decides, and a command with none is not this case.
            }
        }
        return false;
    };
    // Does the resolved scope exist at all? A non-code path that exists reads no source and stands; one that
    // does not exist is refused rather than waved through, because "not found" and "a phrase" are otherwise
    // the same string.
    const pathExists = (resolved) => {
        try {
            return fs.existsSync(resolved);
        }
        catch {
            return false;
        }
    };
    // The source files a scope names. A directory is walked; a file is itself. An unreadable branch is
    // reported as no source rather than as an error, and that is deliberate: the walk answers "which files
    // can the caller's search reach", so a subtree the harness cannot read is a subtree the search cannot
    // return bytes from either. Anything the walk genuinely cannot tell apart fails closed in the
    // evaluator instead -- a missing declaration for a file it DID find is refused there, not here.
    const listSourceFiles = (scope) => {
        const found = [];
        const walk = (p) => {
            let entries;
            let isDirectory = false;
            try {
                const stat = fs.statSync(p);
                isDirectory = stat.isDirectory();
                if (!isDirectory && !stat.isFile())
                    return;
                if (!isDirectory) {
                    if (paths_1.CODE_EXTENSIONS.has(path.extname(p).toLowerCase()))
                        found.push(p);
                    return;
                }
                entries = fs.readdirSync(p, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory() || entry.isFile())
                    walk(path.join(p, entry.name));
            }
        };
        walk(resolveScope(scope));
        return found;
    };
    // The declaration bytes behind one source file, with the staleness verdict index.ts already applies to
    // a read. `exists:false` for anything unreadable, so a missing skeleton is refused rather than served.
    const readDeclaration = (sourceFile, root) => {
        const skeleton = (0, guard_1.declarationPathFor)(sourceFile, String(root || ''));
        if (!skeleton)
            return { exists: false };
        let text;
        try {
            text = fs.readFileSync(skeleton, 'utf8');
        }
        catch {
            return { exists: false };
        }
        const staleReason = (0, guard_1.staleDeclarationReason)(sourceFile, skeleton);
        return staleReason ? { exists: true, text, staleReason } : { exists: true, text };
    };
    const verdict = (0, declaration_egress_1.evaluateDeclarationEgress)({
        toolKind,
        target,
        sourceReadEgress: options?.sourceReadEgress,
        declarationRoot: options?.declarationRoot,
        isCodeExtension,
        declarationPathFor: guard_1.declarationPathFor,
        commandReadsContent: guard_1.commandReadsContent,
        commandNamesSource,
        commandReadsDirectoryScope,
        directoryScope,
        listSourceFiles,
        readDeclaration,
        workspaceRoot: options?.workspaceRoot,
        workspaceVerified: options?.workspaceVerified,
        pathExists,
    });
    if (verdict.action === 'block') {
        return {
            kind: 'accept',
            content: [
                {
                    type: 'text',
                    text: String(verdict.reason || 'Egress blocked by declarations policy.'),
                },
            ],
        };
    }
    // A search has no single file to substitute a skeleton for, so a bare skeleton name is not servable
    // here. A scope that RESOLVED to declaration bytes is different: the evaluator has already walked the
    // scope and carries the declarations, which is the only thing that may stand in for the matched lines.
    if (verdict.action === 'serve-declaration') {
        if (typeof verdict.declarationText === 'string' && verdict.declarationText.trim()) {
            return {
                kind: 'accept',
                content: [
                    {
                        type: 'text',
                        text: '// SERVED AS TYPE DECLARATIONS, NOT SOURCE. Implementation bodies are withheld by policy ' +
                            '(sourceEgress: declarations).\n// Declaration file(s): ' +
                            String(verdict.skeleton || '') +
                            '\n// ' +
                            String(verdict.reason || '') +
                            '\n\n' +
                            verdict.declarationText,
                    },
                ],
            };
        }
        return {
            kind: 'accept',
            content: [
                {
                    type: 'text',
                    text: "Reading '" +
                        target +
                        "' under sourceReadEgress 'declarations' is refused on this route: only a direct file read " +
                        'can be redirected to a type skeleton, and a search or shell command cannot. Read the ' +
                        'declaration path directly instead.',
                },
            ],
        };
    }
    return null;
}
