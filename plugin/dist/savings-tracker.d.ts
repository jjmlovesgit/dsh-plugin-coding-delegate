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
    savedUSD: number;
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
    totalSavedUSD: number;
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
