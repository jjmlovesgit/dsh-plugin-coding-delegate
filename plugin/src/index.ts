import { Context } from 'cordis'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as child_process from 'child_process'
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker'
import { PROFILES, ProfileConfig, WORKER_BENCHMARKS, WORKER_BENCHMARK_SOURCE } from './profiles'
import { classifyLocally, SECRET_PATTERN_RULES, findHighEntropyTokens } from './local-classifier'

export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage }

export const inject = ['tools']
export const using = ['tools'] as const

export interface PluginConfig {
  localProvider?: string
  cloudProvider?: string
  localModel?: string
  cloudModel?: string
  contextTokenThreshold?: number
  contextThreshold?: number
  timeoutMs?: number
  enforceDLP?: boolean
  /**
   * What a tripped DLP firewall does with an outbound request: `'block'`
   * (default) refuses to transmit it, `'local'` reroutes it to the local worker.
   * Either way the credential never reaches the cloud.
   */
  dlpAction?: 'block' | 'local'
  /** Enable the high-entropy backstop (default true). */
  entropyCheck?: boolean
  /** Bits per character above which a token counts as suspiciously random (default 4.5). */
  entropyMinBitsPerChar?: number
  /** Minimum token length before entropy is scored (default 20). */
  entropyMinLength?: number
  /** Refuse cloud-authored writes to source files (default: true). */
  localCodeGuard?: boolean
  /** Force every guard hit to an approval prompt instead of a hard deny. */
  guardMode?: 'deny' | 'ask'
  /** Path fragments that downgrade a deny to an approval prompt. */
  guardAskPaths?: string[]
  /**
   * What happens to `delegate_worker`'s model-supplied `runVerification` command.
   * `'ask'` (default) routes it through the approval seam before anything executes;
   * `'allow'` restores the pre-hardening unattended behaviour; `'deny'` never runs it.
   */
  verificationApproval?: 'ask' | 'allow' | 'deny'
  /**
   * Verification programs (the command's first token) that skip the prompt under
   * `verificationApproval: 'ask'`. Weak by construction: it constrains the program,
   * not its arguments, so listing `node` also permits `node -e "<anything>"`.
   */
  verificationAllowlist?: string[]
  /**
   * Extra directories a delegated worker may write into besides the resolved session
   * workspace. Absolute worker paths and `..` escapes outside every allowed root are
   * refused and reported rather than written.
   */
  emitAllowlist?: string[]
  /**
   * Run the verification module inside the DSH server process when the sandbox denies
   * a piped spawn (default false). That fallback executes model-influenced code with
   * full host authority and can kill the server, so it is opt-in only.
   */
  allowInProcessFallback?: boolean
  /**
   * Base URL of the local OpenAI-compatible server that `delegate_worker` posts to — for
   * example `http://127.0.0.1:11434/v1` for Ollama, or a vLLM/llama.cpp port. A full
   * `/chat/completions` URL is also accepted. Defaults to `http://127.0.0.1:1234/v1`.
   *
   * This is operator configuration, deliberately separate from the tool's arguments: a
   * caller-supplied `endpoint` is ignored, because honouring it would let the model redirect
   * a task — and the file contents it carries — to any address.
   */
  localEndpoint?: string
}

export interface RouterMetadata {
  provider: string
  model?: string
  route: RouteType
  gate: string
  rationale: string
  tier: string
  estimatedTokens: number
  dlpViolations?: string[]
  scores?: {
    is_private: number
    complexity: number
    target: string
  }
  latencyMs?: number
  failover?: boolean
  previousProvider?: string
}

export interface LLMSession {
  provider?: string
  model?: string
  prompt?: string
  input?: string
  apiKey?: string
  reasoningEffort?: string
  messages?: Array<{ role: string; content: any }>
  options?: {
    provider?: string
    model?: string
    apiKey?: string
    reasoningEffort?: string
    [key: string]: any
  }
  metadata?: {
    router?: RouterMetadata
    [key: string]: any
  }
  redispatch?: () => Promise<any>
  retry?: () => Promise<any>
  [key: string]: any
}

/**
 * Resolve the Session Workspace root WITHOUT declaring a hard inject dependency.
 *
 * ctx.workspace does not exist in Cordis (reading it throws), and dsh-workspace
 * exposes a REGISTRY (ctx.workspaceRegistry), not a per-Session cwd. So probe the
 * known shapes in order and report WHERE the answer came from: silently falling
 * back to process.cwd() writes files into the server's own directory instead of
 * the Session workspace, which is far worse than failing loudly.
 */
function resolveWorkspaceDir(ctx: any): { dir: string; source: string } {
  for (const key of ['DSH_WORKSPACE_ROOT', 'DSH_WORKSPACE', 'WORKSPACE_ROOT']) {
    const candidate = process.env[key]
    if (typeof candidate === 'string' && candidate && fs.existsSync(candidate)) {
      return { dir: candidate, source: `env:${key}` }
    }
  }

  try {
    for (const serviceName of ['workspace', 'workspaceRegistry', 'workspaceFiles', 'session']) {
      const service = typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined
      if (!service) continue
      for (const prop of ['dir', 'cwd', 'root', 'path', 'workspaceDir']) {
        const value = (service as any)[prop]
        if (typeof value === 'string' && value && fs.existsSync(value)) {
          return { dir: value, source: `ctx.get('${serviceName}').${prop}` }
        }
      }
    }
  } catch {
    // service unavailable in this context - fall through to the cwd fallback
  }

  return { dir: process.cwd(), source: 'process.cwd() FALLBACK (not a Session workspace)' }
}
export const name = 'dsh-plugin-local-router'

/**
 * All plugin state (debug log, savings ledger) lives under one derived directory.
 * It must never be a hard-coded absolute path: the previous build wrote its log
 * into the plugin author's own project directory on every machine, which was
 * correct on exactly one of them.
 * Precedence: explicit env override, then DSH_HOME, then ~/.dsh.
 */
export function resolveDataDir(): string {
  const explicit = process.env.DSH_LOCAL_ROUTER_DATA_DIR
  if (explicit && explicit.trim()) return explicit.trim()
  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim()) return path.join(dshHome.trim(), 'local-router')
  return path.join(os.homedir(), '.dsh', 'local-router')
}

const LOG_FILE = path.join(resolveDataDir(), 'router-debug.log')

function trace(event: string, data: any) {
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] === ${event} ===\n${
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  }\n`

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, entry, 'utf8')
  } catch (err) {}
}

export const DELEGATE_WORKER_OPENAI_SCHEMA = {
  type: 'function',
  function: {
    name: 'delegate_worker',
    description:
      'Dispatches a discrete implementation, testing, or code-generation task to the local RTX 5090 execution worker (LM Studio) with an isolated context window.',
    parameters: {
      type: 'object',
      properties: {
        taskName: {
          type: 'string',
          description: 'A short descriptive identifier for the subtask',
        },
        instruction: {
          type: 'string',
          description: 'The complete technical prompt and specifications for the local worker',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to target or modify',
        },
        runVerification: {
          type: 'string',
          description:
            'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
        },
        workspaceDir: {
          type: 'string',
          description:
            'Absolute path of the directory the worker may write into. Defaults to the session workspace; destinations outside it are refused.',
        },
      },
      required: ['taskName', 'instruction'],
    },
  },
}

export const DELEGATE_WORKER_SCHEMA = DELEGATE_WORKER_OPENAI_SCHEMA

export function scanDLP(
  text: string,
  options: {
    entropyCheck?: boolean
    entropyMinBitsPerChar?: number
    entropyMinLength?: number
  } = {}
): { hasSensitiveData: boolean; violations: string[]; highConfidence: boolean } {
  if (!text) return { hasSensitiveData: false, violations: [], highConfidence: false }
  const violations: string[] = []

  // Shared with the classifier: an enforcing gate must not use a weaker rule set
  // than the classifier that reports alongside it (it previously did, which let
  // `password: "..."` through to the cloud).
  for (const { name, pattern } of SECRET_PATTERN_RULES) {
    if (pattern.test(text)) {
      violations.push(name)
    }
  }

  // A recognised shape or keyword-assigned value is high confidence.
  const highConfidence = violations.length > 0

  // The entropy backstop. Deliberately medium confidence: a high-entropy token may
  // equally be a digest or a base64 payload, so it must not hard-block a session.
  if (options.entropyCheck !== false) {
    const tokens = findHighEntropyTokens(text, {
      minBitsPerChar: options.entropyMinBitsPerChar,
      minLength: options.entropyMinLength,
    })
    if (tokens.length > 0) violations.push('High-entropy string')
  }

  return { hasSensitiveData: violations.length > 0, violations, highConfidence }
}

export interface FileEmissionResult {
  path: string
  relativeName: string
  lines: number
  bytes: number
}

/**
 * Resolve `p` to a canonical path, following symlinks for the part of it that exists.
 * A destination that does not exist yet has no realpath of its own, so the deepest
 * existing ancestor is resolved and the remaining segments are re-appended.
 */
function canonicalisePath(p: string): string {
  let current = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    if (fs.existsSync(current)) break
    const parent = path.dirname(current)
    if (parent === current) break
    tail.unshift(path.basename(current))
    current = parent
  }
  try {
    current = fs.realpathSync(current)
  } catch {
    // An unresolvable ancestor is not a reason to trust the path; keep it as written.
  }
  return tail.length > 0 ? path.join(current, ...tail) : current
}

/** True when `candidate` is `root` itself or lives beneath it. Case-insensitive on Windows. */
export function isPathWithin(root: string, candidate: string): boolean {
  const flatten = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const from = flatten(path.resolve(root))
  const to = flatten(path.resolve(candidate))
  if (from === to) return true
  const rel = path.relative(from, to)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
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

export function extractAndEmitFiles(
  content: string,
  targetFilesHint?: string[] | string,
  baseDir: string = process.cwd(),
  allowedRoots: string[] = []
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

    if (seenPaths.has(resolvedPath)) return
    seenPaths.add(resolvedPath)

    try {
      // Guard against clobbering: a model that cannot see the target file may return
      // a stub, and a wholesale rewrite far smaller than what is already there is
      // almost always damage rather than an edit.
      if (fs.existsSync(resolvedPath)) {
        const previousBytes = fs.statSync(resolvedPath).size
        const nextBytes = Buffer.byteLength(fileCode, 'utf8')
        if (previousBytes > 200 && nextBytes < previousBytes * 0.5) {
          emissionErrors.push(
            `Refused to overwrite ${resolvedPath}: new content is ${nextBytes}B but the existing file is ${previousBytes}B ` +
              `(more than 50% smaller). Delete the target explicitly or fix the worker output first.`
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
      })
    } catch (err) {
      const message = `Failed to write ${resolvedPath}: ${(err as any)?.message || String(err)}`
      emissionErrors.push(message)
      console.warn(`[EMIT_FILE_ERROR] ${message}`)
    }
  }

  const fileAttrRegex = /```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fileAttrRegex.exec(content)) !== null) {
    emitFile(match[1], match[2])
  }

  const fileMarkerRegex = /```[a-zA-Z0-9_-]*\n(?:\/\/\s*FILE:\s*|#\s*FILE:\s*|\/\*\s*FILE:\s*|\[FILE:\s*)([^\s\n\*\]]+)(?:\s*\*\/|\])?\n([\s\S]*?)```/gi
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
    const genericCodeBlockRegex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gi
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
      const looksLikeProse =
        /<tool_call|<function=|<\/tool_call>/i.test(body) ||
        /^\s*(?:I'll|I will|I've|Here(?:'s| is)|Sure|Certainly|Let me|First,|To do this)/im.test(body)
      const looksLikeCode =
        /^(?:\/\/|#|<!--|\/\*|import\s|export\s|const\s|let\s|var\s|function\s|class\s|interface\s|type\s|def\s|package\s|using\s|public\s|private\s|<!DOCTYPE|<[a-zA-Z])/m.test(
          body
        )
      if (looksLikeProse || !looksLikeCode) {
        emissionErrors.push(
          `Refused to write ${hints[0]}: worker output has no fenced code block and does not look like source code.`
        )
      } else {
        emitFile(hints[0], body)
      }
    }
  }

  return { filesWritten, errors: emissionErrors, cleanContent: content }
}

