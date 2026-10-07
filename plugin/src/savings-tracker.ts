import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Ledger location fallback: derive it, never hard-code a machine-specific path. */
function defaultLedgerDir(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim()) return path.join(dshHome.trim(), 'local-router')
  return path.join(os.homedir(), '.dsh', 'local-router')
}

export interface PricingRates {
  inputPerMillion: number // default: 0.14 (DeepSeek Chat cache miss standard)
  inputCachedPerMillion: number // default: 0.014 (DeepSeek Chat cache hit standard)
  outputPerMillion: number // default: 0.28 (DeepSeek Chat output standard)
}

export type RouteType = 'ARCHITECT_CLOUD' | 'WORKER_LOCAL' | 'local' | 'cloud' | 'cloud-failover'

export interface StepUsage {
  turn?: number
  route: RouteType
  model?: string
  reason?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens?: number
  elapsedMs?: number
}

export interface TurnRecord {
  turn: number
  timestamp: string
  route: RouteType
  provider: string
  model: string
  routingReason: string
  promptTokensEst: number
  completionTokensEst: number
  totalTokensEst: number
  cacheHitRateEst: number
  costUSD: number
  savedUSD: number
  elapsedMs?: number
  tokensPerSecond?: number
}

export interface LedgerSummary {
  totalTurns: number
  totalTokens?: number
  localTurns: number
  cloudTurns: number
  architectTurns: number
  workerTurns: number
  failoverTurns: number
  totalLocalTokens: number
  totalCloudTokens: number
  totalSpendUSD?: number
  totalCostUSD: number
  totalSavedUSD: number
  recentEvents?: TurnRecord[]
  history: TurnRecord[]
}

export const PRICING = {
  INPUT_CACHE_HIT: 0.014 / 1_000_000,
  INPUT_CACHE_MISS: 0.14 / 1_000_000,
  OUTPUT_GENERATION: 0.28 / 1_000_000,
  WORKER_LOCAL: 0,
} as const

export class SavingsTracker {
  private ledgerPath: string
  private rates: PricingRates
  private activeTurns = new Map<
    number,
    {
      route: RouteType
      provider: string
      model: string
      routingReason: string
      promptText: string
      completionText: string
      exactCompletionTokens?: number
    }
  >()

  constructor(baseDir: string = defaultLedgerDir(), rates?: Partial<PricingRates>) {
    this.ledgerPath = path.join(baseDir, 'savings-ledger.json')
    this.rates = {
      inputPerMillion: rates?.inputPerMillion ?? 0.14,
      inputCachedPerMillion: rates?.inputCachedPerMillion ?? 0.014,
      outputPerMillion: rates?.outputPerMillion ?? 0.28,
    }
  }

  private estimateTokens(text: string): number {
    if (!text) return 0
    return Math.ceil(text.length / 3.8)
  }

  public recordUsage(usage: StepUsage): TurnRecord {
    const turn = usage.turn ?? 1
    const route = usage.route || 'ARCHITECT_CLOUD'
    const model = usage.model || (route === 'WORKER_LOCAL' || route === 'local' ? 'qwen/qwen3.8-27b' : 'deepseek-chat')
    const reason = usage.reason || 'STEP_COMPLETION'

    const promptTokens = usage.promptTokens ?? 0
    const completionTokens = usage.completionTokens ?? 0
    const totalTokens = usage.totalTokens ?? (promptTokens + completionTokens)
    const cacheHitTokens = Math.min(promptTokens, usage.cacheHitTokens ?? 0)
    const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens)

    let costUSD = 0
    let savedUSD = 0

    const isLocal = route === 'WORKER_LOCAL' || route === 'local'

    if (isLocal) {
      costUSD = 0
      savedUSD = parseFloat(
        (promptTokens * PRICING.INPUT_CACHE_MISS + completionTokens * PRICING.OUTPUT_GENERATION).toFixed(6)
      )
    } else {
      savedUSD = 0
      costUSD = parseFloat(
        (
          cacheHitTokens * PRICING.INPUT_CACHE_HIT +
          cacheMissTokens * PRICING.INPUT_CACHE_MISS +
          completionTokens * PRICING.OUTPUT_GENERATION
        ).toFixed(6)
      )
    }

    const cacheHitRateEst = promptTokens > 0 ? parseFloat((cacheHitTokens / promptTokens).toFixed(2)) : 0

    const elapsedMs = usage.elapsedMs && usage.elapsedMs > 0 ? usage.elapsedMs : undefined
    const tokensPerSecond =
      elapsedMs !== undefined && completionTokens > 0
        ? parseFloat((completionTokens / (elapsedMs / 1000)).toFixed(1))
        : undefined

    const record: TurnRecord = {
      turn,
      timestamp: new Date().toISOString(),
      route,
      provider: isLocal ? 'lm-studio' : 'deepseek-official',
      model,
      routingReason: reason,
      promptTokensEst: promptTokens,
      completionTokensEst: completionTokens,
      totalTokensEst: totalTokens,
      cacheHitRateEst,
      costUSD,
      savedUSD,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    }

