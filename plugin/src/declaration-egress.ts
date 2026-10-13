import * as path from 'path'

/**
 * What a declarations-mode egress check decided.
 *
 * `action` and `skeleton` are the field names the committed oracle asserts on
 * (`plugin/tests/oracles/declaration-egress-scope.test.cjs`). They are not `decision`/`declarationPath`:
 * the test file is the frozen contract for this unit, so the implementation follows it rather than the
 * other way round.
 */
export interface DeclarationEgressVerdict {
  action: 'allow' | 'serve-declaration' | 'block'
  skeleton?: string
  /**
   * The declaration BYTES to serve when a route can only be refused by refusing -- a search, whose
   * output is matched lines from no single file. Structurally identical to `skeleton` in the read
   * branch's terms: `skeleton` names the artefact, this carries it.
   */
  declarationText?: string
  reason?: string
}

/** One file a directory or file scope was resolved into, and the declaration that stands for it. */
export interface ResolvedDeclaration {
  source: string
  skeleton: string
  exists: boolean
  text?: string
  /** A reason the declaration cannot stand for the source, from the injected staleness check. */
  staleReason?: string
}

export interface DeclarationEgressInput {
  toolKind: 'read' | 'search' | 'shell' | string
  /** The path argument for a read or a search scope; the command text for a shell command. */
  target: string
  sourceReadEgress?: 'source' | 'declarations' | string
  declarationRoot?: string
  /** Injected so this module does not depend on guard.ts internals. See `mappableSourceFile` below. */
  isCodeExtension?: (filePath: string) => boolean
  declarationPathFor?: (filePath: string, root?: string) => string | null
  commandReadsContent?: (cmd: string) => boolean
  commandNamesSource?: (cmd: string) => boolean
  /**
   * Is this scope a DIRECTORY rather than a file?
   *
   * WHY THE SEARCH BRANCH NEEDS IT, and what it closes. `isCodeExtension` answers with the scope's
   * extension, and a directory has none -- so `src` came back as "not code" and was allowed. MEASURED
   * against the built artefact before this input existed:
   *
   *     evaluateDeclarationEgress({toolKind:'search', target:'src', ...}) => {"action":"allow"}
   *
   * while `src/guard.ts` in the same tree blocked and `plugin/src/guard.ts` alone holds 167 lines
   * matching an implementation-body test. A search scoped to a directory therefore returned real
   * implementation lines to the context this mode exists to keep them from. An extension test cannot
   * see that, because the thing that makes a directory dangerous is what is UNDER it.
   */
  directoryScope?: (target: string) => boolean
  /**
   * The source files a scope names, resolved from disk: every file under it when it is a directory,
   * or itself when it is one source file. The empty list means positively resolved and no source
   * beneath. Omitted means the route cannot resolve a scope at all, which fails closed below.
   */
  listSourceFiles?: (scope: string) => string[]
  /** The declaration bytes for one source file, or its absence, plus any injected staleness verdict. */
  readDeclaration?: (sourceFile: string, root?: string) => Omit<ResolvedDeclaration, 'source' | 'skeleton'>
  /**
   * The SESSION WORKSPACE, which is the base every relative scope is resolved against.
   *
   * WHY THIS IS NOT `declarationRoot`, and why it is not the process cwd. `declarationRoot` is where the
   * built `.d.ts` files live; it says nothing about where the source does. The process cwd is where the
   * host happened to be launched -- and this repository has already paid for that substitution once: the
   * delegated-read gate resolved a relative target against the cwd instead of the workspace and was
   * therefore off in normal use, because the architect names paths relatively essentially always. The
   * same string, the same defect, one module over.
   */
  workspaceRoot?: string
  /** Does this RESOLVED path exist? Decides whether a non-code scope is an ordinary file or nothing. */
  pathExists?: (resolvedPath: string) => boolean
}

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
export function resolveScopePath(rawScope: string, workspaceRoot?: string): string {
  const raw = String(rawScope || '').trim()
  if (!raw) return ''
  if (path.isAbsolute(raw)) return path.normalize(raw)
  if (workspaceRoot && String(workspaceRoot).trim()) {
    return path.resolve(String(workspaceRoot), raw)
  }
  // No workspace named. The cwd is the only base left, and it is the wrong one in general -- which is
  // exactly why the caller is told, below, that a path-shaped scope cannot be cleared without it.
  return path.resolve(raw)
}

/**
 * Is this scope SHAPED like a path rather than like a phrase? A separator or an extension is the signal.
 *
 * It matters only in one place: an unresolved scope that looks like a path is treated as an escape
 * attempt rather than as prose, because "a file I could not find" and "a sentence" are the same string to
 * a resolver. Prose has no separator and no extension, so the two are separable in practice.
 */