/** A failure described without source: enough to diagnose, not enough to leak code. */
export interface RedactedFailure {
  kind: 'assertion' | 'compile' | 'timeout' | 'runtime' | 'unknown'
  /** Subtest name, when the runner reports one. */
  name?: string
  /** file:line or file:line:col. */
  location?: string
  /** Runner or compiler error code, e.g. TS1434 or ERR_ASSERTION. */
  code?: string
  /** The assertion label, kept only when it reads as prose rather than code. */
  message?: string
}

export interface TestResults {
  passed: number
  failed: number
  /** Redacted summary. Raw output never leaves the machine by default. */
  output: string
  errorSummary?: string
  /** Structured failures: names, locations, error kinds. */
  failures?: RedactedFailure[]
  /** True when the output above was passed through the redactor. */
  redacted?: boolean
  /** Where the FULL raw output was written locally, for the worker and the operator. */
  rawOutputPath?: string
}

/**
 * Does this text look like source rather than a label? Assertion messages should be
 * prose; anything code-shaped is dropped rather than forwarded.
 */
function looksLikeCode(text: string): boolean {
  return (
    /[{};]/.test(text) ||
    /=>/.test(text) ||
    /\b(?:function|const|let|var|return|import|export|class|def|public|private)\b/.test(text) ||
    /\b(?:expected|actual)\b\s*[:=]/i.test(text)
  )
}

function cleanMessage(raw: string): string | undefined {
  const collapsed = String(raw).trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ')
  if (!collapsed || /^\|-?$/.test(collapsed)) return undefined
  if (looksLikeCode(collapsed)) return undefined
  return collapsed.length > 160 ? collapsed.slice(0, 157) + '...' : collapsed
}

/**
 * Reduce raw verification output to a source-free structure.
 *
 * Only named fields are ever copied out of a failure block; every other line inside it
 * (stack frames, expected/actual, diff markers, quoted code) is discarded by omission
 * rather than by pattern-matching each leak shape.
 */
export function redactVerificationOutput(raw: string): RedactedFailure[] {
  if (!raw) return []
  const failures: RedactedFailure[] = []
  let current: RedactedFailure | null = null
  const flush = () => {
    if (current && (current.name || current.location || current.code)) failures.push(current)
    current = null
  }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue

    const compile = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/.exec(t)
    if (compile) {
      flush()
      failures.push({
        kind: 'compile',
        location: `${compile[1]}:${compile[2]}:${compile[3]}`,
        code: compile[4],
        message: cleanMessage(compile[5]),
      })
      continue
    }

    const compile2 = /^error\s+(TS\d+):\s*(.*)$/.exec(t)
    if (compile2) {
      flush()
      failures.push({ kind: 'compile', code: compile2[1], message: cleanMessage(compile2[2]) })
      continue
    }

    const notOk = /^not ok\s+(\d+)\s*-\s*(.*)$/i.exec(t)
    if (notOk) {
      flush()
      current = { kind: 'assertion', name: `${notOk[1]}. ${notOk[2]}`.replace(/\s+/g, ' ').trim() }
      continue
    }

    if (current) {
      const loc = /^location:\s*(.+)$/.exec(t)
      if (loc) {
        current.location = loc[1].replace(/^['"]|['"]$/g, '').trim()
        continue
      }
      const code = /^code:\s*(.+)$/.exec(t)
      if (code) {
        current.code = code[1].replace(/^['"]|['"]$/g, '').trim()
        continue
      }
      const err = /^error:\s*(.*)$/.exec(t)
      if (err) {
        const message = cleanMessage(err[1])
        if (message) current.message = message
        continue
      }
      if (/timeout/i.test(t)) current.kind = 'timeout'
      // Everything else inside a failure block is deliberately not copied.
      continue
    }

    if (/AssertionError/.test(t)) {
      const message = cleanMessage(t)
      failures.push({ kind: 'assertion', ...(message ? { message } : {}) })
    }
  }

  flush()

  // Names, locations and codes are test- and model-controlled text and they travel to the
  // cloud. A TAP label can carry a credential as easily as a diff can, so every retained
  // field is put through the same secret rules the DLP gate uses. Counts and structure
  // still travel; only the offending value is replaced by a marker.
  return failures
    .map((failure) => {
      const bounded: RedactedFailure = { kind: failure.kind }
      const name = sanitizeRetainedField(failure.name)
      const location = sanitizeRetainedField(failure.location)
      const code = sanitizeRetainedField(failure.code, 40)
      const message = sanitizeRetainedField(failure.message, 300)
      if (name) bounded.name = name
      if (location) bounded.location = location
      if (code) bounded.code = code
      if (message) bounded.message = message
      return bounded
    })
    .filter((failure) => Boolean(failure.name || failure.location || failure.code || failure.message))
}

/**
 * Bound a retained field and strip anything the secret rules recognise. Entropy is on:
 * these strings are exactly what leaves the machine, so a high-entropy blob in a test
 * name must not ride along merely because it lacks a recognisable keyword.
 */
function sanitizeRetainedField(value: string | undefined, maxLength = 200): string | undefined {
  if (typeof value !== 'string') return undefined
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const scanned = scanDLP(collapsed)
  if (scanned.hasSensitiveData) return `[redacted: ${scanned.violations.join(', ')}]`
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) + ' [truncated]' : collapsed
}

/** One line per failure: kind, name, location, code, prose message. Never source. */
export function describeFailures(failures: RedactedFailure[]): string[] {
  return failures.map((f) => {
    const parts = [`- [${f.kind}]`]
    if (f.name) parts.push(f.name)
    if (f.location) parts.push('@ ' + f.location)
    if (f.code) parts.push(`(${f.code})`)
    if (f.message) parts.push(': ' + f.message)
    return parts.join(' ')
  })
}

export function parseTestOutput(
  output: string,
  exitCode?: number,
  options: { redact?: boolean; rawOutputPath?: string } = {}
): TestResults {
  if (!output) {
    // A silent command is only a success when it also exited cleanly.
    if (exitCode !== undefined && exitCode !== 0) {
      return {
        passed: 0,
        failed: 1,
        output: `command exited with code ${exitCode} and produced no output`,
        errorSummary: `exit code ${exitCode}`,
      }
    }
    return { passed: 0, failed: 0, output: '' }
  }

  let passed = 0
  let failed = 0
  const lines = output.split('\n')
  const failureLines: string[] = []

  const hasTap = lines.some((l) => /^ok\s+\d+|^not ok\s+\d+/i.test(l.trim()))

  if (hasTap) {
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^not ok\s+/i.test(trimmed)) {
        failed++
        failureLines.push(trimmed)
      } else if (/^ok\s+/i.test(trimmed)) {
        passed++
      }
    }
  } else {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/✓|✔|PASSED/i.test(trimmed) && !/FAILED|not ok/i.test(trimmed)) {
        passed++
      } else if (/(?:✕|✖|FAILED|AssertionError|Error:)/i.test(trimmed)) {
        failed++
        failureLines.push(trimmed)
      }
    }
  }

  // The exit code is authoritative. Unrecognized output must NEVER count as a pass:
  // `tsc` reports failures as "error TS1234:", which matches none of the markers
  // above, so the previous fallback turned a broken build into status SUCCESS.
  if (exitCode !== undefined && exitCode !== 0) {
    failed = Math.max(failed, 1)
    if (failureLines.length === 0) {
      failureLines.push(output.slice(0, 300) || `command exited with code ${exitCode}`)
    }
  } else if (passed === 0 && failed === 0) {
    if (
      output.includes('AssertionError') ||
      output.includes('Error:') ||
      output.includes('FAIL') ||
      /\berror\b/i.test(output)
    ) {
      failed = 1
      failureLines.push(output.slice(0, 300))
    } else {
      passed = 1
    }
  }

  // Raw output is a source-egress channel, so by default only structure is returned.
  // The full text is on disk (rawOutputPath) for the delegated worker to work from.
  const redact = options.redact !== false
  const failures = redact ? redactVerificationOutput(output) : []
  const described = describeFailures(failures)

  const headline = `${failed} failed, ${passed} passed` + (exitCode !== undefined ? ` (exit ${exitCode})` : '')
  const body = redact
    ? [
        headline,
        ...(described.length > 0 ? described.slice(0, 10) : failed > 0 ? ['- [unknown] no structured failure could be extracted; see the raw log'] : []),
        ...(options.rawOutputPath ? [`raw output: ${options.rawOutputPath}`] : []),
      ].join('\n')
    : output.slice(0, 2000)

  const summarySource = redact
    ? described.slice(0, 5).join('; ') || (failed > 0 ? 'unstructured failure; see the raw log' : undefined)
    : failureLines.length > 0
    ? failureLines.slice(0, 5).join('; ')
    : undefined

  return {
    passed,
    failed,
    output: body.slice(0, 2000),
    ...(summarySource ? { errorSummary: summarySource } : {}),
    ...(redact ? { failures, redacted: true } : { redacted: false }),
    ...(options.rawOutputPath ? { rawOutputPath: options.rawOutputPath } : {}),
  }
}

