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
exports.DELETE_PRIMITIVES = exports.READ_TOOLS = void 0;
exports.extractWriteTarget = extractWriteTarget;
exports.hasCommandWriteSignal = hasCommandWriteSignal;
exports.hasCommandDeleteSignal = hasCommandDeleteSignal;
exports.evaluateDelegatedReadPolicy = evaluateDelegatedReadPolicy;
exports.evaluateCodeWriteGuard = evaluateCodeWriteGuard;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("./paths");
/** Tools that write a file directly. */
const WRITE_TOOLS = new Set([
    'write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit',
    'create_file', 'write_file', 'fs_write', 'notebook_edit',
]);
/** Shell tools can write files as a side effect; detection is best-effort. */
const SHELL_TOOLS = new Set([
    'pwsh', 'bash', 'shell', 'terminal', 'run_command', 'pwsh_persistent', 'bash_persistent',
]);
/**
 * Tools that read a file's contents into the caller's context. Exported because `describeSourceRead`
 * asks the same question — is this tool a read? — and two lists would drift.
 */
exports.READ_TOOLS = new Set(['read', 'read_file', 'fs_read', 'view', 'view_file', 'cat']);
function isDelegatedPath(target, paths) {
    const canonical = (0, paths_1.canonicalisePath)(target);
    for (const p of paths ?? []) {
        if ((0, paths_1.canonicalisePath)(String(p)) === canonical)
            return true;
    }
    return false;
}
const DEFAULT_GUARD_ASK_PATHS = ['tests/', 'tools/'];
/**
 * The file a tool call names, from whichever argument shape that tool uses. Exported because `apply`
 * passes it to `describeSourceRead`, which asks the same question about the same call.
 */
function extractWriteTarget(args) {
    if (!args || typeof args !== 'object')
        return undefined;
    for (const key of ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file', 'targetPath']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function shellWriteTarget(command) {
    if (typeof command !== 'string' || !command)
        return undefined;
    const match = /(?:Set-Content|Add-Content|Out-File|New-Item|tee|>>?)\s+(?:-Path\s+)?["']?([^\s"'|;>)]+\.[A-Za-z0-9]{1,6})["']?/.exec(command);
    if (!match)
        return undefined;
    return paths_1.CODE_EXTENSIONS.has(path.extname(match[1]).toLowerCase()) ? match[1] : undefined;
}
/** Script kinds a shell command can invoke. */
const SCRIPT_EXTENSIONS = new Set([
    '.ps1', '.psm1', '.sh', '.bash', '.zsh', '.cmd', '.bat',
    '.mjs', '.cjs', '.js', '.py', '.rb', '.pl',
]);
/**
 * Write primitives, deliberately explicit rather than including a bare `>`.
 * A redirection pattern would match `=>` in every arrow function and turn any JS
 * file into a false positive.
 */
const WRITE_PRIMITIVES = /(?:Set-Content|Add-Content|Out-File|New-Item|WriteAllText|WriteAllBytes|WriteAllLines|writeFileSync|writeFile|createWriteStream|copyFileSync|renameSync|fs\.appendFile)/i;
/** A source-extension reference inside a script body. */
const CODE_REFERENCE = /[A-Za-z0-9_\-\\/.]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|cc|cpp|h|hpp|swift|php|scala|lua|dart|sh|bash|ps1|psm1|sql|html|htm|css|scss|vue|svelte)\b/i;
/**
 * Write-capable constructs visible on a COMMAND LINE, not merely inside a script file
 * the guard can name. Previously only a script body was inspected, so inline program
 * text (`python -c`, `node -e`) and ordinary file verbs were invisible to the guard and
 * fell through to an allow.
 */
