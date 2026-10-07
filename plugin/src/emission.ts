import * as fs from 'fs'
import * as path from 'path'
import { canonicalisePath, isPathWithin } from './paths'

export interface FileEmissionResult {
  path: string
  relativeName: string
  lines: number
  bytes: number
  /** How the change arrived: a whole file, or a delta against the file already there. */
  mode?: 'write' | 'patch'
  /** Search/replace blocks applied, when the emission was a patch. */
  hunks?: number
}

/** A delta block: the bytes to find, and what to put there instead. */
export interface SearchReplaceBlock {
  search: string
  replace: string
}

/**
 * The delta machinery lives in `delegation.ts`, which imports this module rather than the other way
 * round, so this module cannot import it. It is configured from the composition root instead.
 *
 * Both seams are closed by default: an unconfigured emission treats every fenced body as a whole file,
 * which is the pre-delta behaviour, and `applyPatch` refuses instead of guessing.
 */
let parsePatchBody: (body: string) => SearchReplaceBlock[] | null = () => null
let applyPatch: (content: string, blocks: SearchReplaceBlock[]) => { ok: boolean; content?: string; reason?: string } =
  () => ({
    ok: false,
    reason: 'the search/replace engine is not configured, so no patch can be applied',
  })

/** Called once by the composition root, which holds both halves of the delta machinery. */
export function configurePatchEngine(engine: {
  parse: (body: string) => SearchReplaceBlock[] | null
  apply: (content: string, blocks: SearchReplaceBlock[]) => { ok: boolean; content?: string; reason?: string }
}): void {
  parsePatchBody = engine.parse
  applyPatch = engine.apply
}

/**
 * The containment decision for one delegated write. `baseDir` is the session workspace
 * and `allowedRoots` is the operator's explicit extension list. Both sides are
 * canonicalised, so a symlink inside the workspace cannot be used to escape it.
 */
