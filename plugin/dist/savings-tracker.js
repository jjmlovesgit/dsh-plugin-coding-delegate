"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SavingsTracker = exports.PRICING = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** Ledger location fallback: derive it, never hard-code a machine-specific path. */
function defaultLedgerDir() {
    const dshHome = process.env.DSH_HOME;
    if (dshHome && dshHome.trim())
        return path.join(dshHome.trim(), 'local-router');
    return path.join(os.homedir(), '.dsh', 'local-router');
}
exports.PRICING = {
    INPUT_CACHE_HIT: 0.014 / 1_000_000,
    INPUT_CACHE_MISS: 0.14 / 1_000_000,
    OUTPUT_GENERATION: 0.28 / 1_000_000,
    WORKER_LOCAL: 0,
};
class SavingsTracker {
    ledgerPath;
    rates;
    activeTurns = new Map();
    constructor(baseDir = defaultLedgerDir(), rates) {
        this.ledgerPath = path.join(baseDir, 'savings-ledger.json');
        this.rates = {
            inputPerMillion: rates?.inputPerMillion ?? 0.14,
            inputCachedPerMillion: rates?.inputCachedPerMillion ?? 0.014,
            outputPerMillion: rates?.outputPerMillion ?? 0.28,
        };
    }
    estimateTokens(text) {
        if (!text)
            return 0;
        return Math.ceil(text.length / 3.8);
    }
    recordUsage(usage) {
        const turn = usage.turn ?? 1;
        const route = usage.route || 'ARCHITECT_CLOUD';
        const model = usage.model || (route === 'WORKER_LOCAL' || route === 'local' ? 'qwen/qwen3.8-27b' : 'deepseek-chat');
        const reason = usage.reason || 'STEP_COMPLETION';
        const promptTokens = usage.promptTokens ?? 0;
        const completionTokens = usage.completionTokens ?? 0;
        const totalTokens = usage.totalTokens ?? (promptTokens + completionTokens);
        const cacheHitTokens = Math.min(promptTokens, usage.cacheHitTokens ?? 0);
        const cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens);
        let costUSD = 0;
        let cloudEquivUSD = 0;
        const isLocal = route === 'WORKER_LOCAL' || route === 'local';
        if (isLocal) {
            costUSD = 0;
            cloudEquivUSD = parseFloat((promptTokens * exports.PRICING.INPUT_CACHE_MISS + completionTokens * exports.PRICING.OUTPUT_GENERATION).toFixed(6));
        }
        else {
            cloudEquivUSD = 0;
            costUSD = parseFloat((cacheHitTokens * exports.PRICING.INPUT_CACHE_HIT +
                cacheMissTokens * exports.PRICING.INPUT_CACHE_MISS +
                completionTokens * exports.PRICING.OUTPUT_GENERATION).toFixed(6));
        }
        const cacheHitRateEst = promptTokens > 0 ? parseFloat((cacheHitTokens / promptTokens).toFixed(2)) : 0;
        const elapsedMs = usage.elapsedMs && usage.elapsedMs > 0 ? usage.elapsedMs : undefined;
        const tokensPerSecond = elapsedMs !== undefined && completionTokens > 0
            ? parseFloat((completionTokens / (elapsedMs / 1000)).toFixed(1))
            : undefined;
        const record = {
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
            cloudEquivUSD,
            // The verdict, when there is one. Its presence is what marks this record a delegation rather than
            // a bare model call, which is how the ledger counts delegations and absorbed failures without
            // having to parse the routing reason.
            ...(usage.outcome !== undefined ? { outcome: usage.outcome } : {}),
            ...(usage.succeeded !== undefined ? { succeeded: usage.succeeded } : {}),
            ...(usage.bytesWritten !== undefined ? { bytesWritten: usage.bytesWritten } : {}),
            ...(elapsedMs !== undefined ? { elapsedMs } : {}),
            ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
        };
        const ledger = this.persist(record);
        const rateText = tokensPerSecond !== undefined && elapsedMs !== undefined
            ? ` | Rate: ${tokensPerSecond} tok/s e2e (${completionTokens} tok in ${(elapsedMs / 1000).toFixed(2)}s)`
            : '';
        // 'CloudEquiv', not 'Saved'. The local GPU is a fixed cost this plugin neither pays for nor
        // reduces, so nothing here is money saved: a local card does not pay for itself against a
        // metered plan. This figure is what those tokens would have cost at the metered tier, which
        // measures the plan's exposure rather than a saving.
        const auditMsg = `[LEDGER_AUDIT] Step ${turn} [${route.toUpperCase()}] -> Model: ${model} | Reason: ${reason} | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Completion: ${completionTokens}, CacheHit: ${cacheHitTokens})${rateText} | Cost: $${costUSD.toFixed(6)} | CloudEquiv: $${cloudEquivUSD.toFixed(6)} | Metered: ${ledger.totalCloudTokens} tok | Local: ${ledger.totalLocalTokens} tok | Delegations: ${ledger.delegations ?? 0} (failed ${ledger.failedDelegations ?? 0}) | Kept out: ${ledger.bytesKeptOut ?? 0} B`;
        console.log(auditMsg);
        return record;
    }
    startTurn(turn, route, provider, model, promptText, routingReason = 'STANDARD_ROUTING') {
        this.activeTurns.set(turn, {
            route,
            provider,
            model,
            routingReason,
            promptText,
            completionText: '',
        });
    }
    updateTurnRoute(turn, route, provider, model, routingReason) {
        const active = this.activeTurns.get(turn);
        if (active) {
            active.route = route;
            active.provider = provider;
            active.model = model;
            active.routingReason = routingReason;
            active.completionText = '';
            delete active.exactCompletionTokens;
        }
    }
    accumulateChunk(turn, textChunk) {
        const active = this.activeTurns.get(turn);
        if (active && textChunk) {
            active.completionText += textChunk;
        }
    }
    recordCompletionTokens(turn, count) {
        const active = this.activeTurns.get(turn);
        if (active && count > 0) {
            active.exactCompletionTokens = count;
        }
    }
    endTurn(turn) {
        const active = this.activeTurns.get(turn);
        if (!active)
            return null;
        this.activeTurns.delete(turn);
        const promptTokens = this.estimateTokens(active.promptText);
        const completionTokens = active.exactCompletionTokens ?? this.estimateTokens(active.completionText);
        const totalTokens = promptTokens + completionTokens;
        return this.recordUsage({
            turn,
            route: active.route,
            model: active.model,
            reason: active.routingReason || 'TURN_COMPLETION',
            promptTokens,
            completionTokens,
            totalTokens,
        });
    }
    persist(record) {
        let ledger = {
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
            totalCloudEquivUSD: 0,
            delegations: 0,
            failedDelegations: 0,
            bytesKeptOut: 0,
            scope: '',
            recentEvents: [],
            history: [],
        };
        try {
            if (fs.existsSync(this.ledgerPath)) {
                const raw = fs.readFileSync(this.ledgerPath, 'utf8');
                ledger = JSON.parse(raw);
            }
        }
        catch { }
        // Carried forward from the name this used to have. The name was wrong, not the number: the local GPU
        // is a fixed cost, so nothing here is money saved. Losing the history to a rename would be its own
        // small dishonesty.
        if (ledger.totalCloudEquivUSD === undefined && ledger.totalSavedUSD !== undefined) {
            ledger.totalCloudEquivUSD = ledger.totalSavedUSD;
        }
        delete ledger.totalSavedUSD;
        ledger.totalTurns += 1;
        ledger.totalTokens = (ledger.totalTokens || 0) + record.totalTokensEst;
        if (record.route === 'WORKER_LOCAL' || record.route === 'local') {
            ledger.localTurns += 1;
            if (record.route === 'WORKER_LOCAL')
                ledger.workerTurns = (ledger.workerTurns || 0) + 1;
            ledger.totalLocalTokens += record.totalTokensEst;
            ledger.totalCloudEquivUSD = parseFloat(((ledger.totalCloudEquivUSD || 0) + record.cloudEquivUSD).toFixed(6));
        }
        else if (record.route === 'cloud-failover') {
            ledger.failoverTurns = (ledger.failoverTurns || 0) + 1;
            ledger.totalCloudTokens += record.totalTokensEst;
            ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6));
            ledger.totalSpendUSD = ledger.totalCostUSD;
        }
        else {
            ledger.cloudTurns += 1;
            if (record.route === 'ARCHITECT_CLOUD')
                ledger.architectTurns = (ledger.architectTurns || 0) + 1;
            ledger.totalCloudTokens += record.totalTokensEst;
            ledger.totalCostUSD = parseFloat(((ledger.totalCostUSD || 0) + record.costUSD).toFixed(6));
            ledger.totalSpendUSD = ledger.totalCostUSD;
        }
        // Context hygiene, not money. These count what the architect never had to carry: content the worker
        // produced, and attempts that came back as failures. The compounding is the point -- what is kept out
        // of the window is kept out of every later call, not only the one that produced it.
        if (record.outcome !== undefined) {
            ledger.delegations = (ledger.delegations || 0) + 1;
            if (record.succeeded === false)
                ledger.failedDelegations = (ledger.failedDelegations || 0) + 1;
        }
        if (record.bytesWritten) {
            ledger.bytesKeptOut = (ledger.bytesKeptOut || 0) + record.bytesWritten;
        }
        // Stated in the file, because four of these fields were once read as session-wide when the ledger has
        // only ever recorded delegated work. A measurement whose scope is implicit will be misread.
        ledger.scope =
            'cumulative across sessions; records delegated worker calls, not architect turns or a session total';
        ledger.history.push(record);
        if (ledger.history.length > 500) {
            ledger.history = ledger.history.slice(-500);
        }
        ledger.recentEvents = ledger.history.slice(-50);
        try {
            fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
            fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
        }
        catch (err) {
            console.error('[SAVINGS_TRACKER] Failed to write ledger:', err);
        }
        return ledger;
    }
}
exports.SavingsTracker = SavingsTracker;