    this.persist(record)

    const rateText =
      tokensPerSecond !== undefined && elapsedMs !== undefined
        ? ` | Rate: ${tokensPerSecond} tok/s e2e (${completionTokens} tok in ${(elapsedMs / 1000).toFixed(2)}s)`
        : ''
    // 'CloudEquiv', not 'Saved'. The local GPU is a fixed cost this plugin neither pays for nor
    // reduces, so nothing here is money saved: a local card does not pay for itself against a
    // metered plan. This figure is what those tokens would have cost at the metered tier, which
    // measures the plan's exposure rather than a saving.
    const auditMsg = `[LEDGER_AUDIT] Step ${turn} [${route.toUpperCase()}] -> Model: ${model} | Reason: ${reason} | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens}, CacheHit: ${cacheHitTokens})${rateText} | Cost: $${costUSD.toFixed(6)} | CloudEquiv: $${savedUSD.toFixed(6)}`
    console.log(auditMsg)

    return record
  }

  public startTurn(
    turn: number,
    route: RouteType,
    provider: string,
    model: string,
    promptText: string,
    routingReason: string = 'STANDARD_ROUTING'
  ) {
    this.activeTurns.set(turn, {
      route,
      provider,
      model,
      routingReason,
      promptText,
      completionText: '',
    })
  }

  public updateTurnRoute(
    turn: number,
    route: RouteType,
    provider: string,
    model: string,
    routingReason: string
  ) {
    const active = this.activeTurns.get(turn)
    if (active) {
      active.route = route
      active.provider = provider
      active.model = model
      active.routingReason = routingReason
      active.completionText = ''
      delete active.exactCompletionTokens
    }
  }

  public accumulateChunk(turn: number, textChunk: string) {
    const active = this.activeTurns.get(turn)
    if (active && textChunk) {
      active.completionText += textChunk
    }
  }

  public recordCompletionTokens(turn: number, count: number) {
    const active = this.activeTurns.get(turn)
    if (active && count > 0) {
      active.exactCompletionTokens = count
    }
  }

  public endTurn(turn: number): TurnRecord | null {
    const active = this.activeTurns.get(turn)
    if (!active) return null

    this.activeTurns.delete(turn)

    const promptTokens = this.estimateTokens(active.promptText)
    const completionTokens = active.exactCompletionTokens ?? this.estimateTokens(active.completionText)
    const totalTokens = promptTokens + completionTokens

    return this.recordUsage({
      turn,
      route: active.route,
      model: active.model,
      reason: active.routingReason || 'TURN_COMPLETION',
      promptTokens,
      completionTokens,
      totalTokens,
    })
  }

  private persist(record: TurnRecord) {
    let ledger: LedgerSummary = {
      totalTurns: 0,
      totalTokens: 0,
      localTurns: 0,
      cloudTurns: 0,
      architectTurns: 0,
      workerTurns: 0,
      failoverTurns: 0,
      totalLocalTokens: 0,
      totalCloudTokens: 0,
      totalSpendUSD: 0,
      totalCostUSD: 0,
      totalSavedUSD: 0,
      recentEvents: [],
      history: [],
    }

    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, 'utf8')
        ledger = JSON.parse(raw)
      }
    } catch {}

    ledger.totalTurns += 1
    ledger.totalTokens = (ledger.totalTokens || 0) + record.totalTokensEst

    if (record.route === 'WORKER_LOCAL' || record.route === 'local') {
      ledger.localTurns += 1
      if (record.route === 'WORKER_LOCAL') ledger.workerTurns = (ledger.workerTurns || 0) + 1
      ledger.totalLocalTokens += record.totalTokensEst
      ledger.totalSavedUSD = parseFloat(((ledger.totalSavedUSD || 0) + record.savedUSD).toFixed(6))
    } else if (record.route === 'cloud-failover') {
      ledger.failoverTurns = (ledger.failoverTurns || 0) + 1
      ledger.totalCloudTokens += record.totalTokensEst
      ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6))
      ledger.totalSpendUSD = ledger.totalCostUSD
    } else {
      ledger.cloudTurns += 1
      if (record.route === 'ARCHITECT_CLOUD') ledger.architectTurns = (ledger.architectTurns || 0) + 1
      ledger.totalCloudTokens += record.totalTokensEst
      ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6))
      ledger.totalSpendUSD = ledger.totalCostUSD
    }

    ledger.history.push(record)

    if (ledger.history.length > 500) {
      ledger.history = ledger.history.slice(-500)
    }
    ledger.recentEvents = ledger.history.slice(-50)

    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true })
      fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), 'utf8')
    } catch (err) {
      console.error('[SAVINGS_TRACKER] Failed to write ledger:', err)
    }
  }
}
