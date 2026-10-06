PowerShell
@'
# Specification: DSH Dynamic Model Router Plugin (Laya Router)

## 1. Overview & Objective

This specification details the architecture, request lifecycle hooks, and implementation requirements for building a dynamic model routing plugin for the DeepSeek DSH platform.

The plugin intercepts conversation turns within DSH to dynamically steer inference:
* **Local Inference (`lm-studio` / `qwen/qwen3.8-27b`):** High-volume, syntax-heavy, low-planning tasks (declarative UI/HTML/CSS, data transfer schemas, unit tests, syntax refactoring, shell scripting).
* **Cloud Inference (`deepseek-official` / `deepseek-chat`):** High-complexity cognitive tasks (distributed systems, async concurrency/race conditions, algorithmic optimization, root-cause debugging).

---

## 2. DSH Agent Loop Lifecycle & Hook Architecture

DSH is built on the Cordis micro-kernel and `@deepseek-ai/dsh-agent-loop`. Understanding the exact execution order inside `ReactLoopAgent.turn()` and `ReactLoopAgent.step()` is critical to avoid frozen property mutations and early connection binding.

Incoming Turn
│
▼

inbox.claim() ──► Pops pending turn messages from agent.inbox
│
▼

agent/pre-step ──► [CAPTURE HOOK] Receives claimed messages in payload.messages
│                 Stashes prompt in pendingTurnPrompts.get(turn)
▼

prepareRequest() ─► Invokes agent/request waterfall with seedConfig
│                 [ROUTING HOOK] Replaces provider/model configuration
▼

prepareCall() ───► Binds HTTP network adapter to selected provider
│
▼

session.append() ─► Commits user/message to event-sourced session history
│
▼

buildRequest() ──► Deep-freezes request object (writable: false, configurable: false)
│
▼

llm/stream ──────► Executes stream on already-bound preparedCall (TOO LATE TO ROUTE)


### Critical Architectural Invariants

1. **`llm/stream` is an invalid routing point:**
   * DSH instantiates the network client (`preparedCall`) during `prepareRequest()`.
   * `buildRequest()` wraps the request with immutable properties (`{ writable: false, configurable: false }`). Attempting assignment or `Object.defineProperty` in `llm/stream` causes fatal `TypeError: Cannot redefine property: provider`.
2. **`agent/request` is the mandatory waterfall gate:**
   * Declared in `@deepseek-ai/dsh-tool-cordis` as:
     `'agent/request'(payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>`
   * Returning `{ ...resolvedConfig, provider: newProvider, model: newModel }` dynamically mutates the connection target prior to `prepareCall()`.
3. **The Timing Bridge (`agent/pre-step` -> `agent/request`):**
   * During `agent/request`, the user prompt does not yet exist in `session` (it is appended to event history after `prepareRequest` succeeds).
   * The message has already been cleared from `agent.inbox` via `inbox.claim()`.
   * **Solution:** Intercept the `agent/pre-step` waterfall hook, extract the uncommitted text from `payload.messages`, and store it in an ephemeral memory cache keyed by `turn`. Read and delete it during `agent/request`.

---

## 3. Provider & Adapter Conventions

DSH uses strict string keys for registered provider adapters. Deviating from these identifiers causes an immediate `NO_ADAPTER` runtime failure.

| Target Environment | DSH Provider Identifier | Default Model Identifier |
|---|---|---|
| **Local Inference (LM Studio)** | `lm-studio` | `qwen/qwen3.8-27b` |
| **Cloud Inference (DeepSeek)** | `deepseek-official` *(NOT `deepseek`)* | `deepseek-chat` or `deepseek-flash` |

*Note: For local routing to `lm-studio`, DSH requires setting `apiKey: 'KEY'` and stripping `reasoningEffort` to prevent malformed payload rejections.*

---

## 4. Decision Pipeline & Workload Matrix

Routing decisions follow a multi-gate evaluation process:

User Prompt
│
▼
[Gate 0: Local Routing Table] ─── (Pattern Match) ───► Route Immediately (< 0.01ms)
│
│ (No Match)
▼
[Gate 1: Laya Classifier Daemon] ── (POST /predict) ─► Route based on Complexity/Privacy
│
│ (Timeout / Offline)
▼
[Fallback] ──────────────────────────────────────────► Default to Local (RTX 5090)


