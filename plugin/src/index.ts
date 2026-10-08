import { Context } from 'cordis'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as child_process from 'child_process'
import * as crypto from 'crypto'
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker'
import { PROFILES, ProfileConfig, WORKER_BENCHMARKS, WORKER_BENCHMARK_SOURCE } from './profiles'
import { classifyLocally, SECRET_PATTERN_RULES, findHighEntropyTokens } from './local-classifier'
import { resolveDataDir, trace } from './logging'
import { canonicalisePath, isPathWithin, CODE_EXTENSIONS } from './paths'
import {
  FileEmissionResult,
  evaluateEmissionPath,
  extractAndEmitFiles,
  configurePatchEngine,
} from './emission'
import {
  DEFAULT_VERIFICATION_POLICY,
  TestResults,
  VerificationPolicy,
  evaluateVerificationPolicy,
  parseTestOutput,
  resolveVerificationTimeoutMs,
  runSandboxVerification,
} from './verification'
import {
  ContextInjection,
  ContextRequest,
  ContextResolution,
  DEFAULT_CONTEXT_MAX_BYTES,
  resolveContextFiles,
} from './context'
import {
  DELETE_PRIMITIVES,
  DelegateReadPolicy,
  GuardVerdict,
  READ_TOOLS,
  evaluateCodeWriteGuard,
  evaluateDelegatedReadPolicy,
  extractWriteTarget,
  hasCommandDeleteSignal,
  hasCommandWriteSignal,
} from './guard'
import {
  AGENT_ROLE_LIMIT,
  DEFAULT_SOURCE_EGRESS_MIN_LINES,
  SourceEgressDetection,
  SourceEgressPolicy,
  applyAgentRole,
  applyArchitectConfig,
  describeSourceRead,
  detectSourceEgress,
  evaluateSourceEgress,
  rememberAgentRole,
  resetAgentRoles,
  resolveAgentRole,
  resolveLeadProviders,
  roleForAgent,
} from './roles'
import {
  DELEGATE_WORKER_OPENAI_SCHEMA,
  DELEGATE_WORKER_SCHEMA,
  MIN_SEARCH_CHARS,
  applySearchReplaceBlocks,
  delegateWorker,
  estimateTokenCount,
  extractPromptText,
  parseSearchReplaceBlocks,
  resolveDelegateStatus,
} from './delegation'
import {
  DELEGATED_PATH_LIMIT,
  DelegatedRecord,
  contractFileHashes,
  contractViolations,
  delegatedPaths,
  loadDelegatedRegistry,
  mergeDelegatedRecords,
  parseDelegatedRegistry,
  pruneDelegatedRecords,
  rememberDelegated,
  resolveContractFiles,
  resolveDelegatedRegistryPath,
  saveDelegatedRegistry,
  sha256File,
} from './contracts'
import {
  ContextQuality,
  EMPTY_CONTEXT_QUALITY,
  describeContextQuality,
  foldContextQuality,
} from './context-quality'
import { TRACED_EVENTS } from './session-events'

