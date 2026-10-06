import { Context } from 'cordis';
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker';
import { PROFILES, ProfileConfig } from './profiles';
export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage };
export declare const inject: string[];
export declare const using: readonly ["tools"];
export interface PluginConfig {
    localProvider?: string;
    cloudProvider?: string;
    localModel?: string;
    cloudModel?: string;
    contextTokenThreshold?: number;
    contextThreshold?: number;
    timeoutMs?: number;
    enforceDLP?: boolean;
    /**
     * What a tripped DLP firewall does with an outbound request: `'block'`
     * (default) refuses to transmit it, `'local'` reroutes it to the local worker.
     * Either way the credential never reaches the cloud.
     */
    dlpAction?: 'block' | 'local';
    /** Enable the high-entropy backstop (default true). */
    entropyCheck?: boolean;
    /** Bits per character above which a token counts as suspiciously random (default 4.5). */
    entropyMinBitsPerChar?: number;
    /** Minimum token length before entropy is scored (default 20). */
    entropyMinLength?: number;
    /** Refuse cloud-authored writes to source files (default: true). */
    localCodeGuard?: boolean;
    /** Force every guard hit to an approval prompt instead of a hard deny. */
    guardMode?: 'deny' | 'ask';
    /** Path fragments that downgrade a deny to an approval prompt. */
    guardAskPaths?: string[];
}
export interface RouterMetadata {
    provider: string;
    model?: string;
    route: RouteType;
    gate: string;
    rationale: string;
    tier: string;
    estimatedTokens: number;
    dlpViolations?: string[];
    scores?: {
        is_private: number;
        complexity: number;
        target: string;
    };
    latencyMs?: number;
    failover?: boolean;
    previousProvider?: string;
}
export interface LLMSession {
    provider?: string;
    model?: string;
    prompt?: string;
    input?: string;
    apiKey?: string;
    reasoningEffort?: string;
    messages?: Array<{
        role: string;
        content: any;
    }>;
    options?: {
        provider?: string;
        model?: string;
        apiKey?: string;
        reasoningEffort?: string;
        [key: string]: any;
    };
    metadata?: {
        router?: RouterMetadata;
        [key: string]: any;
    };
    redispatch?: () => Promise<any>;
    retry?: () => Promise<any>;
    [key: string]: any;
}
export declare const name = "dsh-plugin-local-router";
/**
 * All plugin state (debug log, savings ledger) lives under one derived directory.
 * It must never be a hard-coded absolute path: the previous build wrote its log
 * into the plugin author's own project directory on every machine, which was
 * correct on exactly one of them.
 * Precedence: explicit env override, then DSH_HOME, then ~/.dsh.
 */
