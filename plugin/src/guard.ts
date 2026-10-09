import * as fs from 'fs'
import * as path from 'path'
import { canonicalisePath, CODE_EXTENSIONS, isPathWithin } from './paths'
// The registry owns both the path index and the verdict attached to each file. This is a one-way edge:
// `contracts.ts` imports only `logging.ts` and `paths.ts`, and only `index.ts` and `roles.ts` import this
// module, so there is no cycle to resolve.
import { lookupDelegatedRecord, sha256File } from './contracts'
import type { DelegatedRecord } from './contracts'

/** Tools that write a file directly. */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit',
  'create_file', 'write_file', 'fs_write', 'notebook_edit',
])

/** Shell tools can write files as a side effect; detection is best-effort. */
const SHELL_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'terminal', 'run_command', 'pwsh_persistent', 'bash_persistent',
])

/**
 * Tools that read a file's contents into the caller's context. Exported because `describeSourceRead`
 * asks the same question — is this tool a read? — and two lists would drift.
 */
export const READ_TOOLS = new Set(['read', 'read_file', 'fs_read', 'view', 'view_file', 'cat'])

/**
 * Every delegated file `target` could name, canonical, however the caller spelled it.
 *
 * `canonicalisePath` resolves a relative path against the process cwd, and the process cwd is not the
 * session workspace: comparing the two as strings missed every relative target, which is how the
 * architect names files essentially always. The live gate therefore fired only for absolute paths --
 * reproduced against a file a delegated worker had just created, read back with no decision at all.
 *
 * The guard cannot be told the workspace. A tool call does not carry one, and the value lives in the
 * plugin context, which is exactly the coupling this module avoids so that it stays a pure function. So
 * the base is not assumed, it is searched: `resolvesTo` tests the target against every ancestor directory
 * of every delegated file. A delegated file always lives beneath its workspace, so the workspace is one
 * of those ancestors and the answer is recovered without being told.
 *
 * Which is why this returns a LIST rather than a boolean. The same relative target can name a file in
 * more than one workspace -- two temp workspaces both holding `plugin/src/thing.ts` -- and the guard has
 * no way to prefer one. Returning every candidate lets the caller answer with the worst of them instead
 * of silently taking whichever happened to be first.
 */
function matchDelegatedPaths(target: string, paths?: Iterable<string>): string[] {
  if (typeof target !== 'string' || !target) return []
  const canonical = canonicalisePath(target)
  const absolute = path.isAbsolute(target)
  const matches: string[] = []
  for (const p of paths ?? []) {
    const delegated = canonicalisePath(String(p))
    if (delegated !== canonical && (absolute || !resolvesTo(target, delegated))) continue
    if (!matches.includes(delegated)) matches.push(delegated)
  }
  return matches
}