const COMMAND_WRITE_PRIMITIVES = /(?:\bSet-Content\b|\bAdd-Content\b|\bClear-Content\b|\bOut-File\b|\bNew-Item\b|\bCopy-Item\b|\bMove-Item\b|\bRename-Item\b|\bWriteAllText\b|\bWriteAllBytes\b|\bWriteAllLines\b|\bwriteFileSync\b|\bwriteFile\b|\bcreateWriteStream\b|\bappendFile\b|\bcopyFileSync\b|\brenameSync\b|\bshutil\.copy\b|\.write\s*\(|\bcp\b|\bmv\b|\bcopy\b|\bmove\b|\bren\b|\bdd\b|\bsed\s+-i\b|\bperl\s+-i\b|\bgit\s+(?:apply|checkout|restore|stash|clean)\b|\brobocopy\b|\bxcopy\b|\btruncate\b|\btee\b)/i;
// Every alternative is word-anchored deliberately. Unanchored verbs match as SUBSTRINGS of
// unrelated words: `Move-Item` is a substring of `Remove-Item`, so a plain delete was being
// classified as a write signal. Anchoring also keeps `writeFile` from being read out of
// `writeFileSync` and vice versa.
/** Inline program text can write a file the command line never names. */
const INLINE_EVAL_FLAG = /(?:^|\s)(?:-e|-c|--eval|-Command|-EncodedCommand)(?=\s|$)/i;
/**
 * Does this command line carry a write signal? A redirection counts only when it is a
 * real one: an `=>` in inline program text and a `2>&1` must not turn a read-only
 * command into an approval prompt.
 */
function hasCommandWriteSignal(command) {
    if (typeof command !== 'string' || !command)
        return false;
    if (COMMAND_WRITE_PRIMITIVES.test(command))
        return true;
    if (INLINE_EVAL_FLAG.test(command))
        return true;
    return /(?:^|[^=\-])>>?(?![=&])/.test(command);
}
/**
 * Delete-capable constructs, checked against BOTH a command line and a script body.
 * Destroying a source file is at least as consequential as overwriting it, and the first
 * version of this guard left deletion entirely ungated. API-level removals are included
 * because inline program text (`python -c "os.remove(...)"`) never names a verb the
 * command line displays. Word-anchored for the same reason as the write list: unanchored,
 * `rm` matches inside unrelated paths and `Move-Item` matches inside `Remove-Item`.
 */
exports.DELETE_PRIMITIVES = /(?:\bRemove-Item\b|\brm\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|\bunlink\b|\bshred\b|\bgit\s+rm\b|\bos\.remove\b|\bshutil\.rmtree\b|\bunlinkSync\b|\brmSync\b|\brmdirSync\b|\bfs\.unlink\b)/i;
/** Does this command line or script body carry a delete signal? */
function hasCommandDeleteSignal(text) {
    return typeof text === 'string' && text.length > 0 && exports.DELETE_PRIMITIVES.test(text);
}
/** Tokens in a command line that name a script file. */
function extractScriptPaths(command) {
    if (typeof command !== 'string' || !command)
        return [];
    return command
        .split(/[\s'"`|;&()]+/)
        .filter((token) => token && SCRIPT_EXTENSIONS.has(path.extname(token).toLowerCase()));
}
/**
 * Commands that READ a file named on the command line rather than executing it.
 *
 * Without this list, `Select-String -Path some.js` was treated as an invocation of
 * `some.js`: the guard read the whole file and, since any sizeable program contains a write
 * primitive, asked for approval to *read* it. Reading a file is not running it.
 */
const READ_ONLY_INSPECTORS = new Set([
    'select-string', 'get-content', 'cat', 'type', 'head', 'tail', 'less', 'more',
    'grep', 'rg', 'findstr', 'test-path', 'get-item', 'get-childitem', 'ls', 'dir',
    'stat', 'wc', 'diff', 'cmp', 'sort', 'uniq', 'strings', 'file', 'od', 'xxd',
    'out-string', 'measure-object',
]);
/**
 * Is this token read as data by a read-only inspector, rather than invoked?
 *
 * Scans positionally instead of by token: the tokenizer splits on `;`, `|` and `&`, which
 * are exactly the statement boundaries this needs to respect. Everything from the previous
 * separator up to the token is the statement that names it; if a read-only inspector appears
 * there, the token is an argument to it. A token at a statement start — including `&` or
 * `.` invocation, where the separator is immediately behind it — is an invocation, which is
 * the case the body scan exists for.
 */
function isReadArgument(command, script) {
    const at = command.indexOf(script);
    if (at < 0)
        return false;
    const before = command.slice(0, at);
    const boundary = Math.max(before.lastIndexOf(';'), before.lastIndexOf('|'), before.lastIndexOf('&'), before.lastIndexOf('\n'));
    const statement = before.slice(boundary + 1);
    return statement
        .split(/[\s'"`()]+/)
        .filter(Boolean)
        .some((word) => {
        const bare = path.basename(word).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
        return READ_ONLY_INSPECTORS.has(bare);
    });
}
/**
 * A delegated file named by a read-only inspector in a shell command is the same read by another
 * route. Only delegated paths are tested, so this cannot reintroduce the false positive that made
 * `Select-String some.js` look like a script invocation.
 */
function findDelegatedRead(command, paths) {
    if (typeof command !== 'string' || !command || !paths)
        return undefined;
    for (const p of paths) {
        const canonical = (0, paths_1.canonicalisePath)(String(p));
        for (const form of [canonical, canonical.replace(/\\/g, '/')]) {
            if (command.includes(form) && isReadArgument(command, form))
                return form;
        }
    }
    return undefined;
}
/**
 * The longest source-extension reference in a string.
 *
 * The guard previously took the FIRST match, so a command whose prose happened to contain
 * something extension-shaped — an explanation mentioning `(.ts)` — reported that fragment as
 * the target instead of the real path.
 */
function longestCodeReference(text) {
    const scanner = new RegExp(CODE_REFERENCE.source, 'gi');
    let longest;
    for (const match of text.matchAll(scanner)) {
        if (longest === undefined || match[0].length > longest.length)
            longest = match[0];
    }
    return longest;
}
function resolveScriptPath(script) {
    return path.isAbsolute(script) ? script : path.resolve(process.cwd(), script);
}
/** Size-capped read; a missing or unreadable script simply yields no finding. */
function defaultReadScript(script) {
    try {
        const resolved = resolveScriptPath(script);
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size > 512 * 1024)
            return undefined;
        return fs.readFileSync(resolved, 'utf8');
    }
    catch {
        return undefined;
    }
}
/**
 * Follow script invocations looking for a script that writes source files.
 * Bounded depth and a visited set, so a script that invokes itself terminates.
 */
function findWriteViaScript(command, readScript, depth, visited = new Set()) {
    if (depth <= 0)
        return null;
    for (const script of extractScriptPaths(command)) {
        // A file named in order to be READ is not a script being invoked.
        if (isReadArgument(command, script))
            continue;
        const resolved = resolveScriptPath(script);
        if (visited.has(resolved))
            continue;
        visited.add(resolved);
        const body = readScript(script);
        if (!body)
            continue;
        // Both signals are required: a mutation primitive (write or delete) AND a source reference.
        if (WRITE_PRIMITIVES.test(body) || exports.DELETE_PRIMITIVES.test(body)) {
            const target = longestCodeReference(body);
            if (target)
                return { script, target };
        }
        const nested = findWriteViaScript(body, readScript, depth - 1, visited);
        if (nested)
            return nested;
    }
    return null;
}
/**
 * What happens when an agent reads a file a delegated worker wrote.
 *
 * The guard cannot yet tell the architect from a lead, so it gates any agent reading delegated code.
 * `ask` is the right default: pulling that code back into the architect's context defeats the point of
 * having delegated it, but reviewing a line is sometimes exactly what an operator wants.
 *
 * `allow` is an escape hatch for a lead tier that has to read the code it writes contracts about. It is
 * an honest weakening of rule 3 rather than a fix, so the reason says which rule it costs — the config
 * entry documents its own price instead of quietly being a bypass.
 */
function evaluateDelegatedReadPolicy(policy = 'ask') {
    if (policy === 'allow') {
        return {
            kind: 'allow',
            reason: 'delegateReadPolicy is allow, which weakens rule 3: reading delegated source back into a ' +
                'context is permitted for every agent, because the host does not yet say which agent is which.',
        };
    }
    if (policy === 'deny') {
        return {
            kind: 'deny',
            reason: 'delegateReadPolicy is deny, so reading delegated source back is refused (rule 3).',
        };
    }
    return {
        kind: 'ask',
        reason: 'delegateReadPolicy is ask (the default), so this read needs an operator decision.',
    };
}
/**
 * Decide whether a tool call would author source code from the cloud context.
 * Pure and exported so it can be unit-tested without a running server.
 * Returns null when the call has nothing to do with code authoring.
 */
function evaluateCodeWriteGuard(exec, config = {}) {
    const name = String(exec?.name || '');
    const args = exec?.arguments;
    const askPaths = config.askPaths && config.askPaths.length > 0 ? config.askPaths : DEFAULT_GUARD_ASK_PATHS;
    const reason = (target) => `Writing source file '${target}' from the cloud context is blocked by the local-only code guard. ` +
        `Delegate new files to the local worker with delegate_worker, passing targetFiles and workspaceDir. ` +
        `The worker has no repository read, so it cannot modify an existing file; plan that as a delta.`;
    // Reading a file the architect delegated pulls that code straight back into its context, which
    // is precisely the noise delegation exists to keep out. Ask rather than deny: reviewing a line
    // of it is sometimes exactly what the operator wants.
    if (exports.READ_TOOLS.has(name)) {
        const target = extractWriteTarget(args);
        if (target && isDelegatedPath(target, config.delegatedPaths)) {
            const delegatedRead = evaluateDelegatedReadPolicy(config.delegateReadPolicy);
            if (delegatedRead.kind === 'allow')
                return null;
            return {
                kind: delegatedRead.kind === 'deny' ? 'deny' : 'ask',
                target,
                reason: `'${target}' was written by a delegated worker, and reading it pulls that code into the ` +
                    `cloud architect's context — the noise the delegation exists to keep out. The worker has no ` +
                    `repository read, so it cannot summarise the file back either: approve only if you need the ` +
                    `contents here, or re-plan the unit so that it does not. ${delegatedRead.reason}`,
            };
        }
        return null;
    }
    if (WRITE_TOOLS.has(name)) {
        const target = extractWriteTarget(args);
        if (!target)
            return null;
        if (!paths_1.CODE_EXTENSIONS.has(path.extname(target).toLowerCase()))
            return null;
        const normalized = target.replace(/\\/g, '/').toLowerCase();
        // A contract test is the specification the worker is held to, not the implementation. Rule 2
        // forbids the architect authoring source and rule 7 needs the architect to own those tests, so
        // this is the one declared exception, and its scope is the operator's to widen or refuse.
        const contractPaths = config.contractPaths ?? ['tests/'];
        const isContract = contractPaths.some((fragment) => normalized.includes(String(fragment).replace(/\\/g, '/').toLowerCase()));
        if (isContract) {
            // Defaults to 'ask', not 'allow'. guardAskPaths already makes tests/ approval-eligible, and
            // silently withdrawing that prompt would be a weakening nobody asked for; opting in is explicit.
            const mode = config.contractWriteMode ?? 'ask';
            if (mode === 'allow')
                return null;
            if (mode === 'deny') {
                return {
                    kind: 'deny',
                    target,
                    reason: `'${target}' is a contract file, and contractWriteMode is 'deny'. A contract test is the ` +
                        `specification the worker is held to, so this refusal is deliberate: set ` +
                        `contractWriteMode: 'allow' to author contract files, or narrow contractPaths.`,
                };
            }
            // 'ask' falls through to the ordinary rule deliberately. Where guardAskPaths already makes this
            // path ask-eligible the write still asks, with the message it always had. Short-circuiting here
            // would have replaced the reason for every test write in the repository and broken assertions
            // that predate this carve-out by a long way -- which is exactly what it did on the first attempt.
        }
        const downgrade = askPaths.some((fragment) => normalized.includes(String(fragment).replace(/\\/g, '/').toLowerCase()));
        return {
            kind: downgrade ? 'ask' : 'deny',
            target,
            reason: reason(target) +
                (downgrade ? ' This path is approval-eligible (architect-owned test/tooling).' : ''),
        };
    }
    if (SHELL_TOOLS.has(name)) {
        const command = args?.command ?? args?.script ?? '';
        const target = shellWriteTarget(command);
        if (target) {
            return {
                kind: 'ask',
                target,
                reason: `Shell command appears to write source file '${target}'. Shell-based writes cannot be ` +
                    `attributed reliably, so this requires explicit approval; prefer delegate_worker for code work.`,
            };
        }
        // A script can write anything the command line never mentions, which is how the
        // plugin's own source was edited during development. Inspect what it invokes.
        const viaScript = findWriteViaScript(command, config.readScript ?? defaultReadScript, config.scriptDepth ?? 2);
        if (viaScript) {
            return {
                kind: 'ask',
                target: viaScript.target,
                reason: `Shell command invokes '${viaScript.script}', which appears to write source file ` +
                    `'${viaScript.target}'. Script-mediated writes are invisible to a command-line scan, ` +
                    `so this requires explicit approval; prefer delegate_worker for code work.`,
            };
        }
        // A command line that names a source file AND carries a write signal cannot be
        // cleared by matching the write target itself: `cp`, `git checkout`, a real
        // redirection, or inline program text all write a file the pattern never sees.
        const referenced = longestCodeReference(command);
        if (referenced) {
            const writes = hasCommandWriteSignal(command);
            const deletes = hasCommandDeleteSignal(command);
            if (writes || deletes) {
                return {
                    kind: 'ask',
                    target: referenced,
                    reason: deletes && !writes
                        ? `Shell command would delete source file '${referenced}'. Destroying source from the ` +
                            `cloud context is gated the same way as writing it, so this requires explicit approval; ` +
                            `prefer delegate_worker for code work.`
                        : `Shell command names source file '${referenced}' and carries a write signal, so it may ` +
                            `author source from the cloud context. Command-line inspection cannot prove otherwise, so ` +
                            `this requires explicit approval; prefer delegate_worker for code work.`,
                };
            }
        }
        // Reading a delegated file through the shell is the same read by another route.
        const delegatedRead = findDelegatedRead(command, config.delegatedPaths);
        if (delegatedRead) {
            const readPolicy = evaluateDelegatedReadPolicy(config.delegateReadPolicy);
            if (readPolicy.kind === 'allow')
                return null;
            return {
                kind: readPolicy.kind === 'deny' ? 'deny' : 'ask',
                target: delegatedRead,
                reason: `Shell command reads '${delegatedRead}', which a delegated worker wrote. Reading it pulls ` +
                    `that code into the cloud architect's context, and the worker has no repository read to ` +
                    `summarise it back instead. Approve only if you need the contents here. ${readPolicy.reason}`,
            };
        }
        return null;
    }
    return null;
}