export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage }
export { resolveDataDir, trace } from './logging'
export { isPathWithin } from './paths'
export { evaluateEmissionPath, evaluateUnitScope, extractAndEmitFiles } from './emission'
export {
  DELETE_PRIMITIVES,
  evaluateCodeWriteGuard,
  evaluateDelegatedReadPolicy,
  hasCommandDeleteSignal,
  hasCommandWriteSignal,
} from './guard'
export {
  AGENT_ROLE_LIMIT,
  DEFAULT_SOURCE_EGRESS_MIN_LINES,
  applyAgentRole,
  applyArchitectConfig,
  describeSourceRead,
  detectSourceEgress,
  evaluateSourceEgress,
  rememberAgentRole,
  resetAgentRoles,
  resolveAgentRole,
  resolveLeadProviders,
  roleForAgent,
} from './roles'
export {
  ContextInjection,
  ContextRequest,
  ContextResolution,
  DEFAULT_CONTEXT_MAX_BYTES,
  resolveContextFiles,
} from './context'
export {
  contractFileHashes,
  contractViolations,
  loadDelegatedRegistry,
  mergeDelegatedRecords,
  parseDelegatedRegistry,
  pruneDelegatedRecords,
  rememberDelegated,
  resolveContractFiles,
  resolveDelegatedRegistryPath,
  saveDelegatedRegistry,
  sha256File,
} from './contracts'
export {
  DEFAULT_VERIFICATION_POLICY,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  commandProgram,
  describeFailures,
  evaluateVerificationPolicy,
  parseTestOutput,
  redactVerificationOutput,
  resolveVerificationTimeoutMs,
  runInProcessFallback,
  runSandboxVerification,
} from './verification'
export {
  ContextQuality,
  EMPTY_CONTEXT_QUALITY,
  describeContextQuality,
  foldContextQuality,
} from './context-quality'
export {
  DELEGATE_WORKER_OPENAI_SCHEMA,
  DELEGATE_WORKER_SCHEMA,
  DEFAULT_LOCAL_ENDPOINT,
  MIN_SEARCH_CHARS,
  applySearchReplaceBlocks,
  delegateWorker,
  estimateTokenCount,
  extractPromptText,
  parseSearchReplaceBlocks,
  resolveChatCompletionsUrl,
  resolveDelegateStatus,
} from './delegation'
export {
  FailureLocation,
  RETRY_CONTEXT_WINDOW_LINES,
  parseFailureLocations,
  retryContextRequests,
} from './retry-context'

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
   * How long `delegate_worker`'s verification command may run before it is killed, in milliseconds.
   * Defaults to 30,000 — the value this used to be hardcoded to — so configuring nothing changes
   * nothing. Raise it for a contract whose command legitimately needs longer: a full suite, a build,
   * an install.
   *
   * A value that is not a positive finite number falls back to the default rather than removing the
   * bound. An unbounded command that is model-selected and runs with the DSH process's authority is a
   * hang, not a permission.
   */
  verificationTimeoutMs?: number
  /**
   * The project's own check — a build, a full suite — run after each unit's contract, with the power to
   * void an otherwise passing unit. This is what catches two units disagreeing: a unit can pass the tests
   * written for it and still break every caller of what it changed.
   *
   * Operator configuration, not model input, which is why it is absent from the tool schema and not
   * approval-gated — the operator wrote this string here, exactly as they would in CI. It runs as an
   * ordinary subprocess under `verificationTimeoutMs`, and a denied spawn is a failure rather than a
   * pass. It is skipped when the unit wrote no files, since a delegation that changed nothing cannot
   * have broken coherence.
   *
   * A failure is reported as `INCOHERENT` rather than `VERIFICATION_FAILED`: the unit is fine and the
   * project is not, which is a different instruction to the architect.
   */
  coherenceVerification?: string
  /**
   * Whether a unit's declared `targetFiles` is a boundary. `'enforce'` (the default) refuses a write to
   * any path the unit did not declare; `'off'` restores the behaviour before the boundary existed.
   *
   * This is what makes the coherence check above attributable. A unit that sprawls can break the tree in
   * a way no record can assign to a unit, so `coherenceVerification` can say *that* something broke but
   * not *what*. Declared targets, enforced, are the other half of that pair.
   */
  unitScope?: 'enforce' | 'off'
  /**
   * Whether a unit that failed has its failure locations read back and offered to the next attempt in
   * the same workspace as context. `'auto'` (the default) does this once per failure; `'off'` disables it.
   *
   * This is the loop closing on itself. The ordinary cause of a unit that failed "for no visible reason"
   * is that the worker was never shown the code it had to change, and the failure already names the file.
   * The plugin reads that file into the WORKER's prompt while the architect is handed metadata only, so a
   * retry can widen the worker's view without widening the architect's window. It is best-effort by
   * construction: it is dropped rather than allowed to turn a runnable delegation into a refusal.
   */
  retryContext?: 'auto' | 'off'
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
  /**
   * Provider ids whose requests are NOT the architect — the lead tier. A request the host has already
   * resolved to one of these is left exactly as configured: not repinned to the cloud, not given the
   * architect's instruction, and not offered `delegate_worker`. The DLP gate still runs.
   *
   * Empty by default, which means every request is the architect — the behaviour before this option
   * existed. An allowlist rather than an inference on purpose: guessing the role from "the provider is
   * not the architect's" would stop pinning the architect as soon as a profile named its provider
   * something else, and the failure would be silent and in the direction of the cloud.
   */
  leadProviders?: string[]
  /**
   * Convenience switch for the lead tier: derives `leadProviders` from the LEAD profile, so the
   * provider id is declared in exactly one place. An explicit `leadProviders` list wins over it.
   *
   * Do not point this at the provider your architect session uses — the hook would stop pinning it,
   * which is the one failure direction that costs you source leaving the machine.
   */
  leadTier?: boolean
  /**
   * What happens when an agent reads a file a delegated worker wrote. `ask` (default) prompts,
   * `deny` refuses, and `allow` permits it.
   *
   * `allow` exists for a lead tier that must read the code it writes contracts about, and it is an
   * honest weakening of rule 3 rather than a fix — the fix is the host exposing agent lineage. The
   * guard cannot yet tell the architect from a lead, so `allow` relaxes the rule for every agent.
   */
  delegateReadPolicy?: DelegateReadPolicy
  /**
   * Paths whose source the architect may author, because a contract test is the specification rather
   * than the implementation. Rule 2 forbids the architect writing source and rule 7 needs the architect
   * to own the tests, which conflict for exactly this case, so this is the declared exception.
   * Defaults to `['tests/']`; an empty list disables the carve-out.
   */
  contractPaths?: string[]
  /**
   * What a write to a contract path does: `ask` (default), `allow`, or `deny`. Deliberately separate
   * from `guardAskPaths`, which decides what may be written at all; this decides what the architect is
   * allowed to specify. Setting `allow` is the opt-in that makes contract authoring frictionless.
   */
  contractWriteMode?: 'allow' | 'ask' | 'deny'
  /**
   * Rule 8: what happens when a cloud-bound request carries source code in its own payload.
   *
   * `deny` (default) refuses the request, `ask` puts it to the operator, `allow` transmits it. A
   * request bound for the local worker is not egress and is never affected.
   *
   * This is the one rule here that can refuse a request the operator typed themselves, so it is worth
   * knowing the detector: fenced blocks with a source language tag, at least
   * `sourceEgressMinLines` lines long. Prose about code does not trip it, and neither does an
   * untagged block — a real false negative, documented rather than hidden.
   */
  sourceEgress?: SourceEgressPolicy
  /** Lines a fenced source block needs before it counts (default 3). Lower is more false positives. */
  sourceEgressMinLines?: number
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
export const name = 'dsh-plugin-coding-delegate'

