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
exports.resolveScopePath = resolveScopePath;
exports.evaluateDeclarationEgress = evaluateDeclarationEgress;
const path = __importStar(require("path"));
/**
 * Resolve a search scope against the session workspace, which is what makes the decision independent of
 * where the host was launched.
 *
 * MEASURED, which is why this function exists at all: with the scope resolved against the cwd, a search
 * scoped to a workspace-relative `src` from a host launched anywhere else stat'ed as absent, fell through
 * to the extension test, and came back `{"action":"allow"}` -- while the same scope resolved against the
 * workspace came back `"serve-declaration"`. A control whose answer depends on the launching directory is
 * not a control.
 */
function resolveScopePath(rawScope, workspaceRoot) {
    const raw = String(rawScope || '').trim();
    if (!raw)
        return '';
    if (path.isAbsolute(raw))
        return path.normalize(raw);
    if (workspaceRoot && String(workspaceRoot).trim()) {
        return path.resolve(String(workspaceRoot), raw);
    }
    // No workspace named. The cwd is the only base left, and it is the wrong one in general -- which is
    // exactly why the caller is told, below, that a path-shaped scope cannot be cleared without it.
    return path.resolve(raw);
}
/**
 * Is this scope SHAPED like a path rather than like a phrase? A separator or an extension is the signal.
 *
 * It matters only in one place: an unresolved scope that looks like a path is treated as an escape
 * attempt rather than as prose, because "a file I could not find" and "a sentence" are the same string to
 * a resolver. Prose has no separator and no extension, so the two are separable in practice.
 */
function looksLikePath(scope) {
    return scope.includes('/') || scope.includes('\\') || path.extname(scope).length > 0;
}
/**
 * The extensions `tsc --declaration --emitDeclarationOnly` can actually produce a skeleton for.
 *
 * WHY THIS SET EXISTS, and why it is narrower than `CODE_EXTENSIONS`. The obvious implementation is to
 * ask `declarationPathFor` whether it can map the file and treat `null` as "cannot". That does not work,
 * and the reason is a trap: `declarationPathFor` ends with
 *
 *     return path.join(declarationRoot, relative + '.d.ts')
 *
 * having fallen back to `path.basename` for any path that does not contain a `src/` segment
 * (`guard.ts:583-587`). It therefore returns a NON-NULL path for every extension in its four-extension
 * allowlist AND never consults the extension list of the thing being mapped. A `.py` file handed to it
 * comes back as `<root>/deploy.d.ts` -- a path that no build will ever create.
 *
 * A check written that way would not refuse the Python read. It would redirect it to a skeleton that
 * does not exist, which is the leak plus a misleading file reference. So the mappability decision is
 * made here, explicitly, and `declarationPathFor` is only ever called for a file this set accepts.
 *
 * `.d.ts` is deliberately absent: a declaration is already a skeleton and is allowed earlier.
 * `.mts` and `.cts` are absent because the build in this repository does not emit for them.
 */
const MAPPABLE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
/**
 * True when this file's extension is one declarations mode can serve a skeleton for.
 *
 * THE `.d.` PREFIX IS EXCLUDED HERE, which the extension set above assumed and never got: `path.extname`
 * of `impl.d.ts` is `.ts`, so a declaration file passed the set's test and counted as SOURCE. Measured in
 * a directory holding both `impl.ts` and its `impl.d.ts`: the walk returned both, no skeleton can exist
 * for a declaration file (the mapping produced `impl.d.d.ts`), and the whole scope was refused -- a
 * legitimate search blocked by the one kind of file this mode exists to serve.
 */
function mappableSourceFile(filePath) {
    const name = String(filePath || '').toLowerCase();
    if (/\.d\.(ts|mts|cts)$/.test(name))
        return false;
    return MAPPABLE_SOURCE_EXTENSIONS.has(path.extname(name));
}
/**
 * Expand a search scope into the declarations that stand for the source beneath it.
 *
 * WHY AN EXPANSION RATHER THAN A VERDICT PER SCOPE. The search branch used to decide from the scope's
 * extension alone, which is a question about the string and not about the tree. MEASURED: scoping a
 * search to `src` returned `{"action":"allow"}` while `src/guard.ts` was refused, so the filter's reach
 * depended on how the caller spelled the path rather than on what the path contains. Resolving the
 * scope first removes the spelling from the decision entirely.
 *
 * `text` is the whole skeleton, never a filtered selection of the source: matching the search pattern
 * against source and returning the matching declaration lines would be a different and much easier thing
 * to get wrong, and the point of this mode is that implementation bytes never cross at all.
 */
