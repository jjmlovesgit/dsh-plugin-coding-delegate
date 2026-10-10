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
    const verdict = (0, declaration_egress_1.evaluateDeclarationEgress)({
        toolKind,
        target,
        sourceReadEgress: options?.sourceReadEgress,
        declarationRoot: options?.declarationRoot,
        isCodeExtension,
        declarationPathFor: guard_1.declarationPathFor,
        commandReadsContent: guard_1.commandReadsContent,
        commandNamesSource,
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
    // A search or a shell command has no single file to substitute a skeleton for: a search returns
    // matched lines from wherever they matched. If the evaluator ever returns serve-declaration for one of
    // these kinds, refusing is the safe reading -- serving a whole declaration in place of search output
    // would answer a question the caller did not ask. Reads never reach this module.
    if (verdict.action === 'serve-declaration') {
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