export declare function resolveDataDir(): string;
export declare const DELEGATE_WORKER_OPENAI_SCHEMA: {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                taskName: {
                    type: string;
                    description: string;
                };
                instruction: {
                    type: string;
                    description: string;
                };
                targetFiles: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                runVerification: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare const DELEGATE_WORKER_SCHEMA: {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                taskName: {
                    type: string;
                    description: string;
                };
                instruction: {
                    type: string;
                    description: string;
                };
                targetFiles: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                runVerification: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
};
export declare function scanDLP(text: string, options?: {
    entropyCheck?: boolean;
    entropyMinBitsPerChar?: number;
    entropyMinLength?: number;
}): {
    hasSensitiveData: boolean;
    violations: string[];
    highConfidence: boolean;
};
export interface FileEmissionResult {
    path: string;
    relativeName: string;
    lines: number;
    bytes: number;
}
export declare function extractAndEmitFiles(content: string, targetFilesHint?: string[] | string, baseDir?: string): {
    filesWritten: FileEmissionResult[];
    errors: string[];
    cleanContent: string;
};
/** A failure described without source: enough to diagnose, not enough to leak code. */
export interface RedactedFailure {
    kind: 'assertion' | 'compile' | 'timeout' | 'runtime' | 'unknown';
    /** Subtest name, when the runner reports one. */
    name?: string;
    /** file:line or file:line:col. */
    location?: string;
    /** Runner or compiler error code, e.g. TS1434 or ERR_ASSERTION. */
    code?: string;
    /** The assertion label, kept only when it reads as prose rather than code. */
    message?: string;
}
export interface TestResults {
    passed: number;
    failed: number;
    /** Redacted summary. Raw output never leaves the machine by default. */
    output: string;
    errorSummary?: string;
    /** Structured failures: names, locations, error kinds. */
    failures?: RedactedFailure[];
    /** True when the output above was passed through the redactor. */
    redacted?: boolean;
    /** Where the FULL raw output was written locally, for the worker and the operator. */
    rawOutputPath?: string;
}
/**
 * Reduce raw verification output to a source-free structure.
 *
 * Only named fields are ever copied out of a failure block; every other line inside it
 * (stack frames, expected/actual, diff markers, quoted code) is discarded by omission
 * rather than by pattern-matching each leak shape.
 */
export declare function redactVerificationOutput(raw: string): RedactedFailure[];
/** One line per failure: kind, name, location, code, prose message. Never source. */
export declare function describeFailures(failures: RedactedFailure[]): string[];
export declare function parseTestOutput(output: string, exitCode?: number, options?: {
    redact?: boolean;
    rawOutputPath?: string;
}): TestResults;
export declare function runInProcessFallback(cmd: string, workspaceDir: string): string;
export declare function runSandboxVerification(verificationCommand: string, workspaceDir?: string, options?: {
    redact?: boolean;
    rawLogPath?: string;
}): TestResults;
export interface DelegateWorkerParams {
    instruction?: string;
    taskPrompt?: string;
    prompt?: string;
    taskName?: string;
    targetFiles?: string[] | string;
    fileContext?: string;
    systemPrompt?: string;
    runVerification?: string;
    endpoint?: string;
    model?: string;
    turnId?: number;
    timeoutMs?: number;
    workspaceDir?: string;
    workspaceSource?: string;
    /** Set false to return raw verification output. Raw output can carry source. */
    redactVerification?: boolean;
}
export declare function delegateWorker(params?: DelegateWorkerParams, tracker?: SavingsTracker): Promise<any>;
export declare function extractPromptText(session: LLMSession | any): string;
export declare function estimateTokenCount(text: string): number;
interface EffectiveConfig {
    localProvider: string;
    cloudProvider: string;
    localModel: string;
    cloudModel: string;
    contextThreshold: number;
    timeoutMs: number;
    enforceDLP: boolean;
}
export declare class LocalRouter {
    private config;
    constructor(config?: PluginConfig);
    getConfig(): EffectiveConfig;
    predictRoute(promptText: string): Promise<{
        provider: string;
        model: string;
        route: RouteType;
        gate: string;
        rationale: string;
        scores: any;
        latencyMs: number;
        dlpViolations?: string[];
    }>;
    handleBeforeRequest(session: LLMSession): Promise<LLMSession>;
    handleError(session: LLMSession, error: any): Promise<LLMSession>;
}
export interface GuardVerdict {
    kind: 'deny' | 'ask';
    target: string;
    reason: string;
}
/**
 * Decide whether a tool call would author source code from the cloud context.
 * Pure and exported so it can be unit-tested without a running server.
 * Returns null when the call has nothing to do with code authoring.
 */
export declare function evaluateCodeWriteGuard(exec: any, config?: {
    askPaths?: string[];
    /** Injectable reader, so the script scan is testable without touching disk. */
    readScript?: (script: string) => string | undefined;
    /** How deep to follow script-invokes-script (default 2). */
    scriptDepth?: number;
}): GuardVerdict | null;
/** Closed approval vocabulary; only 'allowed-once' is a grant. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
/**
 * Route an `ask` guard decision through the real approval seam.
 *
 * Returning `{ kind: 'ask' }` from a tools/pre-execute listener prompts nobody: the
 * pipeline understands only `deny`, so every other kind is an allow. The seam that
 * actually asks is `dsh-user-approval` (ctx.approval), and it fails closed — a
 * missing service, a missing agent, an idle turn or a throwing answerer all resolve
 * to 'unavailable', which this treats as a refusal.
 */
export declare function requestApprovalForWrite(ctx: any, exec: any, verdict: GuardVerdict): Promise<ApprovalOutcome>;
export declare function apply(ctx: Context, options?: PluginConfig): void;
declare const pluginExport: {
    name: string;
    inject: string[];
    using: readonly ["tools"];
    apply: typeof apply;
    LocalRouter: typeof LocalRouter;
    SavingsTracker: typeof SavingsTracker;
    scanDLP: typeof scanDLP;
    delegateWorker: typeof delegateWorker;
    extractAndEmitFiles: typeof extractAndEmitFiles;
    runSandboxVerification: typeof runSandboxVerification;
    parseTestOutput: typeof parseTestOutput;
    DELEGATE_WORKER_SCHEMA: {
        type: string;
        function: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    taskName: {
                        type: string;
                        description: string;
                    };
                    instruction: {
                        type: string;
                        description: string;
                    };
                    targetFiles: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    runVerification: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    DELEGATE_WORKER_OPENAI_SCHEMA: {
        type: string;
        function: {
            name: string;
            description: string;
            parameters: {
                type: string;
                properties: {
                    taskName: {
                        type: string;
                        description: string;
                    };
                    instruction: {
                        type: string;
                        description: string;
                    };
                    targetFiles: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    runVerification: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
    };
    PROFILES: import("./profiles").Profiles;
    default: typeof apply;
};
export default pluginExport;