function resolveDeclarations(input, scope) {
    const listed = input.listSourceFiles(scope);
    const sources = Array.isArray(listed) ? listed.filter((f) => mappableSourceFile(String(f))) : [];
    const resolved = [];
    const unresolved = [];
    for (const source of sources) {
        const skeleton = input.declarationPathFor
            ? input.declarationPathFor(source, input.declarationRoot)
            : null;
        if (!skeleton) {
            unresolved.push(source + ' (no declaration path can be derived for it)');
            continue;
        }
        let detail = { exists: false };
        try {
            detail = input.readDeclaration ? input.readDeclaration(source, input.declarationRoot) : { exists: false };
        }
        catch {
            detail = { exists: false };
        }
        if (!detail || detail.exists !== true || typeof detail.text !== 'string') {
            unresolved.push(source + " (no type skeleton exists at '" + skeleton + "')");
            continue;
        }
        // A stale declaration is refused rather than summarised away. index.ts applies the same rule for a
        // read: serving yesterday's signature while the caller believes it is current is the failure that
        // check exists to prevent, and a search must not become the route that skips it.
        if (detail.staleReason) {
            unresolved.push(source + ' (' + detail.staleReason + ')');
            continue;
        }
        resolved.push({ source, skeleton, exists: true, text: detail.text });
    }
    return { resolved, unresolved };
}
/**
 * Decide whether one tool call may proceed under declarations mode.
 *
 * Pure, with every environment-dependent question injected, so the whole policy is testable without a
 * host -- the shape `containment.ts` and `attestation.ts` already use. Callers pass the real
 * `declarationPathFor` and `commandReadsContent`; `SHELL_TOOLS` is not referenced here because it is
 * module-private in `guard.ts` and the caller already knows which kind of tool it is holding.
 *
 * The setting is a ceiling checked first: when it is not the string 'declarations' this function is a
 * complete no-op, so nobody who has not opted in is affected by anything below.
 */