export function runInProcessFallback(cmd: string, workspaceDir: string): string {
  // Identify a real module path in the command, ignoring flags: the previous regex
  // captured "--test", "-e" and "--version" as if they were file paths, then
  // reported a bogus "target test file not found" failure for them.
  const candidates = cmd
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .filter((token) => token && !token.startsWith('-') && /\.(?:[cm]?[jt]sx?)$/i.test(token))

  const targetFile =
    candidates.find((token) =>
      fs.existsSync(path.isAbsolute(token) ? token : path.resolve(workspaceDir, token))
    ) ?? null

  if (!targetFile) {
    // Fail closed: with no identifiable target module there is nothing to verify,
    // and claiming success here would report an unverified command as passing.
    return `not ok 1 - In-process verification fallback could not identify a target module in command '${cmd}'. Refusing to report success.`
  }

  const resolvedPath = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceDir, targetFile)

  if (!fs.existsSync(resolvedPath)) {
    return `not ok 1 - Target test file '${targetFile}' not found at '${resolvedPath}'.`
  }

  let capturedOutput = ''
  const originalLog = console.log
  const originalError = console.error
  const originalExit = (process as any).exit
  const originalExitCode = process.exitCode

  try {
    console.log = (...args: any[]) => {
      capturedOutput += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
      originalLog(...args)
    }
    console.error = (...args: any[]) => {
      capturedOutput += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
      originalError(...args)
    }

    // This module runs in the SERVER process. A `process.exit()` inside it would take the
    // harness down with it, so the exit is converted into a catchable failure instead.
    ;(process as any).exit = (code?: number): never => {
      throw new Error(
        `test code called process.exit(${code ?? 0}); refusing to terminate the host process`
      )
    }
    // The module signals failure through captured TAP text, so its exit code is noise
    // here -- and leaving it set would misreport the HOST's own result.
    process.exitCode = undefined

    delete require.cache[require.resolve(resolvedPath)]
    require(resolvedPath)

    capturedOutput = capturedOutput || `ok 1 - Executed ${path.basename(resolvedPath)} in-process successfully.`
  } catch (err: any) {
    capturedOutput += `not ok 1 - In-Process Test Failure in ${path.basename(resolvedPath)}\n  ${err?.stack || err?.message || String(err)}\n`
  } finally {
    console.log = originalLog
    console.error = originalError
    ;(process as any).exit = originalExit
    process.exitCode = originalExitCode
  }

  return capturedOutput
}

export interface VerificationPolicy {
  mode: 'ask' | 'allow' | 'deny'
  allowlist: string[]
  allowInProcessFallback: boolean
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  mode: 'ask',
  allowlist: [],
  allowInProcessFallback: false,
}

