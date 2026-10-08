export interface PricingRates {
    inputPerMillion: number;
    inputCachedPerMillion: number;
    outputPerMillion: number;
}
export type RouteType = 'ARCHITECT_CLOUD' | 'WORKER_LOCAL' | 'local' | 'cloud' | 'cloud-failover';
export interface StepUsage {
    turn?: number;
    route: RouteType;
    model?: string;
    reason?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens?: number;
    elapsedMs?: number;
    /**
     * What a unit decided, when this record is a delegation rather than a bare model call.
     *
     * Absent for anything that is not a unit verdict. Its presence is what makes a record a delegation,
     * so the ledger counts delegations without parsing the routing reason.
     */
    outcome?: string;
    /** Whether that verdict was a success. The signal that makes absorbed retries countable. */
    succeeded?: boolean;
    /** File bytes this unit produced -- content the architect never carried. */
    bytesWritten?: number;
}
export interface TurnRecord {
    turn: number;
    timestamp: string;
    route: RouteType;
    provider: string;
    model: string;
    routingReason: string;
    promptTokensEst: number;
    completionTokensEst: number;
    totalTokensEst: number;
    cacheHitRateEst: number;
    costUSD: number;
    /**
     * What these tokens would have cost at the metered tier. NOT a saving: the local GPU is a fixed cost
     * this plugin neither pays for nor reduces. See the audit line in `recordUsage`.
     */
    cloudEquivUSD: number;
    outcome?: string;
    succeeded?: boolean;
    bytesWritten?: number;
    elapsedMs?: number;
    tokensPerSecond?: number;
}
export interface LedgerSummary {
    totalTurns: number;
    totalTokens?: number;
    localTurns: number;
    cloudTurns: number;
    architectTurns: number;
    workerTurns: number;
    failoverTurns: number;
    totalLocalTokens: number;
    totalCloudTokens: number;
    totalSpendUSD?: number;
    totalCostUSD: number;
    /** Cumulative metered-tier equivalent of the delegated work. Not money saved. */
    totalCloudEquivUSD: number;
    /** Delegations recorded, and how many of them came back as failures. */
    delegations?: number;
    failedDelegations?: number;
    /**
     * File bytes produced by delegated work -- content that never entered the architect's context. This,
     * not any dollar figure, is what the plugin claims: code and churn stay in the worker so the
     * architect's window holds decisions. See `docs/experiment.md`.
     */
    bytesKeptOut?: number;
    /**
     * What this file covers. Stated in the file because four of its fields were once read as session-wide
     * when the ledger only ever records delegated work.
     */
    scope?: string;
    recentEvents?: TurnRecord[];
    history: TurnRecord[];
}
export declare const PRICING: {
    readonly INPUT_CACHE_HIT: number;
    readonly INPUT_CACHE_MISS: number;
    readonly OUTPUT_GENERATION: number;
    readonly WORKER_LOCAL: 0;
};
export declare class SavingsTracker {
    private ledgerPath;
    private rates;
    private activeTurns;
    constructor(baseDir?: string, rates?: Partial<PricingRates>);
    private estimateTokens;
    recordUsage(usage: StepUsage): TurnRecord;
    startTurn(turn: number, route: RouteType, provider: string, model: string, promptText: string, routingReason?: string): void;
    updateTurnRoute(turn: number, route: RouteType, provider: string, model: string, routingReason: string): void;
    accumulateChunk(turn: number, textChunk: string): void;
    recordCompletionTokens(turn: number, count: number): void;
    endTurn(turn: number): TurnRecord | null;
    private persist;
}
