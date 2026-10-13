import * as path from 'path'
import * as fs from 'fs'
import {
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  longestCodeReference,
  commandReadsContent,
  declarationPathFor,
  staleDeclarationReason,
} from './guard'
// CODE_EXTENSIONS is declared in ./paths and is deliberately not re-exported from ./guard, so it is
// imported from its own module. Importing it from './guard' fails to compile.
import { CODE_EXTENSIONS } from './paths'
import { evaluateDeclarationEgress } from './declaration-egress'

/**
 * The wiring for declarations-mode egress control, kept out of `index.ts` on purpose.
 *
 * WHY THIS MODULE EXISTS. The control was first written inline in `index.ts`'s
 * `tools/post-execute` handler, and it only ever inspected READ_TOOLS -- so a search or a shell command
 * returned raw implementation bodies to the architect with nothing looking at them. Extending the
 * inline handler meant a large, multi-region edit in the plugin's largest file. Extracting the decision
 * to here makes the call site two lines and leaves the classification, the argument extraction and the
 * dispatch testable without a host.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not serve declarations for READS. `index.ts` already does
 * that, and its read branch does two things this module must not bypass --
 *
 *   1. it refuses a STALE declaration (`staleDeclarationReason`), so the architect cannot be served
 *      yesterday's signature while believing it is current, and
 *   2. it prefixes the served text with the "SERVED AS TYPE DECLARATIONS, NOT SOURCE" banner that
 *      `egress-guard.test.cjs` asserts on.
 *
 * So a read returns null here and falls through to the path that is already covered by tests.
 *
 * WHAT IT DOES SERVE, added with the directory-scope fix: the declarations for a SEARCH whose scope
 * resolved to source files. Refusing was the whole of this module's power over a search until the
 * evaluator was given the tree -- a scope like `src` names no file to redirect, and refusing it left the
 * caller with nothing. The evaluator now walks the scope, so the same banner and the same staleness rule
 * the read branch applies are applied to the resolved declarations here, and implementation bytes never
 * cross on this route either.
 */

export interface PostExecuteExec {
  name?: string
  arguments?: Record<string, unknown>
}

export interface PostExecuteOptions {
  sourceReadEgress?: string
  declarationRoot?: string
}

export interface EgressHookResult {
  kind: 'accept'
  content: Array<{ type: 'text'; text: string }>
}

/**
 * Decide whether this tool call may return its output under declarations mode.
 *
 * Returns a replacement decision when the call must be refused, or null when it may proceed. A null is
 * the caller's signal to keep going, which is why every pass-through path returns null rather than a
 * decision: the handler's contract is (exec, result, next) => decision, and a decision invented here
 * would replace the tool's real output with nothing.
 */