function evaluateDeclarationEgress(input) {
    // 1. Not opted in. A total pass-through, for the reason above.
    if (input.sourceReadEgress !== 'declarations')
        return { action: 'allow' };
    const target = String(input.target || '');
    // 2. A declaration file is already the artifact this mode exists to serve, so reading one is ordinary.
    //    Checked before the tool kind because it is true for a read and for a search scope alike.
    //
    //    ONLY WHEN THE TARGET IS ACTUALLY ONE PATH. `endsWith('.d.ts')` alone would allow a COMMAND whose
    //    last characters happen to be `.d.ts` — `cat secret.ts; echo x.d.ts` reads the first file and looks
    //    like the second (SECURITY-REVIEW-6 [5]). A single path has no whitespace, no shell operator and no
    //    quoting, so requiring that is what makes the suffix mean what it appears to mean.
    const singlePath = /^[^\s;&|<>()`"'*?[\]{}]+$/.test(target);
    if (singlePath && /\.d\.ts$/i.test(target))
        return { action: 'allow' };
    // 2b. A wildcard is expanded by the SHELL, after this gate has read the command string. Every per-file
    //     decision below is about a string, not about the files the shell will actually open, so the only
    //     honest answer is refusal (SECURITY-REVIEW-6 [6]).
    if (input.toolKind === 'shell' &&
        input.commandReadsContent?.(target) === true &&
        input.commandHasWildcard?.(target) === true) {
        return {
            action: 'block',
            reason: 'REFUSED_WILDCARD_READ: declarations mode refuses glob patterns in commands that read content. ' +
                'The shell expands *, ? and [ ] after this gate inspected the command, so the files it reaches ' +
                'are not the files that were checked. Name each file explicitly.',
        };
    }
    // 3. READS.
    if (input.toolKind === 'read') {
        // THE RULE IS AN ALLOWLIST, NOT A CODE-FILE DENYLIST. "Not a TypeScript extension" was never a safe
        // proxy for "not implementation": `.py`, `.sh`, `.json` and `.yaml` carry business logic, credentials
        // and configuration. Three things may pass, and nothing else:
        //   - declaration files (step 2 above)
        //   - prose, which carries no implementation (the committed control oracle pins this)
        //   - mappable source, SERVED AS ITS DECLARATION rather than raw
        // (SECURITY-REVIEW-6 [7])
        const lowerTarget = target.toLowerCase();
        if (/\.(md|markdown|txt|rst)$/.test(lowerTarget))
            return { action: 'allow' };
        if (!mappableSourceFile(target)) {
            return {
                action: 'block',
                reason: 'REFUSED_NON_DECLARATION_READ: declarations mode permits reading only .d.ts declarations, ' +
                    "prose, and mappable source served as its declaration. Target '" + target + "' is raw source " +
                    "or configuration and requires operator approval. Switch sourceReadEgress to 'source' to read " +
                    'implementations deliberately.',
            };
        }
        const skeleton = input.declarationPathFor
            ? input.declarationPathFor(target, input.declarationRoot)
            : null;
        if (!skeleton) {
            // Fail closed, which is the rule index.ts already applies to a read whose declaration is missing.
            return {
                action: 'block',
                reason: "Reading '" +
                    target +
                    "' was refused: sourceReadEgress is 'declarations' and no declaration path could be derived " +
                    'for it. Implementation bodies are not served to this context.',
            };
        }
        return { action: 'serve-declaration', skeleton };
    }
    // FAIL CLOSED WHEN THE BASE ITSELF IS A GUESS. Defined once and asked in two places, because the answer
    // does not depend on where in the decision tree the question is put -- only on whether the base is the
    // session workspace or the process working directory.
    //
    // `workspaceRoot` can be the cwd rather than a session workspace, because the host may expose no
    // workspace at all (`resolveWorkspaceDir` says which one it used). On that base, "the scope does not
    // resolve" says nothing about what the host will search: the search runs against the session's own root,
    // and a BARE directory scope carries no extension for the resolver to test. Measured with the cwd outside
    // the workspace: `grep { path: 'src' }` fell through to the allow and the raw results passed, while the
    // same scope against the true root is served as declarations (SECURITY-REVIEW-4 [2]).
    //
    // The cost is stated rather than hidden: on a host that exposes no workspace, a phrase-shaped scope is
    // refused here too, because nothing distinguishes it from a directory the search really would reach.
    // That is the fail-closed direction, and the message names the thing the operator has to fix.
    //
    // A caller that names no workspace at all still gets the old answer, which the committed oracle pins.
    //
    // Asked a third time for the shell branch, where the scope travels inside a command string instead of in
    // a field of its own. The verb is a parameter only so the refusal names the act the operator performed;
    // the condition is one helper so the three sites cannot drift apart.
    const refuseUnverifiedBase = (scope, act = 'Searching') => {
        if (!input.workspaceRoot || input.workspaceVerified)
            return null;
        return {
            action: 'block',
            reason: act +
                " '" +
                scope +
                "' was refused: sourceReadEgress is 'declarations' and the session workspace could not be " +
                'established, so this scope was resolved against the process working directory -- a guess -- and ' +
                'its reach cannot be shown to avoid source. Check the path, or give the session a workspace.',
        };
    };
    // 4. SEARCHES. A search returns matching LINES, so there is no whole file to substitute: the matched
    //    bytes are implementation bodies wherever they land. The scope decides, because a search confined
    //    to prose cannot reach code. An UNSTATED scope cannot be shown to be harmless and is refused --
    //    the opposite of the read branch, where an unstated target is simply not a read.
    if (input.toolKind === 'search') {
        const scope = target.trim();
        if (!scope) {
            return {
                action: 'block',
                reason: "A search with no stated scope was refused: sourceReadEgress is 'declarations' and the search's " +
                    'reach cannot be shown to avoid source. Narrow it to a non-source path, or read a declaration ' +
                    'path directly.',
            };
        }
        // THE PROVENANCE QUESTION IS ASKED FIRST, BEFORE ANY FILESYSTEM QUESTION (SECURITY-REVIEW-5 [3]).
        //
        // This refusal used to sit after the directory branch, which is too late for it to be a control. The
        // injected `directoryScope` resolves the scope against `workspaceRoot` -- and when that is the cwd
        // fallback, the directory it finds belongs to the cwd, not to the session. An empty directory there
        // resolves to zero source files and returns the positive control's allow, so the provenance refusal
        // further down was never reached while the host ran the search against the real workspace. A
        // provenance check that runs after filesystem guesses is a check on the guesses. Asking here also
        // covers the code-extension and existence branches below, which are the same kind of claim about a
        // tree the base does not describe.
        const unverifiedSearch = refuseUnverifiedBase(scope);
        if (unverifiedSearch)
            return unverifiedSearch;
        // A scope that names a source FILE keeps the rule the committed oracle pins for it -- a search over a
        // code file is refused rather than answered with the file's whole skeleton, which would answer a
        // question the caller did not ask. The directory route below is where the defect was.
        if (input.isCodeExtension ? input.isCodeExtension(scope) : false) {
            return {
                action: 'block',
                reason: "Searching '" +
                    scope +
                    "' was refused: sourceReadEgress is 'declarations' and a search returns matched source lines, " +
                    'which are implementation bodies. Read the declaration path directly instead.',
            };
        }
        // The defect: a DIRECTORY has no extension, so the two checks above saw "not code" and allowed a
        // search whose matches are implementation lines from every file beneath it. The refusal below is
        // reached only with the directory resolved to explicit source files.
        //
        // THE SCOPE IS RESOLVED FOR THE QUESTIONS ASKED HERE -- the existence test and the fail-closed rule
        // below -- and the injected callbacks still receive the scope AS STATED. That split is deliberate:
        // the callbacks are the caller's view of the filesystem, and the caller is the one holding the
        // workspace base, so it resolves them with this same exported `resolveScopePath`. Resolution is
        // defined once; what differs is only which side of the injection boundary performs it.
        const scopePath = resolveScopePath(scope, input.workspaceRoot);
        if (input.directoryScope ? input.directoryScope(scope) : false) {
            if (!input.listSourceFiles) {
                // An unresolvable directory cannot be cleared: "no source beneath" is a claim about the tree and
                // nothing here has looked at the tree. Fail closed, the rule the shell branch already states.
                return {
                    action: 'block',
                    reason: "Searching '" +
                        scope +
                        "' was refused: sourceReadEgress is 'declarations', that scope is a directory, and this " +
                        'route cannot resolve it to the source files beneath it, so it cannot be shown to avoid ' +
                        'source. Read a declaration path directly instead.',
                };
            }
            const { resolved, unresolved } = resolveDeclarations(input, scope);
            // Refused rather than served when any file beneath the scope has no declaration. Serving the rest
            // would answer a question about a tree by silently omitting part of it, and the caller cannot tell
            // which part is missing.
            if (unresolved.length) {
                return {
                    action: 'block',
                    reason: "Searching '" +
                        scope +
                        "' was refused: sourceReadEgress is 'declarations' and the scope holds source with no " +
                        'servable type skeleton -- ' +
                        unresolved.join('; ') +
                        '. Implementation bodies are not served to this context. Build the declarations with ' +
                        'npm run build, or search a narrower non-source path.',
                };
            }
            // Positively resolved to nothing: the resolver looked and there is no source beneath this scope, so
            // the search cannot return an implementation line. A control, so this route cannot pass by
            // refusing every directory.
            if (!resolved.length)
                return { action: 'allow' };
            const skeletons = resolved.map((r) => r.skeleton);
            return {
                action: 'serve-declaration',
                skeleton: skeletons.join(', '),
                declarationText: resolved
                    .map((r) => '// Declaration file: ' + r.skeleton + '\n' + String(r.text).trim())
                    .join('\n\n'),
                reason: 'The scope resolves to ' +
                    resolved.length +
                    ' source file(s). Only their type declarations are served; implementation bodies are withheld ' +
                    "by policy (sourceEgress: declarations).",
            };
        }
        // An existing path that is neither a directory nor a code file -- `docs/README.md` is the committed
        // oracle's case -- reads no source, so it stands. Asked about the RESOLVED path, so it does not depend
        // on the cwd either.
        if (input.pathExists && input.pathExists(scopePath))
            return { action: 'allow' };
        // FAIL CLOSED ON AN UNRESOLVED SCOPE THAT IS SHAPED LIKE A PATH.
        //
        // WHY THIS IS NOT THE OLD `allow`. "A path I could not resolve" and "a phrase rather than a path" are
        // the same string to a resolver, so one of the two has to be guessed; the direction to guess in is the
        // one that does not leak. A scope with a separator or an extension is a claim about the tree, and a
        // claim that does not hold is refused rather than waved through.
        //
        // ASKED ONLY WHEN A WORKSPACE WAS NAMED, because that is what makes "could not resolve" mean
        // something: without it the resolution base is the process cwd, and refusing every relative scope on a
        // host launched elsewhere would refuse ordinary prose. A caller that supplies no workspace gets the
        // old answer, and the caller in this plugin always supplies one.
        if (input.workspaceRoot && looksLikePath(scope)) {
            return {
                action: 'block',
                reason: "Searching '" +
                    scope +
                    "' was refused: sourceReadEgress is 'declarations', the scope is shaped like a path, and it " +
                    'does not resolve to anything under the session workspace, so its reach cannot be shown to ' +
                    'avoid source. Check the path, or search a scope that exists.',
            };
        }
        // The fallthrough shapes -- prose, a path that resolves to nothing, a path that exists but is neither a
        // directory nor a code file -- reach the same provenance refusal, asked of the one helper so the two
        // sites cannot drift apart (SECURITY-REVIEW-4 [2], SECURITY-REVIEW-5 [3]).
        const unverifiedFallthrough = refuseUnverifiedBase(scope);
        if (unverifiedFallthrough)
            return unverifiedFallthrough;
        // Prose: no separator, no extension, nothing on disk. It cannot reach source.
        return { action: 'allow' };
    }
    // 5. SHELL. Same leak by another door, with one difference that matters: a command that merely lists
    //    or tests reads no bytes, so there is nothing to leak and it is allowed through.
    if (input.toolKind === 'shell') {
        // An egress filter that cannot evaluate must not wave the read through. This is the rule
        // index.ts:1496 already states for a failed evaluation.
        if (!input.commandReadsContent || !input.commandNamesSource) {
            return {
                action: 'block',
                reason: "Shell command '" +
                    target +
                    "' was refused: sourceReadEgress is 'declarations' and the command could not be inspected for " +
                    'content reads, so it cannot be cleared. Fail closed.',
            };
        }
        const reads = input.commandReadsContent(target) === true;
        const names = input.commandNamesSource(target) === true;
        if (reads && names) {
            return {
                action: 'block',
                reason: "Shell command '" +
                    target +
                    "' was refused: sourceReadEgress is 'declarations' and this command reads source content, " +
                    'which is an implementation egress by another route. Read the declaration path directly instead.',
            };
        }
        // A DIRECTORY SCOPE, which the reference test above cannot see: `rg SECRET src` reads content and names
        // no extension-bearing file, so it used to reach the allow below while the search route had refused the
        // same shape since its own directory branch landed (SECURITY-REVIEW-4 [7]).
        //
        // Deliberately narrower than `reads`: a command that lists a directory (`Get-ChildItem src`) reads no
        // content and stays allowed, and one that reads a file it names is already refused above.
        if (reads && input.commandReadsDirectoryScope?.(target) === true) {
            return {
                action: 'block',
                reason: "Shell command '" +
                    target +
                    "' was refused: sourceReadEgress is 'declarations' and this command searches a directory, " +
                    'which reads source content by another route. Search a scope whose reach avoids source, or read ' +
                    'the declaration path directly instead.',
            };
        }
        // FAIL CLOSED ON QUOTING THE TOKENIZER COULD NOT RESOLVE (SECURITY-REVIEW-5 [2]). An unclosed quote
        // means the argument list is not knowable, and an argument this route cannot name is one it cannot
        // clear. Refused rather than treated as "no directory found", which is what the whitespace split did.
        if (reads && input.commandScopeUnparseable?.(target) === true) {
            return {
                action: 'block',
                reason: "Shell command '" +
                    target +
                    "' was refused: sourceReadEgress is 'declarations' and its quoting could not be parsed " +
                    'deterministically, so the arguments it names cannot be shown to avoid source. Close the ' +
                    'quotes, or read the declaration path directly instead.',
            };
        }
        // FAIL CLOSED WHEN THE BASE ITSELF IS A GUESS, and this is the last door it was standing open in
        // (docs/findings.md, "A shell search never asked whether the workspace was established"). A shell
        // command is the one route where the scope the host will resolve never reaches this evaluator as a
        // scope: `grep TODO docs/findings.md` carries a path inside a command string. Measured with the cwd
        // outside the workspace -- the ordinary case, since the fallback is what `resolveWorkspaceDir` returns
        // when the host exposes no workspace -- the search route refused that same file as unresolved against a
        // base nobody had established, while this route served it, and `rg TODO docs` was allowed where a
        // proven base refuses it because the directory predicate answers against the same guess.
        //
        // Asked AFTER the three refusals above, not before. Those three are true whatever the base turns out to
        // be, so a later change to the base question must not be able to hide them behind itself. What was
        // fail-open here is the `allow` this replaces; that is the line that had to stop being reachable.
        //
        // Gated on `reads`, so a command that only lists (`Get-ChildItem src`) keeps its allow -- there are no
        // bytes to leak and the base is irrelevant to it.
        if (reads) {
            const unverifiedShell = refuseUnverifiedBase(target, 'Shell command');
            if (unverifiedShell)
                return unverifiedShell;
        }
        return { action: 'allow' };
    }
    // 6. Anything that neither reads, searches nor shells is not an egress route.
    return { action: 'allow' };
}