/** The program a shell command would run, normalised for allowlist comparison. */
export function commandProgram(command: string): string {
  const text = String(command || '').trim()
  if (!text) return ''
  // A quoted first token may contain spaces ("C:\Program Files\nodejs\node.exe"), so it
  // must be taken whole; splitting on whitespace first would read it as "C:\Program".
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text)
  const first = quoted ? quoted[1] ?? quoted[2] ?? '' : text.split(/\s+/)[0] || ''
  const bare = first.replace(/^["']|["']$/g, '')
  return path.basename(bare).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/**
 * Decide whether a model-supplied verification command may run. Pure, so the policy is
 * testable without a server or an approval seam. `runVerification` is model-selected and
 * executes with the DSH process's full authority, so silence is never consent: anything
 * not explicitly permitted resolves to `ask`, and `ask` with no approver available is a
 * refusal at the call site.
 */
export function evaluateVerificationPolicy(
  command: string,
  policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY
): { kind: 'allow' | 'ask' | 'deny'; program: string; reason: string } {
  const program = commandProgram(command)
  if (!program) {
    return { kind: 'deny', program, reason: 'the verification command was empty' }
  }
  if (policy.mode === 'deny') {
    return {
      kind: 'deny',
      program,
      reason: `verificationApproval is 'deny', so no verification command is executed`,
    }
  }
  const allowlisted = policy.allowlist.some((entry) => commandProgram(String(entry)) === program)
  if (policy.mode === 'allow' || allowlisted) {
    return {
      kind: 'allow',
      program,
      reason: allowlisted
        ? `program '${program}' is on verificationAllowlist`
        : `verificationApproval is 'allow'`,
    }
  }
  return {
    kind: 'ask',
    program,
    reason:
      `the verification command '${command}' would run with the full authority of the DSH process ` +
      `and is not confined to the workspace`,
  }
}

/**
 * Run a verification command and capture its output.
 *
 * Output is captured through FILE DESCRIPTORS rather than pipes, deliberately. DSH's confined
 * sandbox modes refuse a piped spawn outright (`spawn EPERM`), which made the ordinary
 * subprocess path unusable in the default configuration and left the in-process fallback as the
 * only path that worked -- the wrong trade in every direction, since that fallback executes
 * model-influenced code inside the server. A descriptor avoids the pipe, so verification runs
 * as an ordinary child process for everyone, and the fallback is not needed at all.
 */
function captureCommandOutput(
  cmd: string,
  workspaceDir: string,
  timeoutMs: number
): { output: string; exitCode: number; spawnError: any } {
  const dir = resolveDataDir()
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outPath = path.join(dir, `verify-${unique}.stdout`)
  const errPath = path.join(dir, `verify-${unique}.stderr`)

  let outFd: number | undefined
  let errFd: number | undefined
  let result: any = null
  try {
    fs.mkdirSync(dir, { recursive: true })
    outFd = fs.openSync(outPath, 'w')
    errFd = fs.openSync(errPath, 'w')
    result = child_process.spawnSync(cmd, {
      shell: true,
      cwd: workspaceDir,
      timeout: timeoutMs,
      stdio: ['ignore', outFd, errFd] as any,
    })
  } catch (err) {
    result = { error: err, status: null }
  } finally {
    for (const fd of [outFd, errFd]) {
      if (typeof fd === 'number') {
        try {
          fs.closeSync(fd)
        } catch {
          // already closed
        }
      }
    }
  }

  const readFile = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  const output = (readFile(outPath) + '\n' + readFile(errPath)).trim()
  for (const file of [outPath, errPath]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // Best effort: a leftover temp file is not worth failing a verification over.
    }
  }

  const spawnError = result?.error ?? null
  const exitCode = typeof result?.status === 'number' ? result.status : spawnError ? 1 : 0

  return {
    output: output || (spawnError ? String(spawnError.message || spawnError) : ''),
    exitCode,
    spawnError,
  }
}

export function runSandboxVerification(
  verificationCommand: string,
  workspaceDir: string = process.cwd(),
  options: { redact?: boolean; rawLogPath?: string; allowInProcessFallback?: boolean } = {}
): TestResults {
  if (!verificationCommand || !verificationCommand.trim()) {
    return { passed: 0, failed: 0, output: 'No verification command specified.' }
  }

  const cmd = verificationCommand.trim()
  let output = ''
  let spawnError: any = null
  let exitCode = 0

  const captured = captureCommandOutput(cmd, workspaceDir, 30000)
  output = captured.output
  spawnError = captured.spawnError
  exitCode = captured.exitCode

  if (
    spawnError &&
    (spawnError.code === 'EPERM' ||
      String(spawnError).includes('EPERM') ||
      String(spawnError).includes('spawn EPERM'))
  ) {
    // Even a descriptor spawn was refused, so this host blocks verification entirely. The
    // in-process fallback still exists, but it re-runs model-influenced code inside the
    // SERVER process, so it is opt-in only: answering a denial by removing the sandbox
    // inverts the control. Fail closed.
    if (options.allowInProcessFallback === true) {
      output = runInProcessFallback(cmd, workspaceDir)
      return parseTestOutput(output, undefined, {
        redact: options.redact,
        rawOutputPath: persistRaw(output, options.rawLogPath),
      })
    }
    const refusal =
      `not ok 1 - the sandbox refused to spawn the verification command (EPERM) and the ` +
      `in-process fallback is disabled by default. Refusing to report success.\n${output}`
    return parseTestOutput(refusal, exitCode, {
      redact: options.redact,
      rawOutputPath: persistRaw(refusal, options.rawLogPath),
    })
  }

  return parseTestOutput(output, exitCode, { redact: options.redact, rawOutputPath: persistRaw(output, options.rawLogPath) })
}

/**
 * Keep the full verification output on the local machine. The redacted structure is what
 * travels; this is what a worker or an operator reads when they need the real thing.
 */
function persistRaw(output: string, rawLogPath?: string): string | undefined {
  if (!rawLogPath) return undefined
  try {
    fs.mkdirSync(path.dirname(rawLogPath), { recursive: true })
    fs.writeFileSync(rawLogPath, output, 'utf8')
    return rawLogPath
  } catch {
    return undefined
  }
}

export interface DelegateWorkerParams {
  instruction?: string
  taskPrompt?: string
  prompt?: string
  taskName?: string
  targetFiles?: string[] | string
  fileContext?: string
  systemPrompt?: string
  runVerification?: string
  endpoint?: string
  model?: string
  turnId?: number
  timeoutMs?: number
  workspaceDir?: string
  workspaceSource?: string
  /** Set false to return raw verification output. Raw output can carry source. */
  redactVerification?: boolean
  /** Policy for the model-supplied `runVerification` command. */
  verificationPolicy?: VerificationPolicy
  /**
   * Approval callback used when the policy resolves to `ask`. Absent means no approver is
   * reachable, which refuses the command rather than running it unattended.
   */
  verificationApproval?: (command: string) => Promise<boolean>
  /** Extra roots the worker may write into beyond `workspaceDir`. */
  emitAllowlist?: string[]
}

/** Where the local worker is assumed to live when nothing else is configured. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:1234/v1'

/**
 * Accept either a base URL or a full chat-completions URL and return the full one, so
 * `localEndpoint: 'http://127.0.0.1:11434/v1'` (Ollama, vLLM, llama.cpp, …) works exactly as
 * written without the operator having to know this plugin appends the path.
 */
export function resolveChatCompletionsUrl(base: string): string {
  const trimmed = String(base || '').trim().replace(/\/+$/, '')
  if (!trimmed) return `${DEFAULT_LOCAL_ENDPOINT}/chat/completions`
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

export async function delegateWorker(
  params: DelegateWorkerParams = {},
  tracker?: SavingsTracker
): Promise<any> {
  const endpoint = resolveChatCompletionsUrl(
    params.endpoint || PROFILES.WORKER.endpoint || DEFAULT_LOCAL_ENDPOINT
  )
  const model = params.model || PROFILES.WORKER.model
  const fileInstruction =
    'When generating code for target files, wrap each file in a code block with the target file path in the header or first line, e.g. ```typescript file="src/math-helper.ts"\n...code...\n``` or // FILE: tests/math-helper.test.ts'
  const systemPrompt =
    params.systemPrompt || `You are a fast, accurate local coding worker executing a discrete task. ${fileInstruction}`

  const taskText = params.instruction || params.taskPrompt || params.prompt || ''

  let fileContextText = ''
  if (Array.isArray(params.targetFiles)) {
    fileContextText = `Target Files:\n${params.targetFiles.join('\n')}`
  } else if (typeof params.targetFiles === 'string') {
    fileContextText = `Target Files:\n${params.targetFiles}`
  } else if (typeof params.fileContext === 'string') {
    fileContextText = params.fileContext
  }

  if (params.runVerification) {
    fileContextText += `\nVerification Command:\n${params.runVerification}`
  }

  const combinedPrompt = fileContextText
    ? `Task: ${params.taskName || 'Subtask'}\n${taskText}\n\n${fileContextText}`
    : `Task: ${params.taskName || 'Subtask'}\n${taskText}`

  const turnId = params.turnId ?? Math.floor(Math.random() * 1000000)
  const timeoutMs = params.timeoutMs ?? 300000

  const requestStartedAt = Date.now()

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: combinedPrompt },
        ],
        temperature: PROFILES.WORKER.temperature ?? 0.2,
        max_tokens: PROFILES.WORKER.max_tokens ?? 2048,
        stop: PROFILES.WORKER.stop ?? ['<|im_end|>', '<|endoftext|>'],
        enable_thinking: PROFILES.WORKER.enable_thinking ?? false,
        reasoning_effort: PROFILES.WORKER.reasoning_effort ?? 'none',
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId))

    if (!response.ok) {
      const errText = await response.text()
      return {
        success: false,
        status: 'ERROR',
        message: `LM Studio returned HTTP ${response.status}: ${errText}`,
        filesWritten: [],
        testResults: { passed: 0, failed: 0, output: 'Request failed.' },
        tokens: { prompt: 0, completion: 0 },
      }
    }

    const elapsedMs = Date.now() - requestStartedAt
    const data: any = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    const promptTokens = data.usage?.prompt_tokens ?? estimateTokenCount(combinedPrompt)
    const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(content)
    const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens)

    if (tracker) {
      tracker.recordUsage({
        turn: turnId,
        route: 'WORKER_LOCAL',
        model,
        reason: `SUBAGENT_DELEGATION (${params.taskName || 'subtask'})`,
        promptTokens,
        completionTokens,
        totalTokens,
        elapsedMs,
      })
    }

    const workspaceBase = params.workspaceDir || process.cwd()
    if (!fs.existsSync(workspaceBase)) {
      try {
        fs.mkdirSync(workspaceBase, { recursive: true })
      } catch (err: any) {
        return {
          success: false,
          status: 'ERROR',
          message: `Resolved workspace directory '${workspaceBase}' does not exist and could not be created: ${err?.message || String(err)}`,
          resolvedWorkspace: workspaceBase,
          filesWritten: [],
          testResults: { passed: 0, failed: 0, output: 'No files written.' },
          tokens: { prompt: promptTokens, completion: completionTokens },
        }
      }
    }
    const emission = extractAndEmitFiles(
      content,
      params.targetFiles,
      workspaceBase,
      params.emitAllowlist ?? []
    )
    const filesWritten = emission.filesWritten
    // Remember what we wrote on the architect's behalf, so reading it back can be gated.
    rememberDelegated(filesWritten.map((f) => f.path))

    let testResults: TestResults | undefined = undefined
    let verificationGate: string | undefined = undefined
    if (params.runVerification) {
      const policy = params.verificationPolicy ?? DEFAULT_VERIFICATION_POLICY
      const decision = evaluateVerificationPolicy(params.runVerification, policy)
      let permitted = decision.kind === 'allow'
      if (decision.kind === 'ask') {
        // No approver means no consent. A missing approval seam must never degrade to a
        // silent yes for a command that runs with the host process's authority.
        permitted = params.verificationApproval
          ? await params.verificationApproval(params.runVerification)
          : false
      }
      if (permitted) {
        testResults = runSandboxVerification(params.runVerification, workspaceBase, {
          redact: params.redactVerification ?? process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION !== '1',
          rawLogPath: path.join(resolveDataDir(), 'last-verification.log'),
          allowInProcessFallback: policy.allowInProcessFallback,
        })
      } else {
        verificationGate =
          decision.kind === 'deny'
            ? decision.reason
            : `approval was not granted (${decision.reason})`
      }
    }

    // A result is a verdict on a contract, and the contract is the verification command. Code
    // produced without one has an unchecked contract: reporting SUCCESS there would be the same
    // false green as counting unrecognised test output as a pass, which this plugin has already
    // been caught doing twice.
    const wroteFiles = filesWritten.length > 0 && emission.errors.length === 0
    const unverified = !verificationGate && !params.runVerification && wroteFiles

    const isSuccess =
      !verificationGate &&
      !unverified &&
      (!testResults || testResults.failed === 0) &&
      emission.errors.length === 0

    let summaryText = ''
    if (filesWritten.length > 0) {
      summaryText =
        `Task '${params.taskName || 'Subtask'}' completed. Wrote ${filesWritten.length} file(s):\n` +
        filesWritten.map((f) => `  - ${f.path} (${f.lines} lines, ${f.bytes} bytes)`).join('\n')
    } else {
      summaryText = `Task '${params.taskName || 'Subtask'}' completed. Worker returned ${content.split('\n').length} line(s) of output.`
    }

    summaryText += `\nWorkspace: ${workspaceBase}${params.workspaceSource ? ` (resolved via ${params.workspaceSource})` : ''}`
    if (params.workspaceSource && /FALLBACK/.test(params.workspaceSource) && filesWritten.length > 0) {
      summaryText += `\nWARNING: the Session workspace could not be resolved, so files were written relative to ${workspaceBase}. Pass absolute paths in targetFiles, or set DSH_WORKSPACE_ROOT, to be certain of the destination.`
    }
    if (emission.errors.length > 0) {
      summaryText += `\nFILE WRITE ERRORS:\n${emission.errors.map((e: string) => `  - ${e}`).join('\n')}`
    }

    if (verificationGate) {
      summaryText += `\nVerification was NOT run: ${verificationGate}`
    }
    if (unverified) {
      summaryText +=
        `\nUNVERIFIED: no verification command was supplied, so the contract was never checked. ` +
        `Files were written; nothing was proven.`
    }
    if (testResults) {
      summaryText += `\nVerification Results: Passed ${testResults.passed}, Failed ${testResults.failed}.`
      if (testResults.errorSummary) {
        summaryText += `\nFailures: ${testResults.errorSummary}`
      }
    }

    return {
      success: isSuccess,
      filesWritten: filesWritten.map((f) => f.path),
      filesWrittenRelative: filesWritten.map((f) => f.relativeName || f.path),
      resolvedWorkspace: workspaceBase,
      workspaceSource: params.workspaceSource,
      testResults:
        testResults ||
        {
          passed: 0,
          failed: 0,
          output: verificationGate
            ? `Verification not run: ${verificationGate}`
            : unverified
            ? 'No verification command was supplied; the contract is unchecked.'
            : 'No verification requested.',
        },
      ...(verificationGate ? { verificationSkipped: verificationGate } : {}),
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
      },
      summary: summaryText,
      status: verificationGate
        ? 'VERIFICATION_NOT_APPROVED'
        : unverified
        ? 'UNVERIFIED'
        : isSuccess
        ? 'SUCCESS'
        : 'VERIFICATION_FAILED',
      taskName: params.taskName || 'Subtask',
      tokensUsed: totalTokens,
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    return {
      success: false,
      status: 'ERROR',
      message: `LM Studio at 127.0.0.1:1234 was unreachable or failed: ${errMsg}`,
      filesWritten: [],
      testResults: { passed: 0, failed: 0, output: errMsg },
      tokens: { prompt: 0, completion: 0 },
    }
  }
}

