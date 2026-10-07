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
exports.configurePatchEngine = configurePatchEngine;
exports.evaluateEmissionPath = evaluateEmissionPath;
exports.evaluateUnitScope = evaluateUnitScope;
exports.extractAndEmitFiles = extractAndEmitFiles;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const paths_1 = require("./paths");
/**
 * The delta machinery lives in `delegation.ts`, which imports this module rather than the other way
 * round, so this module cannot import it. It is configured from the composition root instead.
 *
 * Both seams are closed by default: an unconfigured emission treats every fenced body as a whole file,
 * which is the pre-delta behaviour, and `applyPatch` refuses instead of guessing.
 */
let parsePatchBody = () => null;
let applyPatch = () => ({
    ok: false,
    reason: 'the search/replace engine is not configured, so no patch can be applied',
});
/** Called once by the composition root, which holds both halves of the delta machinery. */
function configurePatchEngine(engine) {
    parsePatchBody = engine.parse;
    applyPatch = engine.apply;
}
/**
 * The containment decision for one delegated write. `baseDir` is the session workspace
 * and `allowedRoots` is the operator's explicit extension list. Both sides are
 * canonicalised, so a symlink inside the workspace cannot be used to escape it.
 */
function evaluateEmissionPath(resolvedPath, baseDir, allowedRoots = []) {
    const canonical = (0, paths_1.canonicalisePath)(resolvedPath);
    const roots = [baseDir, ...allowedRoots].filter((root) => typeof root === 'string' && root.trim().length > 0);
    for (const root of roots) {
        if ((0, paths_1.isPathWithin)((0, paths_1.canonicalisePath)(root), canonical))
            return { allowed: true };
    }
    return {
        allowed: false,
        reason: `Refused to write '${resolvedPath}': it resolves to '${canonical}', which is outside the session ` +
            `workspace '${path.resolve(baseDir)}'` +
            (allowedRoots.length > 0 ? ` and every configured emitAllowlist root` : '') +
            `. A delegated worker may only write inside its workspace; add the directory to emitAllowlist to permit it.`,
    };
}
/** The declared targets, in the shapes the tool accepts, with blanks dropped. */
function normaliseTargets(targetFilesHint) {
    if (Array.isArray(targetFilesHint)) {
        return targetFilesHint.map((t) => String(t ?? '')).filter((t) => t.trim().length > 0);
    }
    if (typeof targetFilesHint === 'string' && targetFilesHint.trim())
        return [targetFilesHint.trim()];
    return [];
}
/**
 * The scope decision for one delegated write: is this path one the unit declared?
 *
 * `targetFiles` used to be entirely passive — it became prompt text and it chose a fallback path when a
 * fenced block named no file of its own — so a unit told to change one file could rewrite another, and
 * nothing refused it, reported it, or noticed. That is the precondition for two units disagreeing, and it
 * lands strictly before any project-level check could see it.
 *
 * A declared directory covers its subtree, because `isPathWithin` counts a path as within itself or
 * beneath it. That makes `src`, `src/` and an exact file name all usable declarations, with one rule.
 *
 * An empty or absent declaration constrains nothing. A unit that declared no targets has not exceeded
 * them, and refusing everything for an empty list would break every caller that never set the field.
 */
function evaluateUnitScope(resolvedPath, declaredTargets, baseDir) {
    const declared = normaliseTargets(declaredTargets);
    if (declared.length === 0)
        return { allowed: true };
    const canonical = (0, paths_1.canonicalisePath)(resolvedPath);
    for (const target of declared) {
        const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(baseDir, target);
        if ((0, paths_1.isPathWithin)((0, paths_1.canonicalisePath)(resolvedTarget), canonical))
            return { allowed: true };
    }
    return {
        allowed: false,
        reason: `Refused to write '${resolvedPath}': this unit declared its targets, and that path is not one of ` +
            `them (${declared.join(', ')}). A unit that writes outside what it declared is how two units come ` +
            `to disagree. Re-delegate with the file declared if the change is intended, or set unitScope: ` +
            `'off' to allow writes anywhere in the workspace.`,
    };
}
/**
 * Parse the model's final content into file emissions and write them to disk.
 *
 * The model may emit either whole files (fenced code blocks with a file path in the
 * header) or search/replace patch blocks. This function handles both, writes the
 * resulting files under the workspace root, and returns a per-file summary plus any
 * errors encountered.
 *
 * `content` is the raw model output. `workspaceRoot` is the directory all emissions
 * are anchored to. `parseSearchReplaceBlocks` and `applySearchReplaceBlocks` are the
 * delta machinery, injected so this module does not import the composition root back.
 */