### Gate 0: Declarative Workload Matrix

| Workload Category | Identifying Patterns / Keywords | Target Route | Target Provider | Assigned Complexity | Rationale |
|---|---|---|---|---|---|
| **Distributed Architecture** | `distributed`, `consensus`, `raft`, `paxos`, `zero-loss`, `heartbeat`, `failover`, `backpressure` | Cloud | `deepseek-official` | 2 | Complex state machine and invariant proof design. |
| **Concurrency & Async Bugs** | `deadlock`, `race condition`, `mutex`, `asyncio lock`, `thread starvation`, `memory leak` | Cloud | `deepseek-official` | 2 | Requires step-by-step trace of interleaved execution states. |
| **Root-Cause Debugging** | `why is this hanging`, `silent failure`, `diagnose crash`, `stack trace breakdown` | Cloud | `deepseek-official` | 2 | Open-ended deduction and hypothesis falsification. |
| **Algorithmic Math & Big-O** | `time complexity`, `big-o`, `dynamic programming`, `graph traversal`, `optimize math` | Cloud | `deepseek-official` | 2 | Deep verification and backtracking proofs. |
| **Frontend & UI Layout** | `css`, `html`, `tailwind`, `flexbox`, `grid`, `styling`, `navbar`, `modal`, `component` | Local | `lm-studio` | 0 | Declarative syntax; high token volume with minimal reasoning. |
| **Schemas & Interfaces** | `pydantic`, `zod`, `interface`, `typedef`, `dto`, `dataclass`, `json schema` | Local | `lm-studio` | 0 | Structural data translation with defined schemas. |
| **Unit Testing & Mocks** | `pytest`, `vitest`, `jest`, `unit test`, `test case`, `fixtures`, `mock` | Local | `lm-studio` | 0 | Deterministic assertion coverage against existing code. |
| **DevOps & System Scripts** | `dockerfile`, `docker-compose`, `bash script`, `powershell`, `systemd`, `nginx.conf` | Local | `lm-studio` | 0 | Standard boilerplate generation from common patterns. |

---

## 5. File Structure & Reference Implementation

### Project Layout

projects/dshlaya/plugin/
├── package.json
├── tsconfig.json
└── src/
├── index.ts          # DSH/Cordis lifecycle hooks & prompt bridge
├── router.ts         # Multi-gate router implementation
├── routing-table.ts  # Declarative Gate 0 rules matrix
└── types.ts          # Interfaces and config definitions


### `package.json`