export function extractPromptText(session: LLMSession | any): string {
  if (!session) return ''

  const messages =
    session.messages ||
    session.options?.messages ||
    session.requestOptions?.messages ||
    session.session?.messages

  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'user') {
        if (typeof msg.content === 'string') {
          const text = msg.content.trim()
          if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
            continue
          }
          if (text.length > 0) return text
        }
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p: any) => p.type === 'text')
          if (textPart?.text?.trim()) {
            const text = textPart.text.trim()
            if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
              return text
            }
          }
        }
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content
      if (typeof content === 'string') {
        const text = content.trim()
        if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
          continue
        }
        if (text.length > 0) return text
      }
    }
  }

  try {
    const inbox = session.inbox || session.session?.inbox
    if (inbox && Array.isArray(inbox['next-turn']) && inbox['next-turn'].length > 0) {
      const item = inbox['next-turn'][inbox['next-turn'].length - 1]
      if (typeof item?.prompt === 'string') {
        const text = item.prompt.trim()
        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
          if (text.length > 0) return text
        }
      }
      if (typeof item?.content === 'string') {
        const text = item.content.trim()
        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
          if (text.length > 0) return text
        }
      }
    }
  } catch (e) {}

  if (typeof session.input === 'string') {
    const text = session.input.trim()
    if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
      if (text.length > 0) return text
    }
  }

  if (typeof session.prompt === 'string' && session.prompt.trim().length > 0) {
    const clean = session.prompt
      .replace(/^\[model changed:.*?\]\s*/i, '')
      .replace(/^Current runtime context\..*?\n\n/is, '')
      .trim()
    if (clean.length > 0 && !clean.startsWith('[model changed:') && !clean.startsWith('Current runtime context.')) {
      return clean
    }
  }

  return ''
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

interface EffectiveConfig {
  localProvider: string
  cloudProvider: string
  localModel: string
  cloudModel: string
  contextThreshold: number
  timeoutMs: number
  enforceDLP: boolean
}

export class LocalRouter {
  private config: EffectiveConfig

  constructor(config: PluginConfig = {}) {
    const contextThreshold =
      config.contextThreshold ??
      config.contextTokenThreshold ??
      parseInt(process.env.CONTEXT_TOKEN_THRESHOLD || '30000', 10)

    this.config = {
      localProvider: config.localProvider || PROFILES.WORKER.provider,
      cloudProvider: config.cloudProvider || PROFILES.ARCHITECT.provider,
      localModel: config.localModel || PROFILES.WORKER.model,
      cloudModel: config.cloudModel || PROFILES.ARCHITECT.model,
      contextThreshold,
      timeoutMs: config.timeoutMs || 2000,
      enforceDLP: config.enforceDLP ?? true,
    }
  }

  public getConfig(): EffectiveConfig {
    return this.config
  }

  public async predictRoute(promptText: string): Promise<{
    provider: string
    model: string
    route: RouteType
    gate: string
    rationale: string
    scores: any
    latencyMs: number
    dlpViolations?: string[]
  }> {
    const dlpResult = scanDLP(promptText)
    if (dlpResult.hasSensitiveData) {
      return {
        provider: this.config.localProvider,
        model: this.config.localModel,
        route: 'WORKER_LOCAL',
        gate: 'Gate 1 (Local Classifier - DLP Firewall)',
        rationale: `Sensitive credentials detected by DLP firewall (${dlpResult.violations.join(', ')}). Routing payload locally to protect privacy.`,
        scores: { is_private: 0.99, complexity: 1, target: 'LOCAL_5090' },
        latencyMs: 0,
        dlpViolations: dlpResult.violations,
      }
    }

    const tokens = estimateTokenCount(promptText)

    if (tokens > this.config.contextThreshold) {
      return {
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        route: 'ARCHITECT_CLOUD',
        gate: 'Gate 0 (Guard - Token Threshold)',
        rationale: `Prompt token count (${tokens}) exceeds local context threshold (${this.config.contextThreshold}). Routing directly to Cloud.`,
        scores: { is_private: 0, complexity: 5, target: 'CLOUD_DEEPSEEK' },
        latencyMs: 0,
      }
    }

    // Routing is decided in-process. There is no decision daemon, no HTTP hop and
    // no timeout to pay on every routing call, and nothing to fail over to: the
    // classifier always returns a decision.
    const decision = classifyLocally(promptText)
    const isCloud = decision.route === 'cloud'

    return {
      provider: isCloud ? this.config.cloudProvider : this.config.localProvider,
      model: isCloud ? this.config.cloudModel : this.config.localModel,
      route: isCloud ? 'ARCHITECT_CLOUD' : 'WORKER_LOCAL',
      gate: decision.gate,
      rationale: decision.rationale,
      scores: decision.scores,
      latencyMs: decision.latencyMs,
    }
  }

  public async handleBeforeRequest(session: LLMSession): Promise<LLMSession> {
    if (!session) return session

    const fullText = extractPromptText(session)
    if (!fullText || fullText.trim().length === 0) {
      return {
        ...session,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
      }
    }

    const decision = await this.predictRoute(fullText)
    const routerMeta: RouterMetadata = {
      provider: decision.provider,
      model: decision.model,
      route: decision.route,
      gate: decision.gate,
      rationale: decision.rationale,
      scores: decision.scores,
      latencyMs: decision.latencyMs,
      dlpViolations: decision.dlpViolations,
      tier: decision.route === 'ARCHITECT_CLOUD' ? 'Cloud Tier (DeepSeek Cloud Architect)' : 'Local Tier (RTX 5090 Worker)',
      estimatedTokens: estimateTokenCount(fullText),
    }

    trace('ROUTER_DECISION', {
      prompt: fullText.slice(0, 100).replace(/\n/g, ' '),
      tokens: estimateTokenCount(fullText),
      gate: decision.gate,
      selectedProvider: decision.provider,
      selectedModel: decision.model,
      rationale: decision.rationale,
    })

    const isLocal = decision.provider === this.config.localProvider

    if (Object.isExtensible(session)) {
      try {
        session.provider = decision.provider
        session.model = decision.model
        session.apiKey = isLocal ? 'KEY' : undefined
        if (isLocal) {
          delete session.reasoningEffort
        }
        if (!session.options) session.options = {}
        if (Object.isExtensible(session.options)) {
          session.options.provider = decision.provider
          session.options.model = decision.model
          if (isLocal) {
            session.options.apiKey = 'KEY'
            delete session.options.reasoningEffort
          }
        }
        if (!session.metadata) session.metadata = {}
        if (Object.isExtensible(session.metadata)) {
          session.metadata.router = routerMeta
        }
      } catch (err) {}
    }

    const updatedOptions: Record<string, any> = {
      ...(session.options || {}),
      provider: decision.provider,
      model: decision.model,
    }

    if (isLocal) {
      updatedOptions.apiKey = 'KEY'
      delete updatedOptions.reasoningEffort
    }

    const updated: LLMSession = {
      ...session,
      provider: decision.provider,
      model: decision.model,
      options: updatedOptions,
      metadata: {
        ...(session.metadata || {}),
        router: routerMeta,
      },
    }

    if (isLocal) {
      updated.apiKey = 'KEY'
      delete updated.reasoningEffort
    }

    return updated
  }