export function evaluateEmissionPath(
  resolvedPath: string,
  baseDir: string,
  allowedRoots: string[] = []
): { allowed: boolean; reason?: string } {
  const canonical = canonicalisePath(resolvedPath)
  const roots = [baseDir, ...allowedRoots].filter(
    (root) => typeof root === 'string' && root.trim().length > 0
  )
  for (const root of roots) {
    if (isPathWithin(canonicalisePath(root), canonical)) return { allowed: true }
  }
  return {
    allowed: false,
    reason:
      `Refused to write '${resolvedPath}': it resolves to '${canonical}', which is outside the session ` +
      `workspace '${path.resolve(baseDir)}'` +
      (allowedRoots.length > 0 ? ` and every configured emitAllowlist root` : '') +
      `. A delegated worker may only write inside its workspace; add the directory to emitAllowlist to permit it.`,
  }
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
export function extractAndEmitFiles(
  content: string,
  targetFilesHint?: string[] | string,
  baseDir: string = process.cwd(),
  allowedRoots: string[] = [],
  protectedPaths: string[] = []
): { filesWritten: FileEmissionResult[]; errors: string[]; cleanContent: string } {
  if (!content) return { filesWritten: [], errors: [], cleanContent: '' }

  const filesWritten: FileEmissionResult[] = []
  const emissionErrors: string[] = []
  const seenPaths = new Set<string>()

  function emitFile(filePath: string, fileCode: string) {
    if (!filePath || !fileCode) return
    const cleanPath = filePath.trim().replace(/^["']|["']$/g, '')
    const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath)

    // Containment first: the worker's fence header and the caller's targetFiles hints
    // both choose this path, so it is untrusted input. Absolute paths and `..` segments
    // used to escape the workspace silently; they are now refused and reported.
    const containment = evaluateEmissionPath(resolvedPath, baseDir, allowedRoots)
    if (!containment.allowed) {
      emissionErrors.push(String(containment.reason))
      console.warn(`[EMIT_FILE_BLOCKED] ${containment.reason}`)
      return
    }

    // Contract files belong to the architect. This is checked before anything is written, and it
    // covers every emission route -- the fenced header, the `// FILE:` marker, and the fallback --
    // because they all funnel through here.
    const protectedHit = protectedPaths.find(
      (p) => canonicalisePath(String(p)) === canonicalisePath(resolvedPath)
    )
    if (protectedHit) {
      emissionErrors.push(
        `Refused to write ${resolvedPath}: it is a contract file declared by the architect, and the ` +
          `executor may not modify the test that judges it.`
      )
      console.warn(`[EMIT_FILE_BLOCKED] contract file: ${resolvedPath}`)
      return
    }

    if (seenPaths.has(resolvedPath)) return
    seenPaths.add(resolvedPath)

    // A search/replace body is a delta against an existing file rather than a replacement for it. The
    // header syntax is shared, so the body decides the mode. An empty list means the body started a
    // patch and never finished it, which is refused rather than written over a real file.
    const patchBlocks = parsePatchBody(fileCode)
    if (patchBlocks) {
      if (!fs.existsSync(resolvedPath)) {
        emissionErrors.push(
          `Refused to patch ${resolvedPath}: it does not exist, and a search/replace block edits a ` +
            `file rather than creating one.`
        )
        return
      }

      let original: string
      try {
        original = fs.readFileSync(resolvedPath, 'utf8')
      } catch (err: any) {
        emissionErrors.push(
          `Failed to read ${resolvedPath} for patching: ${err?.message || String(err)}`
        )
        return
      }

      const applied = applyPatch(original, patchBlocks)
      if (!applied.ok) {
        emissionErrors.push(`Refused to patch ${resolvedPath}: ${applied.reason}`)
        console.warn(`[EMIT_PATCH_BLOCKED] ${resolvedPath}: ${applied.reason}`)
        return
      }
      fileCode = applied.content as string
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
        const previousBytes = fs.statSync(resolvedPath).size
        const nextBytes = Buffer.byteLength(fileCode, 'utf8')
        if (previousBytes > 200 && nextBytes < previousBytes * 0.5) {
          emissionErrors.push(
            'Refused to overwrite ' + resolvedPath + ': new content is ' + nextBytes + 'B but the existing file is ' + previousBytes + 'B ' +
              '(more than 50% smaller). Delete the target explicitly or fix the worker output first.'
          )
          return
        }
      }

      const parentDir = path.dirname(resolvedPath)
      fs.mkdirSync(parentDir, { recursive: true })
      fs.writeFileSync(resolvedPath, fileCode, 'utf8')

      const lines = fileCode.split('\n').length
      const bytes = Buffer.byteLength(fileCode, 'utf8')
      const relativeName = path.relative(baseDir, resolvedPath) || cleanPath

      filesWritten.push({
        path: resolvedPath,
        relativeName,
        lines,
        bytes,
        mode: patchBlocks ? 'patch' : 'write',
        ...(patchBlocks ? { hunks: patchBlocks.length } : {}),
      })
    } catch (err) {
      const message = 'Failed to write ' + resolvedPath + ': ' + ((err as any)?.message || String(err))
      emissionErrors.push(message)
      console.warn('[EMIT_FILE_ERROR] ' + message)
    }
  }

  const FENCE = '\x60\x60\x60'
  const fileAttrRegex = new RegExp(
    FENCE + '[a-zA-Z0-9_-]*\\s+(?:file|filename)=["\']?([^"\'\\s\\n>]+)["\']?\\s*\\n([\\s\\S]*?)' + FENCE,
    'gi'
  )
  let match: RegExpExecArray | null
  while ((match = fileAttrRegex.exec(content)) !== null) {
    emitFile(match[1], match[2])
  }

  const fileMarkerRegex = new RegExp(
    FENCE + '[a-zA-Z0-9_-]*\\n(?://\\s*FILE:\\s*|#\\s*FILE:\\s*|/\\*\\s*FILE:\\s*|\\[FILE:\\s*)([^\\s\\n\\*\\]]+)(?:\\s*\\*/|\\])?\\n([\\s\\S]*?)' + FENCE,
    'gi'
  )
  while ((match = fileMarkerRegex.exec(content)) !== null) {
    emitFile(match[1], match[2])
  }

  if (filesWritten.length === 0 && targetFilesHint) {
    const hints = Array.isArray(targetFilesHint)
      ? targetFilesHint
      : typeof targetFilesHint === 'string'
      ? [targetFilesHint]
      : []

    const allCodeBlocks: string[] = []
    const FENCE = '\x60\x60\x60'
    const genericCodeBlockRegex = new RegExp(FENCE + '[a-zA-Z0-9_-]*\\n([\\s\\S]*?)' + FENCE, 'gi')
    let cbMatch: RegExpExecArray | null
    while ((cbMatch = genericCodeBlockRegex.exec(content)) !== null) {
      if (cbMatch[1].trim()) {
        allCodeBlocks.push(cbMatch[1])
      }
    }

    if (allCodeBlocks.length > 0) {
      for (let i = 0; i < hints.length; i++) {
        const hintPath = hints[i]
        const code = allCodeBlocks[i] || allCodeBlocks[0]
        if (hintPath && code) {
          emitFile(hintPath, code)
        }
      }
    } else if (content.trim() && hints.length > 0) {
      // Only write unreferenced output when it actually looks like source code.
      // A worker that cannot read the target file may answer with prose or a
      // tool-call transcript; writing that over a real file destroys it.
      const body = content.trim()
      const toolCall = '<' + 'tool_call|<function=|<' + '/tool_call>'
      const proseOpen = "\\s*(?:I'll|I will|I've|Here(?:'s| is)|Sure|Certainly|Let me|First,|To do this)"
      const looksLikeProse =
        new RegExp(toolCall, 'i').test(body) || new RegExp('^' + proseOpen, 'im').test(body)
      const codeStart =
        '^(?://|#|<!--|/\\*|import\\s|export\\s|const\\s|let\\s|var\\s|function\\s|class\\s|interface\\s|type\\s|def\\s|package\\s|using\\s|public\\s|private\\s|<!DOCTYPE|<[a-zA-Z])'
      const looksLikeCode = new RegExp(codeStart, 'm').test(body)
      if (looksLikeProse || !looksLikeCode) {
        emissionErrors.push(
          'Refused to write ' + hints[0] + ': worker output has no fenced code block and does not look like source code.'
        )
      } else {
        emitFile(hints[0], body)
      }
    }
  }

  return { filesWritten, errors: emissionErrors, cleanContent: content }
}