// resolveDataDir and trace moved to ./logging.ts and are imported above. The re-export beside the other
// module re-exports keeps `resolveDataDir` on the public surface, where callers already depend on it.

// The delegate_worker schemas moved to ./delegation.ts and are re-exported below.

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

// canonicalisePath and isPathWithin moved to ./paths.ts and are imported above. isPathWithin is
// re-exported beside the other module re-exports because it is on the public surface.

// FileEmissionResult and evaluateEmissionPath moved to ./emission.ts and are imported above.
// evaluateEmissionPath is re-exported there because it is on the public surface.

// extractAndEmitFiles moved to ./emission.ts and is imported above, along with the fenced-block scan


// RedactedFailure, TestResults, looksLikeCode, cleanMessage, sanitizeRetainedField,
// redactVerificationOutput and describeFailures moved to ./verification.ts and are re-exported below.













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
      tier: decision.route === 'ARCHITECT_CLOUD' ? 'Cloud Tier (Cloud Architect)' : 'Local Tier (Local Worker)',
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

// CODE_EXTENSIONS moved to ./paths.ts and is imported above. It is deliberately not re-exported: it is
// an internal rule about what counts as source, not part of the plugin's public surface.



/**
 * Commands that READ a file named on the command line rather than executing it.
 *
 * Without this list, `Select-String -Path some.js` was treated as an invocation of
 * `some.js`: the guard read the whole file and, since any sizeable program contains a write
 * primitive, asked for approval to *read* it. Reading a file is not running it.

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
  // A blank or non-string coherence command is absent, not an empty command: an empty string would run
  // as a no-op subprocess and report success, which is a project check that checks nothing.
  const coherence =
    typeof options.coherenceVerification === 'string' && options.coherenceVerification.trim()
      ? options.coherenceVerification.trim()
      : undefined
  return {
    mode: options.verificationApproval ?? 'ask',
    allowlist: Array.isArray(options.verificationAllowlist) ? options.verificationAllowlist : [],
    allowInProcessFallback: options.allowInProcessFallback === true,
    timeoutMs: resolveVerificationTimeoutMs(options.verificationTimeoutMs),
    ...(coherence ? { coherenceVerification: coherence } : {}),
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

// Role resolution, the architect config and the lead tier moved to ./roles.ts and are imported
// above. They are re-exported beside the other module re-exports because callers depend on them.

export function apply(ctx: Context, options: PluginConfig = {}) {
  // Restore what was delegated before this process started. Without this, a restart silently widened
  // what the architect may read back — the gap a live run found, and the reason this is not merely
  // in-memory state any more.
  for (const record of loadDelegatedRegistry()) {
    if (record.mode === 'created') delegatedPaths.add(canonicalisePath(record.path))
  }
  const REGISTERED_KEY = Symbol.for('dsh-plugin-coding-delegate.registered')
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
          'Dispatches a discrete implementation, testing, or code-generation task to the configured local execution worker -- any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp) -- with an isolated context window. The worker has no repository read: declare contextFiles for the code it must see, since it cannot discover anything itself.',
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
              description:
                'The files this unit may write. ENFORCED: an emission to any path not listed here is refused and reported, because a unit that writes outside what it declared is how two units come to disagree about the same code. Declare every file the unit creates or changes, including a directory if the unit chooses the filenames within it. Omit the field to leave the unit unrestricted.',
            },
            runVerification: {
              type: 'string',
              description:
                'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
            },
            contractFiles: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Paths to the tests that constitute this unit contract. They are hashed before the worker runs, the worker is forbidden to write them, and they are re-hashed afterwards: any change voids the verdict. The architect owns these files.',
            },
            contextFiles: {
              type: 'array',
              description:
                'Existing files the worker needs to see, as { path, startLine?, endLine? }. The plugin reads them into the worker prompt; you receive a record of what was injected and never the contents. Paths outside the workspace are refused, and context carrying a credential is refused rather than transmitted.',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                },
                required: ['path'],
              },
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
              // Operator setting, placed after the caller args for the same reason as `unitScope` below:
              // a caller must not be able to switch this off, and an operator who has switched it off must
              // not have it switched back on by a caller.
              retryContext: options?.retryContext ?? 'auto',
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
          retryContext: options?.retryContext ?? 'auto',
          // Operator setting, placed after the caller args deliberately: a caller that sent its own
          // `unitScope` must not be able to switch off the boundary that keeps it in its lane.
          unitScope: options?.unitScope ?? 'enforce',
        },
        tracker
      )
    }
  })

  // Local-only code guard: refuse cloud-authored source writes so that all code
  // work routes through delegate_worker to the local worker.
  if (options?.localCodeGuard !== false) {
    ctx.on('tools/pre-execute' as any, async (exec: any, next: any) => {
      const decision = typeof next === 'function' ? await next() : { kind: 'allow' }
      if (!decision || decision.kind !== 'allow') return decision
      try {
        const verdict = evaluateCodeWriteGuard(exec, {
          askPaths: options?.guardAskPaths,
          delegatedPaths,
          delegateReadPolicy: options?.delegateReadPolicy,
          contractPaths: options?.contractPaths,
          contractWriteMode: options?.contractWriteMode,
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

        // Observation, not enforcement: the architect is allowed to read source, and this records it.
        // The guard above answers "may this happen"; this answers "did it, and who by" — which is what
        // will later say whether that access is used at all, and so whether it can be taken away.
        const observed = describeSourceRead({
          tool: exec?.name,
          target: extractWriteTarget(exec?.arguments),
          role: roleForAgent(exec?.agent?.id),
        })
        if (observed.track) {
          trace('SOURCE_READ', {
            role: observed.role,
            agent: String(exec?.agent?.id ?? '').slice(0, 8) || 'unknown',
            tool: String(exec?.name ?? ''),
            target: observed.target,
            extension: observed.extension,
          })
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

  // Context-quality counters: the measurement that turns "your GPU does the typing" into an observation
  // rather than an argument.
  //
  // DSH publishes every session event on a `session/event` firehose, and its own session service
  // documents observation as "a plugin concern (subscribe to `session/event`)". So this needs no injected
  // service, which is what keeps the plugin's `inject` list -- and the oracle that asserts it -- unchanged.
  //
  // Counted per session, traced on the events that move the figures. The reclaimed-token number comes
  // from the host (`shadowedTokenCount` on `compaction/summary` and `compaction/prune`), so it is
  // reported rather than estimated.
  //
  // One limit worth knowing while reading the trace: events that entered through construction (replay,
  // fork, resume) are not published on this firehose, so a resumed session is counted from the resume
  // rather than from its true beginning. Recorded in `docs/findings.md`.
  const contextQuality = new Map<string, ContextQuality>()
  const qualityKeyFor = (session: any): string => {
    const id = session?.id ?? session?.header?.id
    return typeof id === 'string' && id.length > 0 ? id : '__global__'
  }
  ctx.on('session/event' as any, (session: any, event: any) => {
    const key = qualityKeyFor(session)
    const current = contextQuality.get(key) ?? EMPTY_CONTEXT_QUALITY
    const next = foldContextQuality(current, event)
    if (next === current) return
    contextQuality.set(key, next)

    const type = String(event?.type ?? '')
    // The traced subset lives in `session-events.ts` beside the folded vocabulary, where both lists are
    // checked against the host's own `SessionEventMap`. Two hand-written copies of these names used to sit
    // in this plugin, and only one of them was ever going to get updated.
    if (TRACED_EVENTS.has(type)) {
      trace('CONTEXT_QUALITY', {
        // DSH ids are `session-<uuid>`, so the first eight characters are the constant prefix and
        // identify nothing -- every session logged as "session-". Take the eight AFTER the prefix.
        session: key.startsWith('session-') ? key.slice(8, 16) : key.slice(0, 8),
        event: type,
        summary: describeContextQuality(next),
      })

      // Once per turn, the compounding figure: content the worker produced and the architect never carried,
      // multiplied by the model calls it would have ridden on. The currency is context, not money -- see
      // `docs/experiment.md` for why the ledger stopped quoting dollars. `turn/start` is used because it is
      // already folded and traced, so this costs one branch rather than a second event subscription.
      if (type === 'turn/start') {
        trace('CONTEXT_HYGIENE', {
          session: key.startsWith('session-') ? key.slice(8, 16) : key.slice(0, 8),
          line: tracker.contextHygiene(next.steps).line,
        })
      }
    }
  })

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

      // Which role is this request? The plugin used to treat every agent as the architect, which is
      // right for the architect and wrong for everything else: a lead configured to run locally would
      // be repinned to the cloud and told it was the architect. The DLP gate above runs either way, so
      // opting a provider out of the architect role does not opt it out of the firewall.
      const role = resolveAgentRole({
        hostProvider: resolvedConfig?.provider,
        leadProviders: resolveLeadProviders(options),
      })

      // Correlate the role with the agent, so a later tool call can be attributed. Best effort by
      // construction: the host does not expose lineage, so this is the plugin's own inference.
      rememberAgentRole(agent?.id, role.role)

      const mutatedConfig = applyAgentRole(resolvedConfig || {}, role, {
        cloudProvider: config.cloudProvider,
        cloudModel: config.cloudModel,
        localProvider: config.localProvider,
        localModel: config.localModel,
        rerouteLocal,
        architectInstruction: PROFILES.ARCHITECT.systemInstruction,
        workerTool: DELEGATE_WORKER_OPENAI_SCHEMA,
      })

      // Rule 8: source may not reach the cloud. The read guard covers pulling delegated code back, and
      // contextFiles injects into the worker; this covers the blunt route — source sitting in the
      // outbound payload because it was typed into a cloud-bound conversation.
      const destination: 'cloud' | 'local' =
        rerouteLocal ||
        String(mutatedConfig.provider || '').toLowerCase() ===
          String(config.localProvider || '').toLowerCase()
          ? 'local'
          : 'cloud'

      const egressDetection = detectSourceEgress(dlpSubject, {
        minLines: options?.sourceEgressMinLines,
      })
      const egress = evaluateSourceEgress(
        options?.sourceEgress ?? 'deny',
        egressDetection,
        destination
      )

      if (egress.kind !== 'allow') {
        let permitted = false
        if (egress.kind === 'ask') {
          try {
            const approvalService =
              typeof (ctx as any)?.get === 'function' ? (ctx as any).get('approval') : undefined
            if (approvalService && typeof approvalService.request === 'function' && agent) {
              const outcome = await approvalService.request({
                agent,
                toolName: 'agent/request',
                reason:
                  `This cloud-bound request carries source: ${egress.reason} Source is not supposed ` +
                  `to reach the cloud (rule 8). Approve only if you mean to transmit it.`,
                ...(payload?.signal ? { signal: payload.signal } : {}),
              })
              permitted = outcome === 'allowed-once'
            }
          } catch (err: any) {
            console.warn(
              '[SOURCE_EGRESS] approval request failed; failing closed:',
              err?.message || err
            )
            permitted = false
          }
        }

        if (!permitted) {
          trace('SOURCE_EGRESS_BLOCKED', {
            blocks: egressDetection.blocks,
            languages: egressDetection.languages,
            destination,
            action: options?.sourceEgress ?? 'deny',
          })
          throw new Error(
            `Source may not reach the cloud (rule 8): ${egress.reason} Nothing was transmitted. ` +
              `This gate reads every user message the session has sent, so a block from an earlier ` +
              `turn keeps it closed until the session is restarted.`
          )
        }
      }

      trace(
        role.role === 'lead'
          ? 'HOOK_EXIT: LEAD_LEFT_AS_CONFIGURED (agent/request)'
          : rerouteLocal
          ? 'HOOK_EXIT: DLP_PINNED_LOCAL (agent/request)'
          : 'HOOK_EXIT: ARCHITECT_CLOUD_PINNED (agent/request)',
        {
          role: role.role,
          roleReason: role.reason,
          provider: mutatedConfig.provider,
          model: mutatedConfig.model,
          uncappedContextWindow: role.role === 'architect',
          toolsCount: mutatedConfig.tools?.length || 0,
        }
      )

      return mutatedConfig
    },
    { prepend: true } as any
  )

  // Architect usage is deliberately NOT recorded in this ledger. Three subscriptions that tried to are
  // gone, because none of them could ever have fired -- checked against the installed host, not assumed:
  //
  //   `agent/post-step` and `agent/step-finish` do not exist. Neither name appears anywhere in the
  //   installed `@deepseek-ai/*` packages; this plugin invented them.
  //
  //   `agent/assistant-stream` does exist, but its frames are `start` / `chunk` / `end`
  //   (`AssistantStreamFrame` in `dsh-agent`) and none carries `usage`. That stream is "presentation data
  //   rather than the replay source"; the durable settlement is `assistant/message`, which does carry
  //   `usage?: TokenUsage`.
  //
  // So `cloudTurns`, `architectTurns`, `totalCloudTokens` and `totalSpendUSD` are permanently zero, and
  // the ledger's `scope` field now says so rather than leaving them to read as measured data.
  //
  // Reviving them was considered and rejected, not overlooked. It would mean a ledger write on every
  // architect model call -- 980 in one observed session -- to produce a dollar figure this plugin no
  // longer claims anything about. The architect side *is* measured, by the context-quality fold off the
  // same `session/event` subscription used above; it is measured as context, and it is not money.
  //
  // The general fix for this whole class -- a subscription to an event the host does not emit -- is to
  // type `ctx.on` against the host's `Events` interface so that such a name cannot compile. That is the
  // open half of the host contract: ROADMAP item 21 covers session event TYPES, not hook names.
}

// The patch engine is configured inside ./delegation.ts, where both halves now live.

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
  sha256File,
  resolveContextFiles,
  parseSearchReplaceBlocks,
  applySearchReplaceBlocks,
  MIN_SEARCH_CHARS,
  DEFAULT_CONTEXT_MAX_BYTES,
  resolveContractFiles,
  contractFileHashes,
  contractViolations,
  resolveDelegateStatus,
  resolveLeadProviders,
  evaluateDelegatedReadPolicy,
  rememberAgentRole,
  roleForAgent,
  resetAgentRoles,
  describeSourceRead,
  AGENT_ROLE_LIMIT,
  detectSourceEgress,
  evaluateSourceEgress,
  DEFAULT_SOURCE_EGRESS_MIN_LINES,
  resolveDelegatedRegistryPath,
  parseDelegatedRegistry,
  mergeDelegatedRecords,
  pruneDelegatedRecords,
  saveDelegatedRegistry,
  loadDelegatedRegistry,
  rememberDelegated,
  resolveAgentRole,
  applyArchitectConfig,
  applyAgentRole,
  DELEGATE_WORKER_SCHEMA,
  DELEGATE_WORKER_OPENAI_SCHEMA,
  PROFILES,
  default: apply,
}

export default pluginExport
