import * as path from 'path'
import { PROFILES } from './profiles'
import { READ_TOOLS } from './guard'
import { CODE_EXTENSIONS } from './paths'

export type SourceEgressPolicy = 'deny' | 'ask' | 'allow'

/**
 * Fenced-block languages that count as source. Scripts are included: a deployment script is source,
 * and it is exactly the sort of thing that should not be typed into a metered cloud conversation.
 */
const SOURCE_LANGUAGES = new Set([
  'ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'mjs', 'cjs',
  'py', 'python', 'rb', 'ruby', 'php', 'java', 'kt', 'kotlin', 'scala', 'swift', 'dart',
  'cs', 'csharp', 'fs', 'fsharp', 'vb', 'go', 'rs', 'rust',
  'c', 'h', 'cpp', 'c++', 'hpp', 'cc', 'mm',
  'ps1', 'powershell', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd',
  'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte', 'lua', 'pl', 'perl', 'r',
  'ex', 'exs', 'erl', 'hs', 'clj', 'asm', 'sol',
])

/** Blocks shorter than this are treated as quotations rather than as code being handed over. */
export const DEFAULT_SOURCE_EGRESS_MIN_LINES = 3

export interface SourceEgressDetection {
  found: boolean
  blocks: number
  languages: string[]
}

/**
 * Find fenced source blocks in an outbound payload.
 *
 * The fence is built with `\x60` escapes rather than written literally: a literal triple backtick in
 * this file makes the file unpatchable by a confined agent, because the emission scanner truncates a
 * fenced body at the first backtick run inside it. The pattern is identical at runtime.
 */
export function detectSourceEgress(
  text: string,
  options: { minLines?: number } = {}
): SourceEgressDetection {
  if (typeof text !== 'string' || !text) return { found: false, blocks: 0, languages: [] }

  const minLines = Math.max(1, Number(options.minLines ?? DEFAULT_SOURCE_EGRESS_MIN_LINES))
  const languages: string[] = []
  let blocks = 0

  const FENCE = '\x60\x60\x60'
  const fenced = new RegExp(FENCE + '([a-zA-Z0-9_+#-]+)[ \\t]*\\n([\\s\\S]*?)' + FENCE, 'g')
  let match: RegExpExecArray | null
  while ((match = fenced.exec(text)) !== null) {
    const language = match[1].toLowerCase()
    if (!SOURCE_LANGUAGES.has(language)) continue
    const body = match[2].replace(/\n$/, '')
    if (body.split('\n').length < minLines) continue
    blocks += 1
    languages.push(language)
  }

  return { found: blocks > 0, blocks, languages }
}

/**
 * Rule 8: source may not reach the cloud. A request bound for the local worker is not egress at all,
 * so the policy never applies to it — which is the entire reason the lead tier runs locally.
 */
export function evaluateSourceEgress(
  action: SourceEgressPolicy,
  detection: SourceEgressDetection,
  destination: 'cloud' | 'local'
): { kind: 'allow' | 'ask' | 'deny'; reason: string } {
  if (destination === 'local') {
    return {
      kind: 'allow',
      reason: 'the request is bound for the local worker, so nothing is leaving the machine',
    }
  }
  if (!detection.found) {
    return { kind: 'allow', reason: 'no fenced source block was found in the outbound payload' }
  }

  const summary =
    detection.blocks +
    ' fenced source block(s) in the outbound payload (' +
    detection.languages.join(', ') +
    ')'

  if (action === 'allow') {
    return { kind: 'allow', reason: 'sourceEgress is allow, so ' + summary + ' will be transmitted' }
  }
  if (action === 'ask') {
    return { kind: 'ask', reason: summary + ' needs an operator decision (sourceEgress is ask)' }
  }
  return {
    kind: 'deny',
    reason:
      'rule 8 refuses this request: ' +
      summary +
      ". Set sourceEgress: 'ask' to approve case by case, or 'allow' to send source to the cloud " +
      'deliberately.',
  }
}

/** Bounded, newest-wins. Built from observed requests, because the host does not say which agent is which. */
export const AGENT_ROLE_LIMIT = 200
const agentRoles = new Map<string, 'architect' | 'lead'>()

/**
 * Remember which role an agent last made a request as.
 *
 * This is a correlation, not lineage: the plugin sees an `agent` on `agent/request` and an `agent` on
 * `tools/pre-execute`, and it assumes the same id means the same agent. That assumption is recorded
 * rather than trusted — an unobserved id resolves to 'unknown' and the observation says so, so the
 * record degrades honestly instead of inventing an attribution.
 */