function looksLikePath(scope: string): boolean {
  return scope.includes('/') || scope.includes('\\') || path.extname(scope).length > 0
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
const MAPPABLE_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

/**
 * True when this file's extension is one declarations mode can serve a skeleton for.
 *
 * THE `.d.` PREFIX IS EXCLUDED HERE, which the extension set above assumed and never got: `path.extname`
 * of `impl.d.ts` is `.ts`, so a declaration file passed the set's test and counted as SOURCE. Measured in
 * a directory holding both `impl.ts` and its `impl.d.ts`: the walk returned both, no skeleton can exist
 * for a declaration file (the mapping produced `impl.d.d.ts`), and the whole scope was refused -- a
 * legitimate search blocked by the one kind of file this mode exists to serve.
 */
function mappableSourceFile(filePath: string): boolean {
  const name = String(filePath || '').toLowerCase()
  if (/\.d\.(ts|mts|cts)$/.test(name)) return false
  return MAPPABLE_SOURCE_EXTENSIONS.has(path.extname(name))
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
function resolveDeclarations(
  input: DeclarationEgressInput,
  scope: string
): { resolved: ResolvedDeclaration[]; unresolved: string[] } {
  const listed = input.listSourceFiles!(scope)
  const sources = Array.isArray(listed) ? listed.filter((f) => mappableSourceFile(String(f))) : []

  const resolved: ResolvedDeclaration[] = []
  const unresolved: string[] = []
  for (const source of sources) {
    const skeleton = input.declarationPathFor
      ? input.declarationPathFor(source, input.declarationRoot)
      : null
    if (!skeleton) {
      unresolved.push(source + ' (no declaration path can be derived for it)')
      continue
    }
    let detail: Omit<ResolvedDeclaration, 'source' | 'skeleton'> = { exists: false }
    try {
      detail = input.readDeclaration ? input.readDeclaration(source, input.declarationRoot) : { exists: false }
    } catch {
      detail = { exists: false }
    }
    if (!detail || detail.exists !== true || typeof detail.text !== 'string') {
      unresolved.push(source + " (no type skeleton exists at '" + skeleton + "')")
      continue
    }
    // A stale declaration is refused rather than summarised away. index.ts applies the same rule for a
    // read: serving yesterday's signature while the caller believes it is current is the failure that
    // check exists to prevent, and a search must not become the route that skips it.
    if (detail.staleReason) {
      unresolved.push(source + ' (' + detail.staleReason + ')')
      continue
    }
    resolved.push({ source, skeleton, exists: true, text: detail.text })
  }
  return { resolved, unresolved }
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
export function evaluateDeclarationEgress(input: DeclarationEgressInput): DeclarationEgressVerdict {
  // 1. Not opted in. A total pass-through, for the reason above.
  if (input.sourceReadEgress !== 'declarations') return { action: 'allow' }

  const target = String(input.target || '')

  // 2. A declaration file is already the artifact this mode exists to serve, so reading one is ordinary.
  //    Checked before the tool kind because it is true for a read and for a search scope alike.
  if (target.toLowerCase().endsWith('.d.ts')) return { action: 'allow' }

  // 3. READS.
  if (input.toolKind === 'read') {
    const isCode = input.isCodeExtension ? input.isCodeExtension(target) : false
    if (!isCode) return { action: 'allow' }

    // Only a mappable extension may be redirected. Anything else that is still code -- Python, Go, Rust,
    // a shell script, SQL -- cannot be served as a skeleton by any build, so it is refused rather than
    // leaked. See MAPPABLE_SOURCE_EXTENSIONS for why this is not delegated to `declarationPathFor`.
    if (!mappableSourceFile(target)) {
      return {
        action: 'block',
        reason:
          "Reading '" +
          target +
          "' was refused: sourceReadEgress is 'declarations' and no type skeleton can be produced for " +
          path.extname(target).toLowerCase() +
          '. Serving the body would be the implementation leak this setting exists to prevent. Read the ' +
          'declaration path directly, or turn sourceReadEgress off in the profile patch (which needs a ' +
          'DSH restart).',
      }
    }

    const skeleton = input.declarationPathFor
      ? input.declarationPathFor(target, input.declarationRoot)
      : null
    if (!skeleton) {
      // Fail closed, which is the rule index.ts already applies to a read whose declaration is missing.
      return {
        action: 'block',
        reason:
          "Reading '" +
          target +
          "' was refused: sourceReadEgress is 'declarations' and no declaration path could be derived " +
          'for it. Implementation bodies are not served to this context.',
      }
    }
    return { action: 'serve-declaration', skeleton }
  }

  // 4. SEARCHES. A search returns matching LINES, so there is no whole file to substitute: the matched
  //    bytes are implementation bodies wherever they land. The scope decides, because a search confined
  //    to prose cannot reach code. An UNSTATED scope cannot be shown to be harmless and is refused --
  //    the opposite of the read branch, where an unstated target is simply not a read.
  if (input.toolKind === 'search') {
    const scope = target.trim()
    if (!scope) {
      return {
        action: 'block',
        reason:
          "A search with no stated scope was refused: sourceReadEgress is 'declarations' and the search's " +
          'reach cannot be shown to avoid source. Narrow it to a non-source path, or read a declaration ' +
          'path directly.',
      }
    }

    // A scope that names a source FILE keeps the rule the committed oracle pins for it -- a search over a
    // code file is refused rather than answered with the file's whole skeleton, which would answer a
    // question the caller did not ask. The directory route below is where the defect was.
    if (input.isCodeExtension ? input.isCodeExtension(scope) : false) {
      return {
        action: 'block',
        reason:
          "Searching '" +
          scope +
          "' was refused: sourceReadEgress is 'declarations' and a search returns matched source lines, " +
          'which are implementation bodies. Read the declaration path directly instead.',
      }
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
    const scopePath = resolveScopePath(scope, input.workspaceRoot)
    if (input.directoryScope ? input.directoryScope(scope) : false) {
      if (!input.listSourceFiles) {
        // An unresolvable directory cannot be cleared: "no source beneath" is a claim about the tree and
        // nothing here has looked at the tree. Fail closed, the rule the shell branch already states.
        return {
          action: 'block',
          reason:
            "Searching '" +
            scope +
            "' was refused: sourceReadEgress is 'declarations', that scope is a directory, and this " +
            'route cannot resolve it to the source files beneath it, so it cannot be shown to avoid ' +
            'source. Read a declaration path directly instead.',
        }
      }

      const { resolved, unresolved } = resolveDeclarations(input, scope)

      // Refused rather than served when any file beneath the scope has no declaration. Serving the rest
      // would answer a question about a tree by silently omitting part of it, and the caller cannot tell
      // which part is missing.
      if (unresolved.length) {
        return {
          action: 'block',
          reason:
            "Searching '" +
            scope +
            "' was refused: sourceReadEgress is 'declarations' and the scope holds source with no " +
            'servable type skeleton -- ' +
            unresolved.join('; ') +
            '. Implementation bodies are not served to this context. Build the declarations with ' +
            'npm run build, or search a narrower non-source path.',
        }
      }

      // Positively resolved to nothing: the resolver looked and there is no source beneath this scope, so
      // the search cannot return an implementation line. A control, so this route cannot pass by
      // refusing every directory.
      if (!resolved.length) return { action: 'allow' }

      const skeletons = resolved.map((r) => r.skeleton)
      return {
        action: 'serve-declaration',
        skeleton: skeletons.join(', '),
        declarationText: resolved
          .map((r) => '// Declaration file: ' + r.skeleton + '\n' + String(r.text).trim())
          .join('\n\n'),
        reason:
          'The scope resolves to ' +
          resolved.length +
          ' source file(s). Only their type declarations are served; implementation bodies are withheld ' +
          "by policy (sourceEgress: declarations).",
      }
    }

    // An existing path that is neither a directory nor a code file -- `docs/README.md` is the committed
    // oracle's case -- reads no source, so it stands. Asked about the RESOLVED path, so it does not depend
    // on the cwd either.
    if (input.pathExists && input.pathExists(scopePath)) return { action: 'allow' }

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
        reason:
          "Searching '" +
          scope +
          "' was refused: sourceReadEgress is 'declarations', the scope is shaped like a path, and it " +
          'does not resolve to anything under the session workspace, so its reach cannot be shown to ' +
          'avoid source. Check the path, or search a scope that exists.',
      }
    }

    // Prose: no separator, no extension, nothing on disk. It cannot reach source.
    return { action: 'allow' }
  }

  // 5. SHELL. Same leak by another door, with one difference that matters: a command that merely lists
  //    or tests reads no bytes, so there is nothing to leak and it is allowed through.
  if (input.toolKind === 'shell') {
    // An egress filter that cannot evaluate must not wave the read through. This is the rule
    // index.ts:1496 already states for a failed evaluation.
    if (!input.commandReadsContent || !input.commandNamesSource) {
      return {
        action: 'block',
        reason:
          "Shell command '" +
          target +
          "' was refused: sourceReadEgress is 'declarations' and the command could not be inspected for " +
          'content reads, so it cannot be cleared. Fail closed.',
      }
    }
    const reads = input.commandReadsContent(target) === true
    const names = input.commandNamesSource(target) === true
    if (reads && names) {
      return {
        action: 'block',
        reason:
          "Shell command '" +
          target +
          "' was refused: sourceReadEgress is 'declarations' and this command reads source content, " +
          'which is an implementation egress by another route. Read the declaration path directly instead.',
      }
    }
    return { action: 'allow' }
  }

  // 6. Anything that neither reads, searches nor shells is not an egress route.
  return { action: 'allow' }
}