  public async handleError(session: LLMSession, error: any): Promise<LLMSession> {
    if (!session) return session
    const currentProvider = session.provider || session.options?.provider || this.config.localProvider

    if (currentProvider === this.config.localProvider || session.metadata?.router?.route === 'WORKER_LOCAL' || session.metadata?.router?.route === 'local') {
      const errorMessage = error?.message || String(error)
      const prevMetadata = session.metadata?.router

      const routerMeta: RouterMetadata = {
        ...prevMetadata,
        failover: true,
        previousProvider: currentProvider,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        route: 'cloud-failover',
        gate: 'Gate 2 (Guard - Automatic Cloud Failover)',
        rationale: `Local LM Studio provider failure caught (${errorMessage}). Transparently re-dispatching turn to DeepSeek Cloud.`,
        tier: 'Cloud Tier (DeepSeek Cloud Fallback)',
        estimatedTokens: prevMetadata?.estimatedTokens || 0,
      }

      trace('ROUTER_FAILOVER', {
        errorMessage,
        cloudProvider: this.config.cloudProvider,
        cloudModel: this.config.cloudModel,
      })

      if (Object.isExtensible(session)) {
        try {
          session.provider = this.config.cloudProvider
          session.model = this.config.cloudModel
          if (session.options && Object.isExtensible(session.options)) {
            session.options.provider = this.config.cloudProvider
            session.options.model = this.config.cloudModel
          }
          if (session.metadata && Object.isExtensible(session.metadata)) {
            session.metadata.router = routerMeta
          }
        } catch (err) {}
      }

      const updated: LLMSession = {
        ...session,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        options: {
          ...(session.options || {}),
          provider: this.config.cloudProvider,
          model: this.config.cloudModel,
        },
        metadata: {
          ...(session.metadata || {}),
          router: routerMeta,
        },
      }

      if (typeof session.redispatch === 'function') {
        await session.redispatch()
      } else if (typeof session.retry === 'function') {
        await session.retry()
      }

      return updated
    }

    return session
  }
}

const pendingTurnPrompts = new Map<number, string>()

/**
 * Every user-message text this plugin has seen, per session.
 *
 * The DLP gate can only scan what the host hands it: `agent/pre-step` receives the
 * messages claimed for the current turn, and `agent/request` receives no message content
 * at all because the outbound conversation is assembled from the session surface after
 * that waterfall. Scanning only the newest message therefore let a credential introduced
 * in an earlier turn be re-sent on every later request without tripping the gate.
 * Accumulating makes the gate sticky instead.
 */
const sessionPromptCorpus = new Map<string, string>()
const SESSION_CORPUS_MAX_CHARS = 200_000
const GLOBAL_CORPUS_KEY = '__global__'

function corpusKeyFor(payload: any): string {
  const id = payload?.agent?.id ?? payload?.agent?.session?.id ?? payload?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : GLOBAL_CORPUS_KEY
}

function accumulateCorpus(key: string, text: string): void {
  if (!text) return
  const target = key || GLOBAL_CORPUS_KEY
  const existing = sessionPromptCorpus.get(target) ?? ''
  if (existing.includes(text)) return
  const combined = existing ? `${existing}\n${text}` : text
  sessionPromptCorpus.set(
    target,
    combined.length > SESSION_CORPUS_MAX_CHARS
      ? combined.slice(combined.length - SESSION_CORPUS_MAX_CHARS)
      : combined
  )
}

function extractTextFromClaimedMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (typeof m.text === 'string' && m.text.trim()) return m.text.trim()
    if (typeof m.prompt === 'string' && m.prompt.trim()) return m.prompt.trim()
    if (typeof m.content === 'string' && m.content.trim()) return m.content.trim()
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
          if (!block.text.startsWith('Current runtime context.')) {
            return block.text.trim()
          }
        }
      }
    }
  }
  return ''
}

let isPluginApplied = false

/**
 * Print the measured reference throughput for the local worker models, so the
 * server console carries a baseline next to the live per-call LEDGER_AUDIT rate.
 */
function logWorkerBenchmarks() {
  console.log(`[WORKER_BENCH] Reference throughput (${WORKER_BENCHMARK_SOURCE})`)
  console.log(
    '[WORKER_BENCH] Local work is unmetered, so the metered plan is spent on thinking rather than on reading code.'
  )
  console.log(
    '[WORKER_BENCH] LEDGER_AUDIT reports CloudEquiv: what the local tokens would have cost at the metered tier.'
  )
  console.log(
    '[WORKER_BENCH] That is the plan exposure you avoided, not money saved -- the GPU is a fixed cost.'
  )
  console.log(
    '[WORKER_BENCH] LEDGER_AUDIT carries running totals: Metered is what the plan paid, Local is what the GPU did.'
  )
  console.log('[WORKER_BENCH]   model                     decode        ttft       note')
  for (const bench of WORKER_BENCHMARKS) {
    const active = bench.model === PROFILES.WORKER.model ? '  <- active worker' : ''
    console.log(
      `[WORKER_BENCH]   ${bench.model.padEnd(24)} ${`${bench.decodeTps.toFixed(1)} tok/s`.padEnd(13)} ${bench.ttft.padEnd(10)} ${bench.note}${active}`
    )
  }
  console.log(
    `[WORKER_BENCH] Active worker model: ${PROFILES.WORKER.model} (max_tokens: ${PROFILES.WORKER.max_tokens ?? 'unset'}, thinking: ${PROFILES.WORKER.enable_thinking === false ? 'off' : 'on'})`
  )
}

/** Extensions treated as source code: writes must come from the local worker. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.fs', '.vb',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.php', '.scala', '.lua', '.dart',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.sql',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
])

/** Tools that write a file directly. */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit',
  'create_file', 'write_file', 'fs_write', 'notebook_edit',
])

/** Shell tools can write files as a side effect; detection is best-effort. */
const SHELL_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'terminal', 'run_command', 'pwsh_persistent', 'bash_persistent',
])

/** Tools that read a file's contents into the caller's context. */
const READ_TOOLS = new Set(['read', 'read_file', 'fs_read', 'view', 'view_file', 'cat'])

/**
 * Files this plugin wrote on the architect's behalf, so that reads of them can be gated.
 *
 * The separation this plugin enforces is meant to be mutual: the architect specifies, the worker
 * authors, and the code stays on disk. Nothing stopped the architect from reading back what it had
 * just delegated — which makes the delegation pointless, because the code lands in the very
 * context it was kept out of. These paths are the ones the guard can be precise about, since the
 * plugin is the thing that wrote them.
 *
 * In-memory and process-scoped on purpose: this is a workflow guard ("you delegated this; do you
 * need to read it back?"), not durable state. Bounded so a long session cannot grow it forever.
 */
const delegatedPaths = new Set<string>()
const DELEGATED_PATH_LIMIT = 500

function rememberDelegated(paths: string[]): void {
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const canonical = canonicalisePath(p)
    if (delegatedPaths.has(canonical)) continue
    delegatedPaths.add(canonical)
    if (delegatedPaths.size > DELEGATED_PATH_LIMIT) {
      const oldest = delegatedPaths.values().next().value
      if (typeof oldest === 'string') delegatedPaths.delete(oldest)
    }
  }
}

function isDelegatedPath(target: string, paths?: Iterable<string>): boolean {
  const canonical = canonicalisePath(target)
  for (const p of paths ?? []) {
    if (canonicalisePath(String(p)) === canonical) return true
  }
  return false
}

/**
 * A delegated file named by a read-only inspector in a shell command is the same read by another
 * route. Only delegated paths are tested, so this cannot reintroduce the false positive that made
 * `Select-String some.js` look like a script invocation.
 */
function findDelegatedRead(command: string, paths?: Iterable<string>): string | undefined {
  if (typeof command !== 'string' || !command || !paths) return undefined
  for (const p of paths) {
    const canonical = canonicalisePath(String(p))
    for (const form of [canonical, canonical.replace(/\\/g, '/')]) {
      if (command.includes(form) && isReadArgument(command, form)) return form
    }
  }
  return undefined
}

const DEFAULT_GUARD_ASK_PATHS = ['tests/', 'tools/']

export interface GuardVerdict {
  kind: 'deny' | 'ask'
  target: string
  reason: string
}

function extractWriteTarget(args: any): string | undefined {
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
  } = {}
): GuardVerdict | null {
  const name = String(exec?.name || '')
  const args = exec?.arguments
  const askPaths =
    config.askPaths && config.askPaths.length > 0 ? config.askPaths : DEFAULT_GUARD_ASK_PATHS

  const reason = (target: string) =>
    `Writing source file '${target}' from the cloud context is blocked by the local-only code guard. ` +
    `Delegate this work to the local RTX 5090 worker: call delegate_worker with targetFiles and ` +
    `workspaceDir set to the session workspace.`

  // Reading a file the architect delegated pulls that code straight back into its context, which
  // is precisely the noise delegation exists to keep out. Ask rather than deny: reviewing a line
  // of it is sometimes exactly what the operator wants.
  if (READ_TOOLS.has(name)) {
    const target = extractWriteTarget(args)
    if (target && isDelegatedPath(target, config.delegatedPaths)) {
      return {
        kind: 'ask',
        target,
        reason:
          `'${target}' was written by a delegated worker, and reading it pulls that code into the ` +
          `cloud architect's context — the noise the delegation exists to keep out. Ask the worker ` +
          `to inspect it and report instead, or approve this read if you need the contents here.`,
      }
    }
    return null
  }

  if (WRITE_TOOLS.has(name)) {
    const target = extractWriteTarget(args)
    if (!target) return null
    if (!CODE_EXTENSIONS.has(path.extname(target).toLowerCase())) return null
    const normalized = target.replace(/\\/g, '/').toLowerCase()
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

    // Reading a delegated file through the shell is the same read by another route.
    const delegatedRead = findDelegatedRead(command, config.delegatedPaths)
    if (delegatedRead) {
      return {
        kind: 'ask',
        target: delegatedRead,
        reason:
          `Shell command reads '${delegatedRead}', which a delegated worker wrote. Reading it pulls ` +
          `that code into the cloud architect's context; ask the worker to inspect it instead, or ` +
          `approve this read if you need the contents here.`,
      }
    }

    return null
  }

  return null
}