export function rememberAgentRole(agentId: string | undefined, role: 'architect' | 'lead'): void {
  const id = String(agentId ?? '').trim()
  if (!id) return
  if (agentRoles.has(id)) agentRoles.delete(id)
  agentRoles.set(id, role)
  while (agentRoles.size > AGENT_ROLE_LIMIT) {
    const oldest = agentRoles.keys().next().value
    if (typeof oldest === 'string') agentRoles.delete(oldest)
  }
}

/**
 * The role as the host's session lineage records it.
 *
 * `Session.header` carries `origin?: 'subagent'` and `delegationDepth?: number`, so the host says outright
 * whether this is a root agent or one spawned beneath another. A root agent is the architect; anything the
 * host has marked as spawned is not.
 *
 * A missing header returns 'unknown' rather than 'architect'. Absence of evidence is not evidence of
 * rootness, and a plugin that guesses here is guessing about who may read source.
 */
export function roleFromLineage(header: unknown): 'architect' | 'lead' | 'unknown' {
  if (!header || typeof header !== 'object') return 'unknown'
  const h = header as { origin?: unknown; delegationDepth?: unknown }
  if (h.origin === 'subagent') return 'lead'
  if (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) return 'lead'
  return 'architect'
}

/** The lineage role for a live agent, when the host hands one over. */
export function agentLineageRole(agent: unknown): 'architect' | 'lead' | 'unknown' {
  const session = (agent as { session?: { header?: unknown } } | undefined)?.session
  return roleFromLineage(session?.header)
}

/**
 * The role for an agent, preferring the host's lineage over the observed correlation.
 *
 * Lineage first, because it is what the host recorded. The correlation map below remains as the fallback
 * for a host that says nothing -- which, before `Session.header` existed, was the only signal this plugin
 * had, and the comment on `rememberAgentRole` said so honestly.
 */
export function roleForAgent(
  agentId: string | undefined,
  agent?: { session?: { header?: unknown } }
): 'architect' | 'lead' | 'unknown' {
  const byLineage = agentLineageRole(agent)
  if (byLineage !== 'unknown') return byLineage
  const id = String(agentId ?? '').trim()
  if (!id) return 'unknown'
  return agentRoles.get(id) ?? 'unknown'
}

/** The map is module state, so tests need a way to clear it. */
export function resetAgentRoles(): void {
  agentRoles.clear()
}

export interface SourceReadObservation {
  track: boolean
  role: 'architect' | 'lead' | 'unknown'
  target?: string
  extension?: string
  reason: string
}

/**
 * Should this tool call be recorded as a source read?
 *
 * Observation, not enforcement. The architect is allowed to read source today — the guard gates only
 * files a worker wrote — and that is not a claim this project wants to keep making on faith. Recording
 * every source read is what will say whether the architect's access is ever used, and therefore whether
 * it can be closed.
 *
 * The tool check matters as much as the path check: without it, the architect's own refused writes to
 * source would be counted as reads, and the evidence this exists to gather would be wrong.
 */
export function describeSourceRead(input: {
  tool?: string
  target?: string
  role?: 'architect' | 'lead' | 'unknown'
}): SourceReadObservation {
  const role = input?.role ?? 'unknown'
  const tool = String(input?.tool ?? '').trim().toLowerCase()

  if (!READ_TOOLS.has(tool)) {
    return { track: false, role, reason: `'${tool || 'unknown tool'}' is not a read tool` }
  }

  const target = String(input?.target ?? '').trim()
  if (!target) return { track: false, role, reason: 'no target to attribute' }

  const extension = path.extname(target).toLowerCase()
  if (!CODE_EXTENSIONS.has(extension)) {
    return { track: false, role, target, extension, reason: 'not a source file' }
  }

  return {
    track: true,
    role,
    target,
    extension,
    reason: `source read attributed to ${role}`,
  }
}

/**
 * Which providers are the lead tier? `leadTier` derives the list from the LEAD profile so the provider
 * id is declared in one place; an explicit `leadProviders` list always wins.
 *
 * Takes a structural type rather than `PluginConfig`: importing that would be a cycle, because
 * `index.ts` imports this module, and every field read here is optional anyway.
 */
export function resolveLeadProviders(options: {
  leadProviders?: string[]
  leadTier?: boolean
} = {}): string[] {
  if (Array.isArray(options.leadProviders) && options.leadProviders.length > 0) {
    return options.leadProviders
  }
  return options.leadTier ? [PROFILES.LEAD.provider] : []
}

export function resolveAgentRole(input: {
  hostProvider?: string
  leadProviders?: string[]
}): { role: 'architect' | 'lead'; reason: string } {
  const host = String(input.hostProvider ?? '')
    .trim()
    .toLowerCase()
  const declared = (input.leadProviders ?? [])
    .map((p) => String(p ?? '').trim().toLowerCase())
    .filter(Boolean)

  if (!host) {
    return {
      role: 'architect',
      reason: 'the host resolved no provider, so the architect default applies',
    }
  }
  if (declared.includes(host)) {
    return {
      role: 'lead',
      reason: `provider '${host}' is declared as a non-architect (lead) provider`,
    }
  }
  return { role: 'architect', reason: `provider '${host}' is not declared as a lead provider` }
}