function extractAndEmitFiles(content, targetFilesHint, baseDir = process.cwd(), allowedRoots = [], protectedPaths = [], options = {}) {
    if (!content)
        return { filesWritten: [], errors: [], cleanContent: '' };
    // Declared targets are a boundary unless a caller says otherwise. `false` restores the behaviour before
    // that boundary existed, which is what `unitScope: 'off'` is for; anything else, including absent, means
    // enforce.
    const enforceUnitScope = options.enforceUnitScope !== false;
    const filesWritten = [];
    const emissionErrors = [];
    const seenPaths = new Set();
    function emitFile(filePath, fileCode) {
        if (!filePath || !fileCode)
            return;
        const cleanPath = filePath.trim().replace(/^["']|["']$/g, '');
        const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath);
        // Containment first: the worker's fence header and the caller's targetFiles hints
        // both choose this path, so it is untrusted input. Absolute paths and `..` segments
        // used to escape the workspace silently; they are now refused and reported.
        const containment = evaluateEmissionPath(resolvedPath, baseDir, allowedRoots);
        if (!containment.allowed) {
            emissionErrors.push(String(containment.reason));
            console.warn(`[EMIT_FILE_BLOCKED] ${containment.reason}`);
            return;
        }
        // Contract files belong to the architect. This is checked before anything is written, and it
        // covers every emission route -- the fenced header, the `// FILE:` marker, and the fallback --
        // because they all funnel through here.
        const protectedHit = protectedPaths.find((p) => (0, paths_1.canonicalisePath)(String(p)) === (0, paths_1.canonicalisePath)(resolvedPath));
        if (protectedHit) {
            emissionErrors.push(`Refused to write ${resolvedPath}: it is a contract file declared by the architect, and the ` +
                `executor may not modify the test that judges it.`);
            console.warn(`[EMIT_FILE_BLOCKED] contract file: ${resolvedPath}`);
            return;
        }
        // Scope third, and after the contract check deliberately: a contract file has to be refused for being
        // a contract rather than for being undeclared, or the reason the operator reads would name the wrong
        // rule.
        if (enforceUnitScope) {
            const scope = evaluateUnitScope(resolvedPath, targetFilesHint, baseDir);
            if (!scope.allowed) {
                emissionErrors.push(String(scope.reason));
                console.warn(`[EMIT_FILE_SCOPE_BLOCKED] ${scope.reason}`);
                return;
            }
        }
        if (seenPaths.has(resolvedPath))
            return;
        seenPaths.add(resolvedPath);
        // A search/replace body is a delta against an existing file rather than a replacement for it. The
        // header syntax is shared, so the body decides the mode. An empty list means the body started a
        // patch and never finished it, which is refused rather than written over a real file.
        const patchBlocks = parsePatchBody(fileCode);
        if (patchBlocks) {
            if (!fs.existsSync(resolvedPath)) {
                emissionErrors.push(`Refused to patch ${resolvedPath}: it does not exist, and a search/replace block edits a ` +
                    `file rather than creating one.`);
                return;
            }
            let original;
            try {
                original = fs.readFileSync(resolvedPath, 'utf8');
            }
            catch (err) {
                emissionErrors.push(`Failed to read ${resolvedPath} for patching: ${err?.message || String(err)}`);
                return;
            }
            const applied = applyPatch(original, patchBlocks);
            if (!applied.ok) {
                emissionErrors.push(`Refused to patch ${resolvedPath}: ${applied.reason}`);
                console.warn(`[EMIT_PATCH_BLOCKED] ${resolvedPath}: ${applied.reason}`);
                return;
            }
            fileCode = applied.content;
        }
        try {
            // Guard against clobbering: a model that cannot see the target file may return
            // a stub, and a wholesale rewrite far smaller than what is already there is
            // almost always damage rather than an edit.
            //
            // Deliberately skipped for a patch. The guard exists to catch output that is not really an
            // edit, and a patch has already been matched byte-for-byte against the file it changes, so the
            // failure it protects against cannot occur -- and a patch may legitimately shrink a file.
            if (!patchBlocks && fs.existsSync(resolvedPath)) {
                const previousBytes = fs.statSync(resolvedPath).size;
                const nextBytes = Buffer.byteLength(fileCode, 'utf8');
                if (previousBytes > 200 && nextBytes < previousBytes * 0.5) {
                    emissionErrors.push('Refused to overwrite ' + resolvedPath + ': new content is ' + nextBytes + 'B but the existing file is ' + previousBytes + 'B ' +
                        '(more than 50% smaller). Delete the target explicitly or fix the worker output first.');
                    return;
                }
            }
            const parentDir = path.dirname(resolvedPath);
            fs.mkdirSync(parentDir, { recursive: true });
            fs.writeFileSync(resolvedPath, fileCode, 'utf8');
            const lines = fileCode.split('\n').length;
            const bytes = Buffer.byteLength(fileCode, 'utf8');
            const relativeName = path.relative(baseDir, resolvedPath) || cleanPath;
            filesWritten.push({
                path: resolvedPath,
                relativeName,
                lines,
                bytes,
                mode: patchBlocks ? 'patch' : 'write',
                ...(patchBlocks ? { hunks: patchBlocks.length } : {}),
            });
        }
        catch (err) {
            const message = 'Failed to write ' + resolvedPath + ': ' + (err?.message || String(err));
            emissionErrors.push(message);
            console.warn('[EMIT_FILE_ERROR] ' + message);
        }
    }
    const FENCE = '\x60\x60\x60';
    // The closing fence is matched only where a fence can legally close: nothing follows it on its line,
    // and nothing but whitespace precedes it. A non-greedy scan to the next bare run of backticks stops
    // at the first one *anywhere*, so a body that itself contains a fence -- a patch quoting one, or a
    // markdown example inside a source file -- had its tail silently dropped and was then refused as a
    // malformed patch. The comment is kept fence-free so this line stays patchable by a confined agent.
    // The fallback at the bottom is for output that named no file of its own. It must not run when a file
    // WAS named and then refused: writing that content at the declared hint instead would put bytes meant
    // for one path at another, and it would walk straight around a containment, contract or scope refusal
    // by simply retrying somewhere the check happens to allow.
    let namedTargetSeen = false;
    const fileAttrRegex = new RegExp(FENCE + '[a-zA-Z0-9_-]*\\s+(?:file|filename)=["\']?([^"\'\\s\\n>]+)["\']?\\s*\\n([\\s\\S]*?)[ \\t]*' + FENCE + '[ \\t]*(?:\\r?\\n|$)', 'gi');
    let match;
    while ((match = fileAttrRegex.exec(content)) !== null) {
        namedTargetSeen = true;
        emitFile(match[1], match[2]);
    }
    const fileMarkerRegex = new RegExp(FENCE + '[a-zA-Z0-9_-]*\\n(?://\\s*FILE:\\s*|#\\s*FILE:\\s*|/\\*\\s*FILE:\\s*|\\[FILE:\\s*)([^\\s\\n\\*\\]]+)(?:\\s*\\*/|\\])?\\n([\\s\\S]*?)' + FENCE, 'gi');
    while ((match = fileMarkerRegex.exec(content)) !== null) {
        namedTargetSeen = true;
        emitFile(match[1], match[2]);
    }
    if (!namedTargetSeen && filesWritten.length === 0 && targetFilesHint) {
        const hints = Array.isArray(targetFilesHint)
            ? targetFilesHint
            : typeof targetFilesHint === 'string'
                ? [targetFilesHint]
                : [];
        const allCodeBlocks = [];
        const FENCE = '\x60\x60\x60';
        const genericCodeBlockRegex = new RegExp(FENCE + '[a-zA-Z0-9_-]*\\n([\\s\\S]*?)' + FENCE, 'gi');
        let cbMatch;
        while ((cbMatch = genericCodeBlockRegex.exec(content)) !== null) {
            if (cbMatch[1].trim()) {
                allCodeBlocks.push(cbMatch[1]);
            }
        }
        if (allCodeBlocks.length > 0) {
            for (let i = 0; i < hints.length; i++) {
                const hintPath = hints[i];
                const code = allCodeBlocks[i] || allCodeBlocks[0];
                if (hintPath && code) {
                    emitFile(hintPath, code);
                }
            }
        }
        else if (content.trim() && hints.length > 0) {
            // Only write unreferenced output when it actually looks like source code.
            // A worker that cannot read the target file may answer with prose or a
            // tool-call transcript; writing that over a real file destroys it.
            const body = content.trim();
            const toolCall = '<' + 'tool_call|<function=|<' + '/tool_call>';
            const proseOpen = "\\s*(?:I'll|I will|I've|Here(?:'s| is)|Sure|Certainly|Let me|First,|To do this)";
            const looksLikeProse = new RegExp(toolCall, 'i').test(body) || new RegExp('^' + proseOpen, 'im').test(body);
            const codeStart = '^(?://|#|<!--|/\\*|import\\s|export\\s|const\\s|let\\s|var\\s|function\\s|class\\s|interface\\s|type\\s|def\\s|package\\s|using\\s|public\\s|private\\s|<!DOCTYPE|<[a-zA-Z])';
            const looksLikeCode = new RegExp(codeStart, 'm').test(body);
            if (looksLikeProse || !looksLikeCode) {
                emissionErrors.push('Refused to write ' + hints[0] + ': worker output has no fenced code block and does not look like source code.');
            }
            else {
                emitFile(hints[0], body);
            }
        }
    }
    return { filesWritten, errors: emissionErrors, cleanContent: content };
}