/** Closed approval vocabulary; only 'allowed-once' is a grant. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

const APPROVAL_OUTCOMES = new Set<string>(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * Route an `ask` guard decision through the real approval seam.
 *
 * Returning `{ kind: 'ask' }` from a tools/pre-execute listener prompts nobody: the
 * pipeline understands only `deny`, so every other kind is an allow. The seam that
 * actually asks is `dsh-user-approval` (ctx.approval), and it fails closed — a
 * missing service, a missing agent, an idle turn or a throwing answerer all resolve
 * to 'unavailable', which this treats as a refusal.
 */
export async function requestApprovalForWrite(
  ctx: any,
  exec: any,
  verdict: GuardVerdict
): Promise<ApprovalOutcome> {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
    if (!service || typeof service.request !== 'function') return 'unavailable'
    if (!exec?.agent) return 'unavailable'

    const outcome = await service.request({
      agent: exec.agent,
      toolName: String(exec?.name || 'unknown'),
      ...(exec?.callId ? { callId: exec.callId } : {}),
      reason: verdict.reason,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    })

    // Validate against the vocabulary rather than trusting the answerer: the service
    // normalises rogue values, but a bridge that assumes it would treat any unknown
    // string as a decision. Anything unrecognised fails closed.
    return typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)
      ? (outcome as ApprovalOutcome)
      : 'unavailable'
  } catch (err) {
    // No open turn, suspended session, or a broken answerer: fail closed.
    console.warn('[LOCAL_GUARD] approval request failed; failing closed:', (err as any)?.message || err)
    return 'unavailable'
  }
}

export function resolveVerificationPolicy(options: PluginConfig = {}): VerificationPolicy {
  return {
    mode: options.verificationApproval ?? 'ask',
    allowlist: Array.isArray(options.verificationAllowlist) ? options.verificationAllowlist : [],
    allowInProcessFallback: options.allowInProcessFallback === true,
  }
}

/**
 * Ask the operator to approve one model-selected verification command. Unlike the write
 * guard this is not a `tools/pre-execute` decision, because the command runs after the
 * worker responds; it is asked before dispatch so the operator sees it up front.
 * Fails closed on every error path.
 */
export async function requestApprovalForVerification(
  ctx: any,
  exec: any,
  command: string
): Promise<boolean> {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
    if (!service || typeof service.request !== 'function') return false
    if (!exec?.agent) return false

    const outcome = await service.request({
      agent: exec.agent,
      toolName: 'delegate_worker',
      ...(exec?.callId ? { callId: exec.callId } : {}),
      reason:
        `delegate_worker wants to run this verification command with the full authority of the DSH ` +
        `process:\n  ${command}\n` +
        `It is model-selected and is not confined to the workspace. Approve it only if you recognise it.`,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    })

    return outcome === 'allowed-once'
  } catch (err) {
    console.warn(
      '[LOCAL_GUARD] verification approval request failed; failing closed:',
      (err as any)?.message || err
    )
    return false
  }
}