```json
{
  "name": "dsh-plugin-laya-router",
  "version": "1.0.0",
  "description": "Intelligent dynamic local/cloud router for DSH",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
src/types.ts
TypeScript
export interface RouterConfig {
  layaEndpoint: string
  localProvider: string
  cloudProvider: string
  localModel: string
  cloudModel: string
  contextThreshold: number
  timeoutMs: number
}

export interface RouteDecision {
  provider: string
  model: string
  route: 'local' | 'cloud'
  gate: string
  rationale: string
  scores?: Record<string, any>
  latencyMs?: number
}

export interface RoutingRule {
  name: string
  patterns: RegExp[]
  target: 'local' | 'cloud'
  complexity: number
  rationale: string
}
src/routing-table.ts
TypeScript
import { RoutingRule } from './types'

export const LAYA_ROUTING_TABLE: RoutingRule[] = [
  // --- CLOUD HIGH-REASONING RULES ---
  {
    name: 'Distributed Systems & Architecture',
    patterns: [
      /\b(distributed|consensus|raft|paxos|backpressure|zero-loss|heartbeat|failover)\b/i,
      /\b(deadlock|race condition|mutex|concurrency|starvation|memory leak)\b/i,
    ],
    target: 'cloud',
    complexity: 2,
    rationale: 'Concurrency or distributed architecture requires deep cloud reasoning.',
  },
  {
    name: 'Root Cause Diagnostics',
    patterns: [
      /\b(why is this (hanging|failing)|diagnose|root cause|trace breakdown)\b/i,
    ],
    target: 'cloud',
    complexity: 2,
    rationale: 'Diagnostic deduction requires high-capacity verification.',
  },

  // --- LOCAL HIGH-VOLUME TOKEN RULES ---
  {
    name: 'Declarative Frontend & UI',
    patterns: [
      /\b(css|html|tailwind|flexbox|grid|styling|ui layout|navbar|modal|component)\b/i,
    ],
    target: 'local',
    complexity: 0,
    rationale: 'Declarative UI scaffolding. High token churn routed to local GPU.',
  },
  {
    name: 'Data Contracts & Schemas',
    patterns: [
      /\b(pydantic|zod|interface|typedef|dto|dataclass|json schema)\b/i,
    ],
    target: 'local',
    complexity: 0,
    rationale: 'Structural data mapping runs optimally on local 27B model.',
  },
  {
    name: 'Unit Tests & Fixtures',
    patterns: [
      /\b(pytest|vitest|jest|unit tests?|test cases?|fixtures?|mock)\b/i,
    ],
    target: 'local',
    complexity: 0,
    rationale: 'Assertion generation against provided source code.',
  },
  {
    name: 'DevOps & Shell Scripts',
    patterns: [
      /\b(dockerfile|docker-compose|bash script|powershell|systemd|nginx)\b/i,
    ],
    target: 'local',
    complexity: 0,
    rationale: 'Standard configuration boilerplate.',
  },
]
src/router.ts
TypeScript
import { RouterConfig, RouteDecision } from './types'
import { LAYA_ROUTING_TABLE } from './routing-table'

export class LayaRouter {
  constructor(private config: RouterConfig) {}

  async predictRoute(prompt: string): Promise<RouteDecision> {
    const startTime = performance.now()

    // Gate 0: Evaluate Declarative Routing Table
    for (const rule of LAYA_ROUTING_TABLE) {
      if (rule.patterns.some((pattern) => pattern.test(prompt))) {
        const isCloud = rule.target === 'cloud'
        return {
          provider: isCloud ? this.config.cloudProvider : this.config.localProvider,
          model: isCloud ? this.config.cloudModel : this.config.localModel,
          route: rule.target,
          gate: `Gate 0 (Table: ${rule.name})`,
          rationale: rule.rationale,
          scores: { complexity: rule.complexity, rule: rule.name },
          latencyMs: parseFloat((performance.now() - startTime).toFixed(2)),
        }
      }
    }

    // Gate 1: Evaluate Laya Classification Daemon
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)

      const res = await fetch(this.config.layaEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (res.ok) {
        const data = await res.json()
        const isCloud = data.complexity >= 2
        return {
          provider: isCloud ? this.config.cloudProvider : this.config.localProvider,
          model: isCloud ? this.config.cloudModel : this.config.localModel,
          route: isCloud ? 'cloud' : 'local',
          gate: isCloud ? 'Gate 1 (Laya - High Complexity)' : 'Gate 1 (Laya - Local Default)',
          rationale: data.rationale || 'Laya classifier score',
          scores: data.scores,
          latencyMs: parseFloat((performance.now() - startTime).toFixed(2)),
        }
      }
    } catch {
      // Daemon offline or timed out; fall through to local fallback
    }

    // Default Fallback
    return {
      provider: this.config.localProvider,
      model: this.config.localModel,
      route: 'local',
      gate: 'Fallback (Default Local)',
      rationale: 'Local execution default.',
      latencyMs: parseFloat((performance.now() - startTime).toFixed(2)),
    }
  }
}
src/index.ts
TypeScript
import { LayaRouter } from './router'
import { RouterConfig } from './types'

const DEFAULT_CONFIG: RouterConfig = {
  layaEndpoint: '[http://127.0.0.1:11435/predict](http://127.0.0.1:11435/predict)',
  localProvider: 'lm-studio',
  cloudProvider: 'deepseek-official', // MUST match DSH internal adapter ID
  localModel: 'qwen/qwen3.8-27b',
  cloudModel: 'deepseek-chat',
  contextThreshold: 30000,
  timeoutMs: 2000,
}

export function apply(ctx: any, userConfig?: Partial<RouterConfig>) {
  const config: RouterConfig = { ...DEFAULT_CONFIG, ...(userConfig || {}) }
  const router = new LayaRouter(config)

  // Ephemeral prompt bridge across uncommitted turn boundaries
  const pendingTurnPrompts = new Map<number, string>()

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

  // Hook 1: Capture prompt before inbox is emptied and before commit to session
  ctx.on(
    'agent/pre-step' as any,
    async (payload: any, next: any) => {
      const turn = payload?.turn
      const prompt = extractTextFromClaimedMessages(payload?.messages)
      if (turn !== undefined && prompt) {
        pendingTurnPrompts.set(turn, prompt)
      }
      return typeof next === 'function' ? await next() : payload
    },
    { prepend: true } as any
  )

  // Hook 2: Mutate call configuration before prepareCall() binds the adapter
  ctx.on(
    'agent/request' as any,
    async (payload: any, next: any) => {
      const resolvedConfig = typeof next === 'function' ? await next() : {}
      const turn = payload?.turn

      let prompt = ''
      if (turn !== undefined && pendingTurnPrompts.has(turn)) {
        prompt = pendingTurnPrompts.get(turn)!
        pendingTurnPrompts.delete(turn) // Guaranteed eviction prevents memory leaks
      }

      if (!prompt || prompt.trim().length === 0) {
        return resolvedConfig
      }

      const decision = await router.predictRoute(prompt)
      const isLocal = decision.provider === config.localProvider

      const mutatedConfig: Record<string, any> = {
        ...resolvedConfig,
        provider: decision.provider,
        model: decision.model,
      }

      if (isLocal) {
        mutatedConfig.apiKey = 'KEY'
        delete mutatedConfig.reasoningEffort
      } else {
        delete mutatedConfig.apiKey
      }

      return mutatedConfig
    },
    { prepend: true } as any
  )
}
6. Verification & Runbook
Trace Verification Checkpoints
When running dsh web --port 3085, verify routing state transitions against these checkpoints:

Pre-Step Prompt Capture:

JSON
=== HOOK_CAPTURE: PROMPT_CAPTURED (agent/pre-step) ===
{ "turn": 1, "prompt": "build a tailwind navbar" }
Local Decision Pass:

JSON
=== LAYA_ROUTER_DECISION (agent/request) ===
{
  "decision": {
    "provider": "lm-studio",
    "model": "qwen/qwen3.8-27b",
    "gate": "Gate 0 (Table: Declarative Frontend & UI)"
  }
}
=== HOOK_EXIT: FINAL_MUTATED_STATE (agent/request) ===
{ "provider": "lm-studio", "model": "qwen/qwen3.8-27b" }
Cloud Decision Pass:

JSON
=== LAYA_ROUTER_DECISION (agent/request) ===
{
  "decision": {
    "provider": "deepseek-official",
    "model": "deepseek-chat",
    "gate": "Gate 0 (Table: Distributed Systems & Architecture)"
  }
}
=== HOOK_EXIT: FINAL_MUTATED_STATE (agent/request) ===
{ "provider": "deepseek-official", "model": "deepseek-chat" }
Troubleshooting Reference
Issue: no adapter registered for provider "deepseek" (NO_ADAPTER)

Cause: Using "deepseek" instead of "deepseek-official".

Resolution: Update cloudProvider in config and routing-table.ts to deepseek-official.

Issue: TypeError: Cannot redefine property: provider

Cause: Modifying sessionOptions inside llm/stream after buildRequest() froze the object.

Resolution: Route inside agent/request by returning an updated configuration object. Do not mutate properties in llm/stream.

Issue: extracted_prompt: "" on Turn 1

Cause: Reading from session before messages are committed, or reading from agent.inbox after inbox.claim() has emptied it.

Resolution: Implement the agent/pre-step hook to intercept payload.messages and bridge the prompt via pendingTurnPrompts.
'@ | Set-Content -Path "C:\Projects\DSHLaya\spec.md" -Encoding utf8


To quickly verify that the file was created and check its line count, run:

```powershell
Get-Item C:\Projects\DSHLaya\spec.md | Select-Object Name, Length, LastWriteTime
For practical guidance on script-driven file creation and setting encodings in Windows PowerShell, this guide to reading and writing text files in PowerShell provides a clear walkthrough on using cmdlets like Set-Content to write cleanly formatted files.