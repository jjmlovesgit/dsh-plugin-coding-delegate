import { Context } from 'cordis';
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker';
import { PROFILES, ProfileConfig } from './profiles';
import { extractAndEmitFiles } from './emission';
import { VerificationPolicy, parseTestOutput, runSandboxVerification } from './verification';
import { ContextRequest, resolveContextFiles } from './context';
import { DelegateReadPolicy, GuardVerdict, evaluateDelegatedReadPolicy } from './guard';
import { SourceEgressPolicy, applyAgentRole, applyArchitectConfig, describeSourceRead, detectSourceEgress, evaluateSourceEgress, rememberAgentRole, resetAgentRoles, resolveAgentRole, resolveLeadProviders, roleForAgent } from './roles';
import { contractFileHashes, contractViolations, loadDelegatedRegistry, mergeDelegatedRecords, parseDelegatedRegistry, pruneDelegatedRecords, rememberDelegated, resolveContractFiles, resolveDelegatedRegistryPath, saveDelegatedRegistry, sha256File } from './contracts';
export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage };
export { resolveDataDir, trace } from './logging';
export { isPathWithin } from './paths';
export { evaluateEmissionPath, extractAndEmitFiles } from './emission';
export { DELETE_PRIMITIVES, evaluateCodeWriteGuard, evaluateDelegatedReadPolicy, hasCommandDeleteSignal, hasCommandWriteSignal, } from './guard';
export { AGENT_ROLE_LIMIT, DEFAULT_SOURCE_EGRESS_MIN_LINES, applyAgentRole, applyArchitectConfig, describeSourceRead, detectSourceEgress, evaluateSourceEgress, rememberAgentRole, resetAgentRoles, resolveAgentRole, resolveLeadProviders, roleForAgent, } from './roles';
export { ContextInjection, ContextRequest, ContextResolution, DEFAULT_CONTEXT_MAX_BYTES, resolveContextFiles, } from './context';
export { contractFileHashes, contractViolations, loadDelegatedRegistry, mergeDelegatedRecords, parseDelegatedRegistry, pruneDelegatedRecords, rememberDelegated, resolveContractFiles, resolveDelegatedRegistryPath, saveDelegatedRegistry, sha256File, } from './contracts';
export { DEFAULT_VERIFICATION_POLICY, commandProgram, describeFailures, evaluateVerificationPolicy, parseTestOutput, redactVerificationOutput, runInProcessFallback, runSandboxVerification, } from './verification';
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
    /**
     * What happens to `delegate_worker`'s model-supplied `runVerification` command.
     * `'ask'` (default) routes it through the approval seam before anything executes;
     * `'allow'` restores the pre-hardening unattended behaviour; `'deny'` never runs it.
     */
    verificationApproval?: 'ask' | 'allow' | 'deny';
    /**
     * Verification programs (the command's first token) that skip the prompt under
     * `verificationApproval: 'ask'`. Weak by construction: it constrains the program,
     * not its arguments, so listing `node` also permits `node -e "<anything>"`.
     */
    verificationAllowlist?: string[];
    /**
     * Extra directories a delegated worker may write into besides the resolved session
     * workspace. Absolute worker paths and `..` escapes outside every allowed root are
     * refused and reported rather than written.
     */
    emitAllowlist?: string[];
    /**
     * Run the verification module inside the DSH server process when the sandbox denies
     * a piped spawn (default false). That fallback executes model-influenced code with
     * full host authority and can kill the server, so it is opt-in only.
     */
    allowInProcessFallback?: boolean;
    /**
     * Base URL of the local OpenAI-compatible server that `delegate_worker` posts to — for
     * example `http://127.0.0.1:11434/v1` for Ollama, or a vLLM/llama.cpp port. A full
     * `/chat/completions` URL is also accepted. Defaults to `http://127.0.0.1:1234/v1`.
     *
     * This is operator configuration, deliberately separate from the tool's arguments: a
     * caller-supplied `endpoint` is ignored, because honouring it would let the model redirect
     * a task — and the file contents it carries — to any address.
     */
    localEndpoint?: string;
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
    leadProviders?: string[];
    /**
     * Convenience switch for the lead tier: derives `leadProviders` from the LEAD profile, so the
     * provider id is declared in exactly one place. An explicit `leadProviders` list wins over it.
     *
     * Do not point this at the provider your architect session uses — the hook would stop pinning it,
     * which is the one failure direction that costs you source leaving the machine.
     */
    leadTier?: boolean;
    /**
     * What happens when an agent reads a file a delegated worker wrote. `ask` (default) prompts,
     * `deny` refuses, and `allow` permits it.
     *
     * `allow` exists for a lead tier that must read the code it writes contracts about, and it is an
     * honest weakening of rule 3 rather than a fix — the fix is the host exposing agent lineage. The
     * guard cannot yet tell the architect from a lead, so `allow` relaxes the rule for every agent.
     */
    delegateReadPolicy?: DelegateReadPolicy;
    /**
     * Paths whose source the architect may author, because a contract test is the specification rather
     * than the implementation. Rule 2 forbids the architect writing source and rule 7 needs the architect
     * to own the tests, which conflict for exactly this case, so this is the declared exception.
     * Defaults to `['tests/']`; an empty list disables the carve-out.
     */
    contractPaths?: string[];
    /**
     * What a write to a contract path does: `ask` (default), `allow`, or `deny`. Deliberately separate
     * from `guardAskPaths`, which decides what may be written at all; this decides what the architect is
     * allowed to specify. Setting `allow` is the opt-in that makes contract authoring frictionless.
     */
    contractWriteMode?: 'allow' | 'ask' | 'deny';
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
    sourceEgress?: SourceEgressPolicy;
    /** Lines a fenced source block needs before it counts (default 3). Lower is more false positives. */
    sourceEgressMinLines?: number;
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
export declare const name = "dsh-plugin-coding-delegate";
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
                contractFiles: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                contextFiles: {
                    type: string;
                    description: string;
                    items: {
                        type: string;
                        properties: {
                            path: {
                                type: string;
                            };
                            startLine: {
                                type: string;
                            };
                            endLine: {
                                type: string;
                            };
                        };
                        required: string[];
                    };
                };
                workspaceDir: {
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
                contractFiles: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                contextFiles: {
                    type: string;
                    description: string;
                    items: {
                        type: string;
                        properties: {
                            path: {
                                type: string;
                            };
                            startLine: {
                                type: string;
                            };
                            endLine: {
                                type: string;
                            };
                        };
                        required: string[];
                    };
                };
                workspaceDir: {
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
    /**
     * Paths to the tests that constitute this unit's contract. They are hashed before the worker
     * runs, refused as worker emission targets, and re-hashed afterwards: any change voids the
     * verdict. The architect owns these files and the executor never may, which is what stops a
     * unit from certifying itself.
     */
    contractFiles?: string[];
    /**
     * Existing files the worker needs to see, named by path with optional 1-based line ranges. The
     * plugin reads them and puts them in the worker's prompt; the architect never receives contents,
     * only a record of what was injected. This is the transport that lets a unit close on existing
     * code without the code entering the architect's context.
     */
    contextFiles?: ContextRequest[];
    /** Set false to return raw verification output. Raw output can carry source. */
    redactVerification?: boolean;
    /** Policy for the model-supplied `runVerification` command. */
    verificationPolicy?: VerificationPolicy;
    /**
     * Approval callback used when the policy resolves to `ask`. Absent means no approver is
     * reachable, which refuses the command rather than running it unattended.
     */
    verificationApproval?: (command: string) => Promise<boolean>;
    /** Extra roots the worker may write into beyond `workspaceDir`. */
    emitAllowlist?: string[];
}
/** Where the local worker is assumed to live when nothing else is configured. */
export declare const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:1234/v1";
/**
 * Accept either a base URL or a full chat-completions URL and return the full one, so
 * `localEndpoint: 'http://127.0.0.1:11434/v1'` (Ollama, vLLM, llama.cpp, …) works exactly as
 * written without the operator having to know this plugin appends the path.
 */
export declare function resolveChatCompletionsUrl(base: string): string;
/** A delta block: the bytes to find, and what to put there instead. */
export interface SearchReplaceBlock {
    search: string;
    replace: string;
}
export interface PatchResult {
    ok: boolean;
    content?: string;
    reason?: string;
}
/**
 * A one- or two-character search is unique by accident rather than by intent, so it is refused even
 * when the exactly-once rule would allow it. The property that matters is exactness, not cleverness.
 */
export declare const MIN_SEARCH_CHARS = 8;
/**
 * Recognise a search/replace body. The fenced header is shared with whole-file emission, so the body
 * decides the mode and the worker does not have to know which of the two it is producing.
 *
 * Returns null when there is no delta here, which tells the caller to treat the body as a whole file.
 * A body that *starts* a search/replace block but never finishes it returns an empty list instead --
 * never null -- so a malformed patch cannot fall through and be written over a real file.
 */
export declare function parseSearchReplaceBlocks(body: string): SearchReplaceBlock[] | null;
/**
 * Apply every block, or none. A partially applied change is worse than no change: it leaves the tree
 * in a state that no contract was written against.
 *
 * Everything is normalised to LF for matching and the file's own ending is restored at the end.
 * Nothing else is normalised -- indentation is bytes -- because a near miss must fail loudly rather
 * than be massaged into a match. Fuzzy patching is not a tuning choice here; it is the mechanism by
 * which a wrong edit lands silently.
 */
export declare function applySearchReplaceBlocks(content: string, blocks: SearchReplaceBlock[]): PatchResult;
/**
 * Status precedence, as a pure function so the ordering is testable without a server. Tampering
 * outranks everything: a modified contract voids the run even when verification passed, because
 * what passed was no longer the contract.
 */
export declare function resolveDelegateStatus(input: {
    verificationGate?: string | null;
    unverified: boolean;
    contractViolations: string[];
    isSuccess: boolean;
}): string;
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
/**
 * Commands that READ a file named on the command line rather than executing it.
 *
 * Without this list, `Select-String -Path some.js` was treated as an invocation of
 * `some.js`: the guard read the whole file and, since any sizeable program contains a write
 * primitive, asked for approval to *read* it. Reading a file is not running it.

}





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
export declare function resolveVerificationPolicy(options?: PluginConfig): VerificationPolicy;
/**
 * Ask the operator to approve one model-selected verification command. Unlike the write
 * guard this is not a `tools/pre-execute` decision, because the command runs after the
 * worker responds; it is asked before dispatch so the operator sees it up front.
 * Fails closed on every error path.
 */
export declare function requestApprovalForVerification(ctx: any, exec: any, command: string): Promise<boolean>;
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
    sha256File: typeof sha256File;
    resolveContextFiles: typeof resolveContextFiles;
    parseSearchReplaceBlocks: typeof parseSearchReplaceBlocks;
    applySearchReplaceBlocks: typeof applySearchReplaceBlocks;
    MIN_SEARCH_CHARS: number;
    DEFAULT_CONTEXT_MAX_BYTES: number;
    resolveContractFiles: typeof resolveContractFiles;
    contractFileHashes: typeof contractFileHashes;
    contractViolations: typeof contractViolations;
    resolveDelegateStatus: typeof resolveDelegateStatus;
    resolveLeadProviders: typeof resolveLeadProviders;
    evaluateDelegatedReadPolicy: typeof evaluateDelegatedReadPolicy;
    rememberAgentRole: typeof rememberAgentRole;
    roleForAgent: typeof roleForAgent;
    resetAgentRoles: typeof resetAgentRoles;
    describeSourceRead: typeof describeSourceRead;
    AGENT_ROLE_LIMIT: number;
    detectSourceEgress: typeof detectSourceEgress;
    evaluateSourceEgress: typeof evaluateSourceEgress;
    DEFAULT_SOURCE_EGRESS_MIN_LINES: number;
    resolveDelegatedRegistryPath: typeof resolveDelegatedRegistryPath;
    parseDelegatedRegistry: typeof parseDelegatedRegistry;
    mergeDelegatedRecords: typeof mergeDelegatedRecords;
    pruneDelegatedRecords: typeof pruneDelegatedRecords;
    saveDelegatedRegistry: typeof saveDelegatedRegistry;
    loadDelegatedRegistry: typeof loadDelegatedRegistry;
    rememberDelegated: typeof rememberDelegated;
    resolveAgentRole: typeof resolveAgentRole;
    applyArchitectConfig: typeof applyArchitectConfig;
    applyAgentRole: typeof applyAgentRole;
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
                    contractFiles: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    contextFiles: {
                        type: string;
                        description: string;
                        items: {
                            type: string;
                            properties: {
                                path: {
                                    type: string;
                                };
                                startLine: {
                                    type: string;
                                };
                                endLine: {
                                    type: string;
                                };
                            };
                            required: string[];
                        };
                    };
                    workspaceDir: {
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
                    contractFiles: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    contextFiles: {
                        type: string;
                        description: string;
                        items: {
                            type: string;
                            properties: {
                                path: {
                                    type: string;
                                };
                                startLine: {
                                    type: string;
                                };
                                endLine: {
                                    type: string;
                                };
                            };
                            required: string[];
                        };
                    };
                    workspaceDir: {
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