/** Does `target`, read relative to some ancestor of `delegated`, name `delegated` itself? */
function resolvesTo(target: string, delegated: string): boolean {
  let dir = path.dirname(delegated)
  for (;;) {
    if (samePath(path.resolve(dir, target), delegated)) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Windows paths are case-insensitive; the rest are not. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Search tools return file content, so the read gate has to treat them as reads. This is the read
 * gate's copy of the vocabulary `READ_ONLY_INSPECTORS` already carries for the write guard: a tool
 * which reads files in one guard and is invisible in the other is how rule 3 was bypassed — an agent
 * was refused by the read guard and read the same files with search.
 */
export const SEARCH_TOOLS = new Set(['grep', 'rg', 'ripgrep', 'search', 'find_in_files', 'select-string'])

/**
 * A read names a path but a search names a pattern and a scope. `matchDelegatedPaths` matches file
 * identity, so a directory scope matched nothing and every workspace-wide search walked past the
 * rule. A relative scope can only be resolved against an ancestor directory of a delegated file
 * because the guard is never told the workspace, which is the same inference `resolvesTo` uses. An
 * empty scope returns every delegated path because a search with no path argument covers the
 * workspace.
 */
function delegatedUnder(scope: string, paths?: Iterable<string>): string[] {
  const all = [...(paths ?? [])]
  if (typeof scope !== 'string' || !scope.trim()) return all
  const absolute = path.isAbsolute(scope)
  const matches: string[] = []
  for (const p of all) {
    const delegated = String(p)
    let dir = path.dirname(delegated)
    for (;;) {
      const base = absolute ? path.resolve(scope) : path.resolve(dir, scope)
      const rel = path.relative(base, delegated)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (!matches.includes(delegated)) matches.push(delegated)
        break
      }
      if (absolute) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return matches
}

const DEFAULT_GUARD_ASK_PATHS = ['tests/', 'tools/']

export interface GuardVerdict {
  kind: 'deny' | 'ask'
  target: string
  reason: string
}

/**
 * The file a tool call names, from whichever argument shape that tool uses. Exported because `apply`
 * passes it to `describeSourceRead`, which asks the same question about the same call.
 */
export function extractWriteTarget(args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'filePath', 'path', 'filename', 'file', 'target_file', 'targetPath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function shellWriteTarget(command: string): string | undefined {
  if (typeof command !== 'string' || !command) return undefined
  const match = /(?:Set-Content|Add-Content|Out-File|New-Item|tee|>>?)\s+(?:-Path\s+)?["']?([^\s"'|;>)]+\.[A-Za-z0-9]{1,6})["']?/.exec(command)
  if (!match) return undefined
  return CODE_EXTENSIONS.has(path.extname(match[1]).toLowerCase()) ? match[1] : undefined
}

/** Script kinds a shell command can invoke. */
const SCRIPT_EXTENSIONS = new Set([
  '.ps1', '.psm1', '.sh', '.bash', '.zsh', '.cmd', '.bat',
  '.mjs', '.cjs', '.js', '.py', '.rb', '.pl',
])

/**
 * Write primitives, deliberately explicit rather than including a bare `>`.
 * A redirection pattern would match `=>` in every arrow function and turn any JS
 * file into a false positive.
 */
const WRITE_PRIMITIVES =
  /(?:Set-Content|Add-Content|Out-File|New-Item|WriteAllText|WriteAllBytes|WriteAllLines|writeFileSync|writeFile|createWriteStream|copyFileSync|renameSync|fs\.appendFile)/i

/** A source-extension reference inside a script body. */
const CODE_REFERENCE = /[A-Za-z0-9_\-\\/.]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|c|cc|cpp|h|hpp|swift|php|scala|lua|dart|sh|bash|ps1|psm1|sql|html|htm|css|scss|vue|svelte)\b/i

/**
 * Write-capable constructs visible on a COMMAND LINE, not merely inside a script file
 * the guard can name. Previously only a script body was inspected, so inline program
 * text (`python -c`, `node -e`) and ordinary file verbs were invisible to the guard and
 * fell through to an allow.
 */
const COMMAND_WRITE_PRIMITIVES =
  /(?:\bSet-Content\b|\bAdd-Content\b|\bClear-Content\b|\bOut-File\b|\bNew-Item\b|\bCopy-Item\b|\bMove-Item\b|\bRename-Item\b|\bWriteAllText\b|\bWriteAllBytes\b|\bWriteAllLines\b|\bwriteFileSync\b|\bwriteFile\b|\bcreateWriteStream\b|\bappendFile\b|\bcopyFileSync\b|\brenameSync\b|\bshutil\.copy\b|\.write\s*\(|\bcp\b|\bmv\b|\bcopy\b|\bmove\b|\bren\b|\bdd\b|\bsed\s+-i\b|\bperl\s+-i\b|\bgit\s+(?:apply|checkout|restore|stash|clean)\b|\brobocopy\b|\bxcopy\b|\btruncate\b|\btee\b)/i
// Every alternative is word-anchored deliberately. Unanchored verbs match as SUBSTRINGS of
// unrelated words: `Move-Item` is a substring of `Remove-Item`, so a plain delete was being
// classified as a write signal. Anchoring also keeps `writeFile` from being read out of
// `writeFileSync` and vice versa.

/** Inline program text can write a file the command line never names. */
const INLINE_EVAL_FLAG = /(?:^|\s)(?:-e|-c|--eval|-Command|-EncodedCommand)(?=\s|$)/i

/**
 * Does this command line carry a write signal? A redirection counts only when it is a
 * real one: an `=>` in inline program text and a `2>&1` must not turn a read-only
 * command into an approval prompt.
 */
export function hasCommandWriteSignal(command: string): boolean {
  if (typeof command !== 'string' || !command) return false
  if (COMMAND_WRITE_PRIMITIVES.test(command)) return true
  if (INLINE_EVAL_FLAG.test(command)) return true
  return /(?:^|[^=\-])>>?(?![=&])/.test(command)
}

/**
 * Delete-capable constructs, checked against BOTH a command line and a script body.
 * Destroying a source file is at least as consequential as overwriting it, and the first
 * version of this guard left deletion entirely ungated. API-level removals are included
 * because inline program text (`python -c "os.remove(...)"`) never names a verb the
 * command line displays. Word-anchored for the same reason as the write list: unanchored,
 * `rm` matches inside unrelated paths and `Move-Item` matches inside `Remove-Item`.
 */
export const DELETE_PRIMITIVES =
  /(?:\bRemove-Item\b|\brm\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|\bunlink\b|\bshred\b|\bgit\s+rm\b|\bos\.remove\b|\bshutil\.rmtree\b|\bunlinkSync\b|\brmSync\b|\brmdirSync\b|\bfs\.unlink\b)/i

/** Does this command line or script body carry a delete signal? */
export function hasCommandDeleteSignal(text: string): boolean {
  return typeof text === 'string' && text.length > 0 && DELETE_PRIMITIVES.test(text)
}

/** Tokens in a command line that name a script file. */
function extractScriptPaths(command: string): string[] {
  if (typeof command !== 'string' || !command) return []
  return command
    .split(/[\s'"`|;&()]+/)
    .filter((token) => token && SCRIPT_EXTENSIONS.has(path.extname(token).toLowerCase()))
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
])

/**
 * The subset of inspectors that return file CONTENT, as opposed to names, sizes or existence.
 *
 * `READ_ONLY_INSPECTORS` answers "is this token read as data rather than invoked", which is a different
 * question from "does this command read bytes", and conflating the two made the read guard fire on
 * `Get-ChildItem` and `Test-Path`. That is fail-closed and therefore safe, but it costs the operator
 * every ordinary command in a workspace where anything has been delegated -- and a guard that cannot be
 * lived with is a guard that gets switched off, which loses the whole rule rather than the false positive.
 *
 * The line this draws is the one the containment inference actually needs: `delegatedUnder` exists
 * because a command scoped to a DIRECTORY can read every delegated file beneath it, and that is only
 * true of a command that returns contents. `Get-ChildItem src` lists names; `Get-Content src/*.ts`
 * returns bytes. Only the second may infer containment.
 *
 * What is deliberately NOT here: `stat`, `wc`, `file`, `diff`, `test-path`, `get-childitem`, `ls`,
 * `dir`. Those report metadata or compare handles, and treating them as readers would put the false
 * positive back.
 */
const CONTENT_READERS = new Set([
  'select-string', 'get-content', 'gc', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'grep', 'rg', 'findstr', 'strings', 'od', 'xxd',
])

/** Does this command read file CONTENT, rather than list, test or compare? */
function commandReadsContent(command: string): boolean {
  return command
    .split(/[\s'"|;&()]+/)
    .filter(Boolean)
    .some((token) => CONTENT_READERS.has(token.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')))
}

/**
 * Delegated files that sit under the directory an ABSOLUTE token names.
 *
 * `delegatedUnder` covers a token that names the delegated file's own parent, and `matchDelegatedPaths`
 * covers a token that names the file. Neither covers a token that names a GLOB inside a delegated
 * directory, which is the shape a reader most often uses: `Get-Content 'C:\ws\src\*.ts'` is neither the
 * directory nor any single file, so with containment restricted to content readers it slipped past both
 * and read delegated bytes without a grant. Found by this suite, and the reason the containment has an
 * explicit absolute form rather than relying on the two inferences above to happen to meet.
 */
function delegatedUnderDirectory(token: string, paths?: Iterable<string>): string[] {
  if (!path.isAbsolute(token)) return []
  const root = path.dirname(token)
  const matches: string[] = []
  for (const p of paths ?? []) {
    const delegated = String(p)
    if (isPathWithin(root, delegated) && !matches.includes(delegated)) matches.push(delegated)
  }
  return matches
}

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
function isReadArgument(command: string, script: string): boolean {
  const at = command.indexOf(script)
  if (at < 0) return false
  const before = command.slice(0, at)
  const boundary = Math.max(
    before.lastIndexOf(';'),
    before.lastIndexOf('|'),
    before.lastIndexOf('&'),
    before.lastIndexOf('\n')
  )
  const statement = before.slice(boundary + 1)
  return statement
    .split(/[\s'"`()]+/)
    .filter(Boolean)
    .some((word) => {
      const bare = path.basename(word).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
      return READ_ONLY_INSPECTORS.has(bare)
    })
}

/**
 * A delegated file named by a read-only inspector in a shell command is the same read by another
 * route. Only delegated paths are tested, so this cannot reintroduce the false positive that made
 * `Select-String some.js` look like a script invocation.
 */
function findDelegatedRead(
  command: string,
  paths?: Iterable<string>
): { form: string; matches: string[] } | undefined {
  if (typeof command !== 'string' || !command || !paths) return undefined
  let form: string | undefined
  const matches: string[] = []
  for (const p of paths) {
    const canonical = canonicalisePath(String(p))
    const forms = [canonical, canonical.replace(/\\/g, '/')]
    // The same search as matchDelegatedPaths, in the form a command string needs: each way of spelling
    // the file relative to one of its ancestors. A single-segment name is skipped, because a bare
    // filename appears in commands that have nothing to do with the file.
    let dir = path.dirname(canonical)
    for (;;) {
      const relative = path.relative(dir, canonical)
      if (relative.includes(path.sep)) forms.push(relative, relative.replace(/\\/g, '/'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const candidate of forms) {
      if (command.includes(candidate) && isReadArgument(command, candidate)) {
        if (form === undefined) form = candidate
        if (!matches.includes(canonical)) matches.push(canonical)
        break
      }
    }
  }
  return form === undefined ? undefined : { form, matches }
}

/**
 * The longest source-extension reference in a string.
 *
 * The guard previously took the FIRST match, so a command whose prose happened to contain
 * something extension-shaped — an explanation mentioning `(.ts)` — reported that fragment as
 * the target instead of the real path.
 */
function longestCodeReference(text: string): string | undefined {
  const scanner = new RegExp(CODE_REFERENCE.source, 'gi')
  let longest: string | undefined
  for (const match of text.matchAll(scanner)) {
    if (longest === undefined || match[0].length > longest.length) longest = match[0]
  }
  return longest
}

function resolveScriptPath(script: string): string {
  return path.isAbsolute(script) ? script : path.resolve(process.cwd(), script)
}

/** Size-capped read; a missing or unreadable script simply yields no finding. */
function defaultReadScript(script: string): string | undefined {
  try {
    const resolved = resolveScriptPath(script)
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > 512 * 1024) return undefined
    return fs.readFileSync(resolved, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Follow script invocations looking for a script that writes source files.
 * Bounded depth and a visited set, so a script that invokes itself terminates.
 */
function findWriteViaScript(
  command: string,
  readScript: (script: string) => string | undefined,
  depth: number,
  visited: Set<string> = new Set()
): { script: string; target: string } | null {
  if (depth <= 0) return null

  for (const script of extractScriptPaths(command)) {
    // A file named in order to be READ is not a script being invoked.
    if (isReadArgument(command, script)) continue

    const resolved = resolveScriptPath(script)
    if (visited.has(resolved)) continue
    visited.add(resolved)

    const body = readScript(script)
    if (!body) continue

    // Both signals are required: a mutation primitive (write or delete) AND a source reference.
    if (WRITE_PRIMITIVES.test(body) || DELETE_PRIMITIVES.test(body)) {
      const target = longestCodeReference(body)
      if (target) return { script, target }
    }

    const nested = findWriteViaScript(body, readScript, depth - 1, visited)
    if (nested) return nested
  }

  return null
}

export type DelegateReadPolicy = 'ask' | 'allow' | 'deny'

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
export function evaluateDelegatedReadPolicy(policy: DelegateReadPolicy = 'ask'): {
  kind: 'allow' | 'ask' | 'deny'
  reason: string
} {
  if (policy === 'allow') {
    return {
      kind: 'allow',
      reason:
        'delegateReadPolicy is allow, which weakens rule 3: reading delegated source back into a ' +
        'context is permitted for every agent, because the host does not yet say which agent is which.',
    }
  }
  if (policy === 'deny') {
    return {
      kind: 'deny',
      reason: 'delegateReadPolicy is deny, so reading delegated source back is refused (rule 3).',
    }
  }
  return {
    kind: 'ask',
    reason: 'delegateReadPolicy is ask (the default), so this read needs an operator decision.',
  }
}

export interface SettledVerdict {
  allowed: boolean
  reason: string
}

/**
 * Is this delegated file settled -- written by a unit that passed, with its content unchanged since?
 *
 * `succeeded` alone is not the test, because a verdict describes CONTENT. A file that passed and was then
 * edited is not the version anything verified, so the hash is compared too, and a file that cannot be
 * hashed fails closed rather than open. Pure and exported so the rule is testable without a registry.
 */
export function evaluateSettledFile(
  record: DelegatedRecord | undefined,
  currentHash: string | null
): SettledVerdict {
  if (!record) return { allowed: false, reason: 'the registry holds no verdict for it.' }
  if (record.outcome === 'UNIT_FLAKY') {
    // Named against the ORACLE rather than the code, because that is what disagreed. A contract that
    // passed on one run and failed on another has not established anything about the content, and the
    // run it passed is exactly the run that could have promoted a race condition.
    return {
      allowed: false,
      reason:
        'the contract that judged it disagreed with itself across repeated runs, so nothing has been established about its content.',
    }
  }
  if (record.outcome === 'UNIT_FAILED') {
    return { allowed: false, reason: 'the unit that wrote it failed verification.' }
  }
  if (record.outcome === 'UNIT_UNVERIFIED') {
    // Deliberately about the CONTRACT rather than about whether a command was written down, because a
    // registry record does not carry that distinction and guessing it produced a false statement here.
    // This message used to read "no verification command was given for the unit that wrote it", which was
    // wrong whenever the gate was what stopped the check -- a command had been given, and approval was
    // refused. Both are cases of a contract that was never checked, which is the fact the reader needs.
    return {
      allowed: false,
      reason: 'the unit that wrote it was never verified, so nothing has been established about its content.',
    }
  }
  // A hand-verified file reads back like a passing one, and the reason says which claim is behind it. The
  // promotion socket treats both as promotable because both are a human-or-machine judgement made against
  // recorded content; the read guard only needs to say that SOMEBODY with standing looked at it, and to
  // name which kind of somebody so the distinction is never lost in a log.
  if (record.outcome === 'OPERATOR_ATTESTED') {
    if (currentHash === null) {
      return { allowed: false, reason: 'its content could not be read, so nothing can be said about it.' }
    }
    if (record.sha256 !== currentHash) {
      return {
        allowed: false,
        reason:
          'its content changed after the operator attested it, so the attestation covers bytes that are no longer there.',
      }
    }
    const by = record.attestation?.operator
    return {
      allowed: true,
      reason: by
        ? 'an operator (' + by + ') attested this content and it is unchanged since.'
        : 'the registry holds an operator attestation for it.',
    }
  }
  if (record.outcome !== 'UNIT_PASSED' || record.succeeded !== true) {
    return { allowed: false, reason: 'the registry holds no verdict for it.' }
  }
  if (currentHash === null) {
    return { allowed: false, reason: 'its content could not be read, so nothing can be said about it.' }
  }
  if (record.sha256 !== currentHash) {
    return {
      allowed: false,
      reason:
        'its content changed after the verdict was reached, so it is not the version anything verified.',
    }
  }
  return { allowed: true, reason: 'a unit passed it and its content is unchanged since that verdict.' }
}

/**
 * Where the TYPE SKELETON for a source file lives, relative to a declarations root.
 *
 * This is the mapping that lets a read be served as declarations instead of implementation. It is a pure
 * string transform on purpose: the caller decides whether the result exists, because a mapping function
 * that silently invents a path is worse than one that returns the path it computed and lets the caller
 * refuse.
 *
 * Returns null for anything that is not a TypeScript or JavaScript source file, so a caller can treat null
 * as "this read is out of scope" rather than as a failure.
 *
 * The transform mirrors what `tsc --declaration --emitDeclarationOnly` emits for a `rootDir` of the source
 * directory: the tree below the root is preserved and only the extension changes.
 */
export function declarationPathFor(sourcePath: string, declarationRoot: string): string | null {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return null
  const extension = path.extname(sourcePath).toLowerCase()
  if (extension !== '.ts' && extension !== '.tsx' && extension !== '.js' && extension !== '.jsx') {
    return null
  }
  // A declaration file is already a skeleton; mapping it again would look for `x.d.d.ts`.
  if (sourcePath.toLowerCase().endsWith('.d.ts')) return null
  const withoutExtension = sourcePath.slice(0, sourcePath.length - extension.length)
  // The segment after the source root is what the declaration tree preserves. `src` is the root this
  // repository builds with, and a path that does not contain it maps from its own basename so that a
  // caller passing a bare filename still gets a sensible answer.
  const marker = 'src' + path.sep
  const normalised = withoutExtension.split('/').join(path.sep)
  const at = normalised.toLowerCase().lastIndexOf(marker.toLowerCase())
  const relative = at >= 0 ? normalised.slice(at + marker.length) : path.basename(normalised)
  return path.join(declarationRoot, relative + '.d.ts')
}

/**
 * The verdict for every delegated file a target could name: settled only when all of them are. Shared by
 * the read tool and the shell route so the two cannot drift into disagreeing about the same file, and
 * conservative because a relative target can genuinely name more than one -- the guard infers the
 * workspace rather than being told it, and taking the permissive match would wave a failed file through.
 */
function evaluateMatchedReads(
  matched: string[],
  config: { delegatedRecordFor?: (canonicalPath: string) => DelegatedRecord | undefined }
): SettledVerdict {
  const recordFor = config.delegatedRecordFor ?? lookupDelegatedRecord
  const unsettled: SettledVerdict[] = []
  for (const p of matched) {
    const verdict = evaluateSettledFile(recordFor(p), sha256File(p))
    if (!verdict.allowed) unsettled.push(verdict)
  }
  if (unsettled.length === 0) {
    return { allowed: true, reason: 'every matching delegated file is settled.' }
  }
  const extra =
    unsettled.length > 1 ? ` (${unsettled.length} delegated files could match this path.)` : ''
  return { allowed: false, reason: `${unsettled[0].reason}${extra}` }
}

/**
 * Decide whether a tool call would author source code from the cloud context.
 * Pure and exported so it can be unit-tested without a running server.
 * Returns null when the call has nothing to do with code authoring.
 */
export function evaluateCodeWriteGuard(
  exec: any,
  config: {
    askPaths?: string[]
    /** Injectable reader, so the script scan is testable without touching disk. */
    readScript?: (script: string) => string | undefined
    /** How deep to follow script-invokes-script (default 2). */
    scriptDepth?: number
    /** Paths a delegated worker wrote; reads of them are gated. Injectable for tests. */
    delegatedPaths?: Iterable<string>
    /**
     * How to find the record for a delegated file, by canonical path. Injectable so the settled rule can
     * be exercised against synthetic verdicts; the default reads the index the delegation itself wrote.
     */
    delegatedRecordFor?: (canonicalPath: string) => DelegatedRecord | undefined
    /** ask | allow | deny for reading a delegated file back. Defaults to ask. */
    delegateReadPolicy?: DelegateReadPolicy
    /** Paths the architect may author as the specification. Defaults to tests/. */
    contractPaths?: string[]
    /** allow | ask | deny for a write to a contract path. Defaults to ask. */
    contractWriteMode?: 'allow' | 'ask' | 'deny'
  } = {}
): GuardVerdict | null {
  const name = String(exec?.name || '')
  const args = exec?.arguments
  const askPaths =
    config.askPaths && config.askPaths.length > 0 ? config.askPaths : DEFAULT_GUARD_ASK_PATHS

  const reason = (target: string) =>
    `Writing source file '${target}' from the cloud context is blocked by the local-only code guard. ` +
    `Delegate new files to the local worker with delegate_worker, passing targetFiles and workspaceDir. ` +
    `The worker has no repository read, so it cannot modify an existing file; plan that as a delta.`

  // Reading a file the architect delegated pulls that code back into its context, which is the noise
  // delegation exists to keep out. But not every delegated file is noise: one a unit passed and nothing
  // has touched since is finished work, and reading source in order to engineer is what the architect is
  // for. The rule is settled versus in-flight, and it says which one it applied.
  // A read names a path, a search names a pattern and a scope, and a shell command names whatever its arguments name — so the candidates are gathered per case and then judged by the one rule the branch already applied.
  const readCall = ((): { target: string; matched: string[] } | null => {
    if (READ_TOOLS.has(name)) {
      const target = extractWriteTarget(args)
      if (!target) return null
      return { target, matched: matchDelegatedPaths(target, config.delegatedPaths) }
    }
    if (SEARCH_TOOLS.has(name)) {
      const a = (args ?? {}) as Record<string, unknown>
      const scope = String(a.path ?? a.file_path ?? a.target ?? '')
      const matched = [
        ...matchDelegatedPaths(scope, config.delegatedPaths),
        ...delegatedUnder(scope, config.delegatedPaths),
      ].filter((v, i, all) => all.indexOf(v) === i)
      return { target: scope || '(workspace)', matched }
    }
    if (SHELL_TOOLS.has(name)) {
      const command = String(((args ?? {}) as Record<string, unknown>).command ?? '')
      if (!command) return null
      // A shell command has to actually read something to count as a read. Without this, any command
      // that merely names a directory containing delegated files would prompt — `npm --prefix plugin run build`,
      // even `cd plugin` — and a gate that fires on ordinary commands is one an operator turns off.
      const hasReadSignal = command
        .split(/[\s'"|;&]+/)
        .some((t) => READ_ONLY_INSPECTORS.has(t.toLowerCase()))
      if (!hasReadSignal) return null
      const matched: string[] = []
      // Containment is only inferred for a command that returns CONTENT. A command that merely lists or
      // tests a directory reads no delegated bytes, so matching it would gate ordinary housekeeping --
      // and the fail-closed argument does not apply, because there is nothing to fail closed about.
      const infersContainment = commandReadsContent(command)
      for (const token of command.split(/[\s'"]+/)) {
        if (!token || token.length < 2 || token.startsWith('-')) continue
        for (const hit of matchDelegatedPaths(token, config.delegatedPaths)) {
          if (!matched.includes(hit)) matched.push(hit)
        }
        if (!infersContainment) continue
        for (const hit of delegatedUnder(token, config.delegatedPaths)) {
          if (!matched.includes(hit)) matched.push(hit)
        }
        for (const hit of delegatedUnderDirectory(token, config.delegatedPaths)) {
          if (!matched.includes(hit)) matched.push(hit)
        }
      }
      return matched.length ? { target: command.slice(0, 80), matched } : null
    }
    return null
  })()

  if (readCall && readCall.matched.length > 0) {
    const target = readCall.target
    const matched = readCall.matched

    // The setting is the ceiling and is checked first, so both hatches keep working exactly as they did:
    // 'allow' is the documented rule-3 weakening, and 'deny' refuses even settled work.
    const delegatedRead = evaluateDelegatedReadPolicy(config.delegateReadPolicy)
    if (delegatedRead.kind === 'allow') return null
    if (delegatedRead.kind === 'deny') {
      return {
        kind: 'deny',
        target,
        reason: `'${target}' was written by a delegated worker. ${delegatedRead.reason}`,
      }
    }

    const settled = evaluateMatchedReads(matched, config)
    if (settled.allowed) return null

    return {
      kind: 'ask',
      target,
      reason:
        `'${target}' was written by a delegated worker and is not settled: ${settled.reason} Reading it ` +
        `pulls that code into the cloud architect's context, and the worker has no repository read, so it ` +
        `cannot summarise the file back instead. Approve only if you need the contents here, or re-plan ` +
        `the unit so that it does not.`,
    }
  }

  if (WRITE_TOOLS.has(name)) {
    const target = extractWriteTarget(args)
    if (!target) return null
    if (!CODE_EXTENSIONS.has(path.extname(target).toLowerCase())) return null

    const normalized = target.replace(/\\/g, '/').toLowerCase()

    // A contract test is the specification the worker is held to, not the implementation. Rule 2
    // forbids the architect authoring source and rule 7 needs the architect to own those tests, so
    // this is the one declared exception, and its scope is the operator's to widen or refuse.
    const contractPaths = config.contractPaths ?? ['tests/']
    const isContract = contractPaths.some((fragment) =>
      normalized.includes(String(fragment).replace(/\\/g, '/').toLowerCase())
    )
    if (isContract) {
      // Defaults to 'ask', not 'allow'. guardAskPaths already makes tests/ approval-eligible, and
      // silently withdrawing that prompt would be a weakening nobody asked for; opting in is explicit.
      const mode = config.contractWriteMode ?? 'ask'
      if (mode === 'allow') return null
      if (mode === 'deny') {
        return {
          kind: 'deny',
          target,
          reason:
            `'${target}' is a contract file, and contractWriteMode is 'deny'. A contract test is the ` +
            `specification the worker is held to, so this refusal is deliberate: set ` +
            `contractWriteMode: 'allow' to author contract files, or narrow contractPaths.`,
        }
      }
      // 'ask' falls through to the ordinary rule deliberately. Where guardAskPaths already makes this
      // path ask-eligible the write still asks, with the message it always had. Short-circuiting here
      // would have replaced the reason for every test write in the repository and broken assertions
      // that predate this carve-out by a long way -- which is exactly what it did on the first attempt.
    }

    const downgrade = askPaths.some((fragment) =>
      normalized.includes(String(fragment).replace(/\\/g, '/').toLowerCase())
    )
    return {
      kind: downgrade ? 'ask' : 'deny',
      target,
      reason:
        reason(target) +
        (downgrade ? ' This path is approval-eligible (architect-owned test/tooling).' : ''),
    }
  }

  if (SHELL_TOOLS.has(name)) {
    const command = args?.command ?? args?.script ?? ''

    const target = shellWriteTarget(command)
    if (target) {
      return {
        kind: 'ask',
        target,
        reason:
          `Shell command appears to write source file '${target}'. Shell-based writes cannot be ` +
          `attributed reliably, so this requires explicit approval; prefer delegate_worker for code work.`,
      }
    }

    // A script can write anything the command line never mentions, which is how the
    // plugin's own source was edited during development. Inspect what it invokes.
    const viaScript = findWriteViaScript(
      command,
      config.readScript ?? defaultReadScript,
      config.scriptDepth ?? 2
    )
    if (viaScript) {
      return {
        kind: 'ask',
        target: viaScript.target,
        reason:
          `Shell command invokes '${viaScript.script}', which appears to write source file ` +
          `'${viaScript.target}'. Script-mediated writes are invisible to a command-line scan, ` +
          `so this requires explicit approval; prefer delegate_worker for code work.`,
      }
    }

    // A command line that names a source file AND carries a write signal cannot be
    // cleared by matching the write target itself: `cp`, `git checkout`, a real
    // redirection, or inline program text all write a file the pattern never sees.
    const referenced = longestCodeReference(command)
    if (referenced) {
      const writes = hasCommandWriteSignal(command)
      const deletes = hasCommandDeleteSignal(command)
      if (writes || deletes) {
        return {
          kind: 'ask',
          target: referenced,
          reason:
            deletes && !writes
              ? `Shell command would delete source file '${referenced}'. Destroying source from the ` +
                `cloud context is gated the same way as writing it, so this requires explicit approval; ` +
                `prefer delegate_worker for code work.`
              : `Shell command names source file '${referenced}' and carries a write signal, so it may ` +
                `author source from the cloud context. Command-line inspection cannot prove otherwise, so ` +
                `this requires explicit approval; prefer delegate_worker for code work.`,
        }
      }
    }

    // Reading a delegated file through the shell is the same read by another route, so it answers to the
    // same rule: settled work passes, in-flight work asks.
    const delegatedRead = findDelegatedRead(command, config.delegatedPaths)
    if (delegatedRead) {
      const readPolicy = evaluateDelegatedReadPolicy(config.delegateReadPolicy)
      if (readPolicy.kind === 'allow') return null
      if (readPolicy.kind === 'deny') {
        return {
          kind: 'deny',
          target: delegatedRead.form,
          reason:
            `Shell command reads '${delegatedRead.form}', which a delegated worker wrote. ` +
            `${readPolicy.reason}`,
        }
      }
      const settled = evaluateMatchedReads(delegatedRead.matches, config)
      if (settled.allowed) return null
      return {
        kind: 'ask',
        target: delegatedRead.form,
        reason:
          `Shell command reads '${delegatedRead.form}', which a delegated worker wrote, and it is not ` +
          `settled: ${settled.reason} Reading it pulls that code into the cloud architect's context, and ` +
          `the worker has no repository read to summarise it back instead. Approve only if you need the ` +
          `contents here.`,
      }
    }

    return null
  }

  return null
}