export function apply(ctx: Context, options: PluginConfig = {}) {
  const REGISTERED_KEY = Symbol.for('dsh-plugin-local-router.registered')
  const isTest = process.env.NODE_ENV === 'test'

  if (!isTest) {
    if (isPluginApplied || (ctx as any)[REGISTERED_KEY] || (globalThis as any)[REGISTERED_KEY]) {
      console.warn('[LOCAL_ROUTER] Plugin already registered. Skipping duplicate mounting.')
      return
    }
    isPluginApplied = true
    ;(ctx as any)[REGISTERED_KEY] = true
    ;(globalThis as any)[REGISTERED_KEY] = true
  }

  console.log('[LOCAL_ROUTER_DEBUG] ctx.tools available:', Boolean((ctx as any).tools))

  const router = new LocalRouter(options)
  const config = router.getConfig()

  const tracker = new SavingsTracker(resolveDataDir())

  trace('PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR', { config })

  // Register `delegate_worker` strictly adhering to `@deepseek-ai/dsh-tools` and DeepSeek JSON Schema contract
  if ((ctx as any).tools && typeof (ctx as any).tools.register === 'function') {
    try {
      const dshToolDef = {
        name: 'delegate_worker',
        description:
          'Dispatches a discrete implementation, testing, or code-generation task to the local RTX 5090 execution worker (LM Studio) with an isolated context window.',
        parameters: {
          type: 'object',
          properties: {
            taskName: {
              type: 'string',
              description: 'A short descriptive identifier for the subtask',
            },
            instruction: {
              type: 'string',
              description: 'The complete technical prompt and specifications for the local worker',
            },
            targetFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional file paths to target or modify',
            },
            runVerification: {
              type: 'string',
              description:
                'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
            },
            workspaceDir: {
              type: 'string',
              description:
                'Absolute path of the directory the worker may write into. Defaults to the session workspace; destinations outside it are refused.',
            },
          },
          required: ['taskName', 'instruction'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
          render: (_args: any, value: any) => [
            {
              type: 'text',
              text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
            },
          ],
        },
        async execute(args: any, exec: any) {
          const resolved = resolveWorkspaceDir(ctx)
          const explicitDir = args?.workspaceDir
          // `endpoint` is not a declared tool argument and is deliberately dropped:
          // delegateWorker would otherwise POST the task to whatever URL a caller named.
          const { endpoint: _ignoredEndpoint, ...callerArgs } = args || {}
          const policy = resolveVerificationPolicy(options)
          return await delegateWorker(
            {
              ...callerArgs,
              // Operator settings, not caller arguments. The local endpoint and model are
              // trusted configuration; a caller-supplied `endpoint` was dropped just above.
              ...(options?.localEndpoint ? { endpoint: options.localEndpoint } : {}),
              ...(options?.localModel ? { model: options.localModel } : {}),
              workspaceDir: explicitDir || resolved.dir,
              workspaceSource: explicitDir ? 'caller-supplied workspaceDir' : resolved.source,
              verificationPolicy: policy,
              emitAllowlist: options?.emitAllowlist,
              verificationApproval: (command: string) =>
                requestApprovalForVerification(ctx, exec, command),
            },
            tracker
          )
        },
      }

      try {
        ;(ctx as any).tools.register(dshToolDef)
      } catch (e) {
        ;(ctx as any).tools.register('delegate_worker', dshToolDef, dshToolDef.execute)
      }
      console.log("[LOCAL_ROUTER_INIT] Tool 'delegate_worker' registered successfully on ctx.tools.")
      logWorkerBenchmarks()
    } catch (e: any) {
      console.warn("[LOCAL_ROUTER_INIT] Failed to register tool via ctx.tools.register:", e?.message || String(e))
    }
  } else {
    console.log("[LOCAL_ROUTER_INIT] Service ctx.tools not available. Registering fallback event listener for 'delegate_worker'.")
  }

  // Fallback listener for tool execution calls in DSH microkernel
  ctx.on('tool/call' as any, async (payload: any) => {
    if (payload?.name === 'delegate_worker' || payload?.tool === 'delegate_worker') {
      const args = payload.args || payload.arguments || {}
      const resolved = resolveWorkspaceDir(ctx)
      const explicitDir = args?.workspaceDir
      // `endpoint: options.localProvider` used to sit here, which set the POST URL to the
      // provider *id* ('lm-studio') rather than a URL. delegateWorker's default is correct.
      const { endpoint: _ignoredEndpoint, ...callerArgs } = args || {}
      return await delegateWorker(
        {
          ...callerArgs,
          // Same operator settings as the registered tool path above.
          ...(options?.localEndpoint ? { endpoint: options.localEndpoint } : {}),
          ...(options?.localModel ? { model: options.localModel } : {}),
          workspaceDir: explicitDir || resolved.dir,
          workspaceSource: explicitDir ? 'caller-supplied workspaceDir' : resolved.source,
          // This path has no agent or call id, so no approval can be requested: with the
          // default 'ask' policy the verification command is refused rather than run.
          verificationPolicy: resolveVerificationPolicy(options),
          emitAllowlist: options?.emitAllowlist,
        },
        tracker
      )
    }
  })

  // Local-only code guard: refuse cloud-authored source writes so that all code
  // work routes through delegate_worker to the local RTX 5090.
  if (options?.localCodeGuard !== false) {
    ctx.on('tools/pre-execute' as any, async (exec: any, next: any) => {
      const decision = typeof next === 'function' ? await next() : { kind: 'allow' }
      if (!decision || decision.kind !== 'allow') return decision
      try {
        const verdict = evaluateCodeWriteGuard(exec, {
          askPaths: options?.guardAskPaths,
          delegatedPaths,
        })
        if (verdict) {
          // guardMode 'deny' wins outright: an operator who said "never prompt" must
          // not be prompted just because this path would otherwise be ask-eligible.
          const wantsAsk =
            options?.guardMode !== 'deny' && (options?.guardMode === 'ask' || verdict.kind === 'ask')

          if (!wantsAsk) {
            console.log(`[LOCAL_GUARD] DENY ${exec?.name} -> ${verdict.target}`)
            return { kind: 'deny', reason: verdict.reason }
          }

          // Ask for real, through the approval seam. Only 'allowed-once' grants.
          const outcome = await requestApprovalForWrite(ctx, exec, verdict)
          if (outcome === 'allowed-once') {
            console.log(`[LOCAL_GUARD] ALLOWED-ONCE ${exec?.name} -> ${verdict.target}`)
            return decision
          }
          console.log(`[LOCAL_GUARD] DENY (${outcome}) ${exec?.name} -> ${verdict.target}`)
          return {
            kind: 'deny',
            reason: `${verdict.reason} (approval outcome: ${outcome})`,
          }
        }
      } catch (err) {
        // Fail closed: a guard that cannot evaluate must not wave the call through.
        console.warn('[LOCAL_GUARD] evaluation failed; failing closed:', err)
        return {
          kind: 'deny',
          reason: `Local-code guard could not evaluate this call: ${(err as any)?.message || err}`,
        }
      }
      return decision
    })
    console.log('[LOCAL_ROUTER_INIT] Local-code guard registered on tools/pre-execute.')
  }

  // 1. Lightweight agent/pre-step prompt capture & DLP scanner ONLY
  ctx.on(
    'agent/pre-step' as any,
    async (payload: any, next: any) => {
      const turn = payload?.turn
      const prompt = extractTextFromClaimedMessages(payload?.messages)
      if (turn !== undefined && prompt) {
        pendingTurnPrompts.set(turn, prompt)
        accumulateCorpus(corpusKeyFor(payload), prompt)
        trace('HOOK_CAPTURE: PROMPT_CAPTURED (agent/pre-step)', {
          turn,
          prompt: prompt.slice(0, 100),
        })
      }
      return typeof next === 'function' ? await next() : payload
    },
    { prepend: true } as any
  )

  // 2. Primary Thread (Architect) Request Hook: Pin primary thread to DeepSeek Cloud with native uncapped context and tool schema injection
  ctx.on(
    'agent/request' as any,
    async (payload: any, next: any) => {
      const resolvedConfig = typeof next === 'function' ? await next() : {}
      const turn = payload?.turn
      const agent = payload?.agent

      let prompt = (turn !== undefined ? pendingTurnPrompts.get(turn) : '') || ''
      if (turn !== undefined) {
        pendingTurnPrompts.delete(turn)
      }

      if (!prompt) {
        try {
          if (agent?.inbox?.nextTurn && Array.isArray(agent.inbox.nextTurn) && agent.inbox.nextTurn.length > 0) {
            const item = agent.inbox.nextTurn[agent.inbox.nextTurn.length - 1]
            prompt = item?.prompt || item?.text || item?.content || ''
          }
        } catch {}
      }

      if (!prompt && agent?.session) prompt = extractPromptText(agent.session)
      if (!prompt && payload?.session) prompt = extractPromptText(payload.session)
      if (!prompt && payload) prompt = extractPromptText(payload)

      // Pre-flight DLP Firewall. This is a GATE, not a log line: a payload carrying
      // credentials is either refused outright or pinned to the local worker, but it
      // is never transmitted to the cloud. (Earlier versions logged "Blocking WAN
      // transmission" and then sent the payload anyway.)
      // Scan everything this session has said, not just the newest message: the host
      // re-sends the conversation on every request, so a clean latest message is not
      // evidence that the outbound payload is clean.
      const corpus = sessionPromptCorpus.get(corpusKeyFor(payload)) || ''
      const dlpSubject = corpus.length > prompt.length ? corpus : prompt
      const dlpResult = scanDLP(dlpSubject, {
        entropyCheck: options?.entropyCheck,
        entropyMinBitsPerChar: options?.entropyMinBitsPerChar,
        entropyMinLength: options?.entropyMinLength,
      })
      const dlpTripped = config.enforceDLP && dlpResult.hasSensitiveData
      // Entropy-only hits are medium confidence: always rerouted local (so they are
      // never transmitted) but never hard-blocked, because digests and base64 payloads
      // are legitimate content that merely looks random.
      const entropyOnly = dlpTripped && !dlpResult.highConfidence
      const rerouteLocal = dlpTripped && (entropyOnly || options?.dlpAction === 'local')
      const shouldBlock = dlpTripped && !rerouteLocal

      if (dlpTripped) {
        const violations = dlpResult.violations.join(', ')
        trace('DLP_FIREWALL_TRIPPED', {
          violations,
          action: rerouteLocal ? 'reroute-local' : 'block',
          confidence: dlpResult.highConfidence ? 'high' : 'entropy-only',
          prompt: prompt.slice(0, 100),
        })

        if (shouldBlock) {
          console.error(
            `[DLP_FIREWALL_BLOCK] Refusing to transmit: credentials detected (${violations}). Nothing was sent to the cloud.`
          )
          throw new Error(
            `DLP firewall blocked this request: ${violations} detected in the outbound payload. ` +
              `Nothing was transmitted. Remove the credential from the conversation and retry. This gate scans every ` +
              `user message it has seen in this session, so a credential that appeared in an earlier turn keeps ` +
              `blocking until the session is restarted. Set dlpAction: 'local' to route such requests to the local ` +
              `worker instead of refusing them. Assistant output and tool results are assembled by the host after ` +
              `this hook runs and are not scanned.`
          )
        }

        console.warn(
          `[DLP_FIREWALL_REROUTE] Sensitive data (${violations}) pinned to the LOCAL worker; it will not reach the WAN.`
        )
      }

      // Architect Primary Thread configuration. A tripped DLP under dlpAction
      // 'local' pins this request to the local provider instead of the cloud.
      const mutatedConfig: Record<string, any> = {
        ...resolvedConfig,
        provider: rerouteLocal ? config.localProvider : config.cloudProvider,
        model: rerouteLocal ? config.localModel : config.cloudModel,
      }

      // Uncap context window for DeepSeek Cloud Architect
      delete mutatedConfig.contextWindow
      delete mutatedConfig.maxTokens
      delete mutatedConfig.max_tokens
      delete mutatedConfig.max_completion_tokens
      delete mutatedConfig.apiKey

      // Inject `delegate_worker` function tool definition for DeepSeek Cloud
      if (Array.isArray(mutatedConfig.tools)) {
        const hasWorker = mutatedConfig.tools.some((t: any) => (t?.function?.name || t?.name) === 'delegate_worker')
        if (!hasWorker) {
          mutatedConfig.tools.push(DELEGATE_WORKER_OPENAI_SCHEMA)
        }
      } else {
        mutatedConfig.tools = [DELEGATE_WORKER_OPENAI_SCHEMA]
      }

      // Inject system instructions if provided in ARCHITECT profile
      if (PROFILES.ARCHITECT.systemInstruction) {
        if (typeof mutatedConfig.system === 'string') {
          if (!mutatedConfig.system.includes('delegate_worker')) {
            mutatedConfig.system += '\n\n' + PROFILES.ARCHITECT.systemInstruction
          }
        } else if (Array.isArray(mutatedConfig.messages)) {
          const sysMsg = mutatedConfig.messages.find((m: any) => m.role === 'system')
          if (sysMsg) {
            if (typeof sysMsg.content === 'string' && !sysMsg.content.includes('delegate_worker')) {
              sysMsg.content += '\n\n' + PROFILES.ARCHITECT.systemInstruction
            }
          } else {
            mutatedConfig.messages.unshift({
              role: 'system',
              content: PROFILES.ARCHITECT.systemInstruction,
            })
          }
        }
      }

      trace(rerouteLocal ? 'HOOK_EXIT: DLP_PINNED_LOCAL (agent/request)' : 'HOOK_EXIT: ARCHITECT_CLOUD_PINNED (agent/request)', {
        provider: mutatedConfig.provider,
        model: mutatedConfig.model,
        uncappedContextWindow: true,
        toolsCount: mutatedConfig.tools?.length || 0,
      })

      return mutatedConfig
    },
    { prepend: true } as any
  )

  // 3. Post-step usage listener for actual token usage & ledger recording
  function handlePostStepUsage(payload: any) {
    const session = payload?.session || payload
    const usage =
      payload?.usage ||
      session?.usage ||
      session?.response?.usage ||
      session?.result?.usage ||
      payload?.payload?.usage

    if (!usage) return

    const promptTokens = usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0
    const completionTokens = usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens ?? 0
    const totalTokens = usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens)
    const cacheHitTokens = usage.prompt_cache_hit_tokens ?? usage.cacheHitTokens ?? usage.prompt_cache_hit ?? 0

    if (totalTokens > 0) {
      tracker.recordUsage({
        turn: payload?.turn ?? session?.turn ?? payload?.step ?? 1,
        route: 'ARCHITECT_CLOUD',
        model: 'deepseek-chat',
        reason: 'STEP_COMPLETION',
        promptTokens,
        completionTokens,
        totalTokens,
        cacheHitTokens,
      })
    }
  }

  ctx.on('agent/post-step' as any, handlePostStepUsage)
  ctx.on('agent/step-finish' as any, handlePostStepUsage)

  // 4. Stream chunk listener for output token accumulation if usage is emitted on stream frames
  ctx.on('agent/assistant-stream' as any, (payload: any) => {
    const frame = payload?.frame
    const raw = frame || payload

    if (typeof raw?.usage?.completion_tokens === 'number') {
      const usage = raw.usage
      const promptTokens = usage.prompt_tokens ?? 0
      const completionTokens = usage.completion_tokens ?? 0
      const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens)
      const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0

      if (totalTokens > 0) {
        tracker.recordUsage({
          turn: payload?.turn ?? frame?.turn ?? 1,
          route: 'ARCHITECT_CLOUD',
          model: 'deepseek-chat',
          reason: 'STREAM_USAGE_FRAME',
          promptTokens,
          completionTokens,
          totalTokens,
          cacheHitTokens,
        })
      }
    }
  })
}

const pluginExport = {
  name,
  inject,
  using,
  apply,
  LocalRouter,
  SavingsTracker,
  scanDLP,
  delegateWorker,
  extractAndEmitFiles,
  runSandboxVerification,
  parseTestOutput,
  DELEGATE_WORKER_SCHEMA,
  DELEGATE_WORKER_OPENAI_SCHEMA,
  PROFILES,
  default: apply,
}

export default pluginExport