export function handleDeclarationPostExecute(
  exec: PostExecuteExec,
  options?: PostExecuteOptions
): EgressHookResult | null {
  // The setting is the ceiling and is checked first, so this is a complete no-op for anyone who has not
  // opted in. index.ts also gates registration on the same value; both checks are kept because a
  // mis-ordered load must not be able to turn the control off.
  if (options?.sourceReadEgress !== 'declarations') return null

  const name = String(exec?.name || '')
  if (!name) return null

  let toolKind: 'read' | 'search' | 'shell' | 'other' = 'other'
  if (READ_TOOLS.has(name)) toolKind = 'read'
  else if (SEARCH_TOOLS.has(name)) toolKind = 'search'
  else if (SHELL_TOOLS.has(name)) toolKind = 'shell'

  // Not an egress route, and -- for a read -- handled by index.ts's own branch, which does more than
  // this module can. See the note at the top.
  if (toolKind !== 'search' && toolKind !== 'shell') return null

  // Reads carry `path`, searches carry a scope, shell commands carry `command`. Reading the wrong field
  // yields an empty target, which the evaluator treats as scope-free and refuses -- a fail-closed but
  // wrong answer, so the extraction is per kind rather than guessed.
  const args: any = exec?.arguments ?? {}
  const target =
    toolKind === 'search'
      ? String(args.path ?? args.directory ?? args.target ?? '')
      : String(args.command ?? args.cmd ?? '')

  // CODE_EXTENSIONS is a Set of EXTENSIONS, not of paths. Testing a whole path against it returns false
  // for every source file and would silently disable the gate, so the extension is derived here.
  const isCodeExtension = (p: string): boolean =>
    CODE_EXTENSIONS.has(path.extname(String(p)).toLowerCase())

  // longestCodeReference returns the longest code-looking token, or undefined. The evaluator wants a
  // predicate, so presence becomes a boolean here rather than a second vocabulary of source extensions.
  const commandNamesSource = (cmd: string): boolean => longestCodeReference(cmd) !== undefined

  // THE SCOPE IS A PATH, AND A DIRECTORY IS A PATH WITH NO EXTENSION. The evaluator needs to be told
  // which of the two it is holding, because an extension test answers "not code" for `src` -- MEASURED
  // before this wiring existed, `{toolKind:'search', target:'src'}` came back `{"action":"allow"}` while
  // `src/guard.ts` was refused. `statSync` is the only thing that can tell the two apart, and it is
  // consulted here rather than inside the evaluator so the decision stays testable without a disk.
  const directoryScope = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      // A scope that does not exist beneath the process cwd is not a directory this route can resolve,
      // so it is not cleared here and falls through to the extension test.
      return false
    }
  }

  // The source files a scope names. A directory is walked; a file is itself. An unreadable branch is
  // reported as no source rather than as an error, and that is deliberate: the walk answers "which files
  // can the caller's search reach", so a subtree the harness cannot read is a subtree the search cannot
  // return bytes from either. Anything the walk genuinely cannot tell apart fails closed in the
  // evaluator instead -- a missing declaration for a file it DID find is refused there, not here.
  const listSourceFiles = (scope: string): string[] => {
    const found: string[] = []
    const walk = (p: string): void => {
      let entries: fs.Dirent[]
      let isDirectory = false
      try {
        const stat = fs.statSync(p)
        isDirectory = stat.isDirectory()
        if (!isDirectory && !stat.isFile()) return
        if (!isDirectory) {
          if (CODE_EXTENSIONS.has(path.extname(p).toLowerCase())) found.push(p)
          return
        }
        entries = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isFile()) walk(path.join(p, entry.name))
      }
    }
    walk(scope)
    return found
  }

  // The declaration bytes behind one source file, with the staleness verdict index.ts already applies to
  // a read. `exists:false` for anything unreadable, so a missing skeleton is refused rather than served.
  const readDeclaration = (
    sourceFile: string,
    root?: string
  ): { exists: boolean; text?: string; staleReason?: string } => {
    const skeleton = declarationPathFor(sourceFile, String(root || ''))
    if (!skeleton) return { exists: false }
    let text: string
    try {
      text = fs.readFileSync(skeleton, 'utf8')
    } catch {
      return { exists: false }
    }
    const staleReason = staleDeclarationReason(sourceFile, skeleton)
    return staleReason ? { exists: true, text, staleReason } : { exists: true, text }
  }

  const verdict = evaluateDeclarationEgress({
    toolKind,
    target,
    sourceReadEgress: options?.sourceReadEgress,
    declarationRoot: options?.declarationRoot,
    isCodeExtension,
    declarationPathFor,
    commandReadsContent,
    commandNamesSource,
    directoryScope,
    listSourceFiles,
    readDeclaration,
  })

  if (verdict.action === 'block') {
    return {
      kind: 'accept',
      content: [
        {
          type: 'text',
          text: String(verdict.reason || 'Egress blocked by declarations policy.'),
        },
      ],
    }
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
            text:
              '// SERVED AS TYPE DECLARATIONS, NOT SOURCE. Implementation bodies are withheld by policy ' +
              '(sourceEgress: declarations).\n// Declaration file(s): ' +
              String(verdict.skeleton || '') +
              '\n// ' +
              String(verdict.reason || '') +
              '\n\n' +
              verdict.declarationText,
          },
        ],
      }
    }
    return {
      kind: 'accept',
      content: [
        {
          type: 'text',
          text:
            "Reading '" +
            target +
            "' under sourceReadEgress 'declarations' is refused on this route: only a direct file read " +
            'can be redirected to a type skeleton, and a search or shell command cannot. Read the ' +
            'declaration path directly instead.',
        },
      ],
    }
  }

  return null
}
