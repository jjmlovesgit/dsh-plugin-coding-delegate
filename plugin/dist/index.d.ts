import type { Context } from '@deepseek-ai/cordis';
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker';
import { PROFILES, ProfileConfig } from './profiles';
import { extractAndEmitFiles } from './emission';
import { VerificationPolicy, parseTestOutput, runSandboxVerification } from './verification';
import { resolveContextFiles } from './context';
import { DelegateReadPolicy, GuardVerdict, evaluateDelegatedReadPolicy } from './guard';
import { SourceEgressPolicy, applyAgentRole, applyArchitectConfig, describeSourceRead, detectSourceEgress, evaluateSourceEgress, rememberAgentRole, resetAgentRoles, resolveAgentRole, resolveLeadProviders, roleForAgent } from './roles';
import { applySearchReplaceBlocks, delegateWorker, parseSearchReplaceBlocks, resolveDelegateStatus, resolveVerificationRepeats } from './delegation';
import { contractFileHashes, contractViolations, loadDelegatedRegistry, mergeDelegatedRecords, parseDelegatedRegistry, pruneDelegatedRecords, rememberDelegated, resolveContractFiles, resolveDelegatedRegistryPath, saveDelegatedRegistry, sha256File } from './contracts';
export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage };
export { resolveDataDir, trace } from './logging';
export { isPathWithin } from './paths';
export { evaluateEmissionPath, evaluateUnitScope, extractAndEmitFiles } from './emission';
export { DELETE_PRIMITIVES, evaluateCodeWriteGuard, evaluateDelegatedReadPolicy, hasCommandDeleteSignal, hasCommandWriteSignal, } from './guard';
export { AGENT_ROLE_LIMIT, DEFAULT_SOURCE_EGRESS_MIN_LINES, agentLineageRole, applyAgentRole, applyArchitectConfig, describeSourceRead, detectSourceEgress, evaluateSourceEgress, rememberAgentRole, resetAgentRoles, resolveAgentRole, resolveLeadProviders, roleForAgent, roleFromLineage, } from './roles';
export { ContextInjection, ContextRequest, ContextResolution, DEFAULT_CONTEXT_MAX_BYTES, resolveContextFiles, } from './context';
export { contractFileHashes, contractViolations, loadDelegatedRegistry, mergeDelegatedRecords, parseDelegatedRegistry, pruneDelegatedRecords, rememberDelegated, recordOperatorAttestation, resolveContractFiles, resolveDelegatedRegistryPath, saveDelegatedRegistry, sha256File, } from './contracts';
export { DEFAULT_VERIFICATION_POLICY, DEFAULT_VERIFICATION_TIMEOUT_MS, commandProgram, describeFailures, evaluateVerificationPolicy, parseTestOutput, redactVerificationOutput, resolveVerificationTimeoutMs, runInProcessFallback, runSandboxVerification, } from './verification';
export { ContextQuality, EMPTY_CONTEXT_QUALITY, describeContextQuality, foldContextQuality, } from './context-quality';
export { DELEGATE_WORKER_OPENAI_SCHEMA, DELEGATE_WORKER_SCHEMA, DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER, DEFAULT_LOCAL_ENDPOINT, MIN_SEARCH_CHARS, applySearchReplaceBlocks, delegateWorker, estimateTokenCount, extractPromptText, parseSearchReplaceBlocks, resolveChatCompletionsUrl, resolveDelegateStatus, resolveVerificationRepeats, } from './delegation';
export { FailureLocation, RETRY_CONTEXT_WINDOW_LINES, parseFailureLocations, retryContextRequests, } from './retry-context';
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
    /**
     * What a read of source code returns to the architect.
     *
     * `'source'` (the default) is the historical behaviour: the file's contents are served unchanged.
     *
     * `'declarations'` serves the compiled TYPE SKELETON instead -- declarations, signatures and doc
     * comments, with every function body stripped -- computed by the same `tsc` build that produces `dist/`.
     * This is the mechanical form of "inverted ingestion": what crosses to the model is whatever the
     * declaration emitter produced, so implementation bodies cannot leave the machine because of the shape of
     * the egress rather than because the model chose not to ask for them. Measured on this repository, the
     * skeleton is 3.3x smaller than the source with doc comments and 7.8x smaller without.
     *
     * A source file with no corresponding declaration is REFUSED rather than served as source. Failing closed
     * is the point: an unimplemented mapping must not silently become the hole it was built to close.
     * Requires `declarationRoot`.
     *
     * The limit worth knowing before turning this on: doc comments and signatures are preserved, not
     * summarised, so an implementation whose behaviour lives in its body is still invisible. This removes
     * bodies, not the need to read them when a defect has no structural signature.
     *
     * NOT the same option as `sourceEgress`, which is rule 8 and governs source inside a prompt payload.
     * This one governs file reads by a tool call. They are different leaks and they fail differently, so
     * they are named differently on purpose.
     */
    sourceReadEgress?: 'source' | 'declarations';
    /**
     * Directory holding emitted `.d.ts` files, used when `sourceReadEgress` is `'declarations'`. A source
     * path's tree below `src/` is preserved, so `src/guard.ts` resolves under this root as `guard.d.ts`.
     */
    declarationRoot?: string;
    /**
     * Who to name as the operator when an attestation is recorded through `delegate_worker`.
     *
     * An attestation is a HUMAN claim about content, so it needs a human to name. There is deliberately no
     * fallback to the calling agent's id: an autonomous session identifier cannot stand in for a person, and
     * stamping one into the registry would produce a record LESS attributable than a typed name while looking
     * like more. A delegation that asks for an attestation with no identity available is refused, with the
     * unit's own verdict left intact -- the delegation succeeded, and only the attestation did not.
     *
     * Set once per environment or developer seat. A call may override it with `attestOperator`, which is the
     * explicit-over-ambient precedence.
     */
    operatorIdentity?: string;
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
     * How long `delegate_worker`'s verification command may run before it is killed, in milliseconds.
     * Defaults to 30,000 — the value this used to be hardcoded to — so configuring nothing changes
     * nothing. Raise it for a contract whose command legitimately needs longer: a full suite, a build,
     * an install.
     *
     * A value that is not a positive finite number falls back to the default rather than removing the
     * bound. An unbounded command that is model-selected and runs with the DSH process's authority is a
     * hang, not a permission.
     */
    verificationTimeoutMs?: number;
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
    coherenceVerification?: string;
    /**
     * Whether a unit's declared `targetFiles` is a boundary. `'enforce'` (the default) refuses a write to
     * any path the unit did not declare; `'off'` restores the behaviour before the boundary existed.
     *
     * This is what makes the coherence check above attributable. A unit that sprawls can break the tree in
     * a way no record can assign to a unit, so `coherenceVerification` can say *that* something broke but
     * not *what*. Declared targets, enforced, are the other half of that pair.
     */
    unitScope?: 'enforce' | 'off';
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
    retryContext?: 'auto' | 'off';
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
export declare function scanDLP(text: string, options?: {
    entropyCheck?: boolean;
    entropyMinBitsPerChar?: number;
    entropyMinLength?: number;
}): {
    hasSensitiveData: boolean;
    violations: string[];
    highConfidence: boolean;
};
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
/**
 * Ask the operator before a delegation writes into a directory that is neither the session workspace
 * nor an allowlisted root. Same seam as the verification prompt above, and the same fail-closed rule:
 * no approval service, no agent, or a thrown request all resolve to refusal rather than to consent.
 */
export declare function requestApprovalForWorkspace(ctx: any, exec: any, dir: string, reason: string): Promise<boolean>;
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
    resolveVerificationRepeats: typeof resolveVerificationRepeats;
    MAX_VERIFICATION_REPEATS: number;
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
                    verificationRepeats: {
                        type: string;
                        description: string;
                    };
                    attestTargets: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    attestEvidence: {
                        type: string;
                        description: string;
                    };
                    attestOperator: {
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
                    verificationRepeats: {
                        type: string;
                        description: string;
                    };
                    attestTargets: {
                        type: string;
                        items: {
                            type: string;
                        };
                        description: string;
                    };
                    attestEvidence: {
                        type: string;
                        description: string;
                    };
                    attestOperator: {
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