/**
 * The architect's request treatment: pin the provider, uncap the window, supply the tool and the role
 * instruction. Extracted from the hook so the behaviour is testable without a host.
 *
 * Deliberately unchanged: the instruction is only injected into a `system` string or a `messages`
 * array. A request carrying neither is left without it, because inventing a field the host may not
 * read would be a silent no-op dressed up as a fix.
 */
export function applyArchitectConfig(
  requestConfig: Record<string, any>,
  options: {
    cloudProvider?: string
    cloudModel?: string
    localProvider?: string
    localModel?: string
    rerouteLocal?: boolean
    architectInstruction?: string
    workerTool?: any
  } = {}
): Record<string, any> {
  // A tripped DLP under dlpAction 'local' pins this request to the local provider instead of the cloud.
  //
  // The route is only rewritten when there is a route to rewrite it TO. Both options are operator config and
  // both are optional, so the unconditional assignment that stood here wrote `provider: undefined` over
  // whatever the host had selected -- and that is not a corner case, because the plugin's own entry in
  // `config.json` carries no options at all. A plugin registered without a profile patch would have
  // clobbered every request's provider. Leaving the host's route alone is what a session without this plugin
  // does anyway, which is the honest fallback.
  //
  // One case deliberately still writes `undefined`: `rerouteLocal` means the operator asked for this request
  // to go to the local worker, and with no local provider configured that cannot be satisfied locally.
  // Falling back to the host's route could send source to the cloud on a request whose whole point was to
  // keep it off the cloud, so the misconfiguration is left to fail loudly, and this says so.
  const route = options.rerouteLocal
    ? { provider: options.localProvider, model: options.localModel }
    : { provider: options.cloudProvider, model: options.cloudModel }
  const misrouted = typeof route.provider !== 'string' || route.provider.length === 0
  const mutatedConfig: Record<string, any> = { ...(requestConfig || {}) }
  if (misrouted && options.rerouteLocal) {
    console.warn(
      '[LOCAL_GUARD] rerouteLocal is set but no localProvider is configured, so this request cannot be ' +
        'routed locally. It is left unrouted rather than sent to whatever route the host selected.'
    )
    mutatedConfig.provider = undefined
    mutatedConfig.model = options.localModel
  } else if (!misrouted) {
    mutatedConfig.provider = route.provider
    mutatedConfig.model = route.model
  }

  // Uncap the context window for the cloud architect.
  delete mutatedConfig.contextWindow
  delete mutatedConfig.maxTokens
  delete mutatedConfig.max_tokens
  delete mutatedConfig.max_completion_tokens
  delete mutatedConfig.apiKey

  // Inject the `delegate_worker` tool definition for the architect thread.
  if (Array.isArray(mutatedConfig.tools)) {
    const hasWorker = mutatedConfig.tools.some(
      (t: any) => (t?.function?.name || t?.name) === 'delegate_worker'
    )
    if (!hasWorker && options.workerTool) mutatedConfig.tools.push(options.workerTool)
  } else if (options.workerTool) {
    mutatedConfig.tools = [options.workerTool]
  }

  if (options.architectInstruction) {
    if (typeof mutatedConfig.system === 'string') {
      if (!mutatedConfig.system.includes('delegate_worker')) {
        mutatedConfig.system += '\n\n' + options.architectInstruction
      }
    } else if (Array.isArray(mutatedConfig.messages)) {
      const sysMsg = mutatedConfig.messages.find((m: any) => m.role === 'system')
      if (sysMsg) {
        if (typeof sysMsg.content === 'string' && !sysMsg.content.includes('delegate_worker')) {
          sysMsg.content += '\n\n' + options.architectInstruction
        }
      } else {
        mutatedConfig.messages.unshift({
          role: 'system',
          content: options.architectInstruction,
        })
      }
    }
  }

  return mutatedConfig
}

/**
 * Apply the role. A lead request is returned unchanged: the plugin's job is to enforce boundaries, not
 * to reinvent a preset it did not write.
 */
export function applyAgentRole(
  requestConfig: Record<string, any>,
  role: { role: 'architect' | 'lead' },
  architectOptions: Parameters<typeof applyArchitectConfig>[1] = {}
): Record<string, any> {
  if (role.role === 'lead') return { ...(requestConfig || {}) }
  return applyArchitectConfig(requestConfig, architectOptions)
}
