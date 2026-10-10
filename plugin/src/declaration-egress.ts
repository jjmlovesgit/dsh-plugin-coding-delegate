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
  reason?: string
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

/** True when this file's extension is one declarations mode can serve a skeleton for. */
function mappableSourceFile(filePath: string): boolean {
  return MAPPABLE_SOURCE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())
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
    if (scope && !(input.isCodeExtension ? input.isCodeExtension(scope) : false)) {
      return { action: 'allow' }
    }
    return {
      action: 'block',
      reason: scope
        ? "Searching '" +
          scope +
          "' was refused: sourceReadEgress is 'declarations' and a search returns matched source lines, " +
          'which are implementation bodies. Read the declaration path directly instead.'
        : "A search with no stated scope was refused: sourceReadEgress is 'declarations' and the search's " +
          'reach cannot be shown to avoid source. Narrow it to a non-source path, or read a declaration ' +
          'path directly.',
    }
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
