import { Context } from 'cordis';
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker';
import { PROFILES, ProfileConfig } from './profiles';
export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage };
export { resolveDataDir, trace } from './logging';
export { isPathWithin } from './paths';
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
export interface FileEmissionResult {
    path: string;
    relativeName: string;
    lines: number;
    bytes: number;
    /** How the change arrived: a whole file, or a delta against the file already there. */
    mode?: 'write' | 'patch';
    /** Search/replace blocks applied, when the emission was a patch. */
    hunks?: number;
}
/**
 * The containment decision for one delegated write. `baseDir` is the session workspace
 * and `allowedRoots` is the operator's explicit extension list. Both sides are
 * canonicalised, so a symlink inside the workspace cannot be used to escape it.
 */
export declare function evaluateEmissionPath(resolvedPath: string, baseDir: string, allowedRoots?: string[]): {
    allowed: boolean;
    reason?: string;
};
export declare function extractAndEmitFiles(content: string, targetFilesHint?: string[] | string, baseDir?: string, allowedRoots?: string[], protectedPaths?: string[]): {
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
export interface VerificationPolicy {
    mode: 'ask' | 'allow' | 'deny';
    allowlist: string[];
    allowInProcessFallback: boolean;
}
export declare const DEFAULT_VERIFICATION_POLICY: VerificationPolicy;
/** The program a shell command would run, normalised for allowlist comparison. */
export declare function commandProgram(command: string): string;
/**
 * Decide whether a model-supplied verification command may run. Pure, so the policy is
 * testable without a server or an approval seam. `runVerification` is model-selected and
 * executes with the DSH process's full authority, so silence is never consent: anything
 * not explicitly permitted resolves to `ask`, and `ask` with no approver available is a
 * refusal at the call site.
 */
export declare function evaluateVerificationPolicy(command: string, policy?: VerificationPolicy): {
    kind: 'allow' | 'ask' | 'deny';
    program: string;
    reason: string;
};
export declare function runSandboxVerification(verificationCommand: string, workspaceDir?: string, options?: {
    redact?: boolean;
    rawLogPath?: string;
    allowInProcessFallback?: boolean;
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
/** One file the architect wants the worker to see. Names and ranges only, never contents. */
export interface ContextRequest {
    path: string;
    startLine?: number;
    endLine?: number;
}
/**
 * What the architect is told about an injection. Deliberately has no `content` field — the whole
 * point is that the code travels to the worker and does not travel back.
 */
export interface ContextInjection {
    path: string;
    relativeName: string;
    lineRange: {
        start: number;
        end: number;
    } | null;
    lines: number;
    bytes: number;
    sha256: string;
}
export interface ContextResolution {
    injected: ContextInjection[];
    text: string;
    errors: string[];
}
/**
 * Injected context competes with the instruction for the worker's input window, so the budget is a
 * safety bound rather than a caller preference. Over budget refuses; it never truncates quietly,
 * because a worker given half a file answers confidently about a file it only half saw.
 */
export declare const DEFAULT_CONTEXT_MAX_BYTES = 32768;
/**
 * Read the files the architect named and render them for the worker's prompt. Containment matches
 * emission exactly: the same resolution, and the same refusal of escapes and absolute paths outside
 * the root, because reading a file in order to transmit it is an egress route and deserves the same
 * scepticism as writing one.
 */
export declare function resolveContextFiles(requests: ContextRequest[] | undefined, baseDir: string, allowedRoots?: string[], maxBytes?: number): ContextResolution;
/**
 * sha256 of a file, or null when it cannot be read. Callers treat null as a failure rather than as
 * absence: a contract file that vanished is a violation, not an empty string.
 */
export declare function sha256File(filePath: string): string | null;
/**
 * Resolve the architect's declared contract paths against the workspace. Names only: the architect
 * never supplies contents, and the resolved list is what the worker is forbidden to write.
 */
export declare function resolveContractFiles(files: string[] | undefined, baseDir: string): string[];
/** Keyed by canonical path so two spellings of one file cannot pass as two files. */
export declare function contractFileHashes(paths: Iterable<string>): Record<string, string | null>;
/**
 * Anything that changed a declared file during a unit invalidates the verdict, whatever the tests
 * then reported. A missing declaration is reported too, because failing closed is the only safe
 * reading of "the architect declared a contract file that is not there".
 */
export declare function contractViolations(before: Record<string, string | null>, after: Record<string, string | null>): string[];
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
/** One delegated file as it is persisted: where it is, and what was written there. */
export interface DelegatedRecord {
    path: string;
    sha256: string | null;
    at: number;
    /**
     * How the worker touched this file. `created` means it produced the whole thing and the architect has
     * never seen it, so reading it back is the thing rule 3 forbids. `patched` means it changed part of a
     * file the architect already had -- the architect must stay able to read that, or iterating on an
     * existing file becomes impossible the moment a patch to it has been delegated once.
     */
    mode: 'created' | 'patched';
}
export declare function resolveDelegatedRegistryPath(): string;
/**
 * Parse a registry file. Anything unreadable, malformed, or entry-shaped-but-wrong yields no records
 * rather than an exception: a corrupt registry must never be able to stop the plugin loading.
 */
export declare function parseDelegatedRegistry(text: string): DelegatedRecord[];
/**
 * Newest wins per path, and the oldest fall off the end once the limit is reached. The hash is not
 * used to relax anything — a delegated file stays protected however it later changes — it makes the
 * record answerable, and gives the prune below something to reason about.
 */
export declare function mergeDelegatedRecords(existing: DelegatedRecord[], incoming: DelegatedRecord[], limit?: number): DelegatedRecord[];
/** A path whose file is gone protects nothing, so it is dropped. */
export declare function pruneDelegatedRecords(records: DelegatedRecord[], exists?: (p: string) => boolean): DelegatedRecord[];
/** Best effort by design: failing to persist must not fail a delegation that was already paid for. */
export declare function saveDelegatedRegistry(records: DelegatedRecord[]): boolean;
/** Load, validate and prune. Called at startup so a restart does not forget what was delegated. */
export declare function loadDelegatedRegistry(): DelegatedRecord[];
export declare function rememberDelegated(paths: string[], mode?: 'created' | 'patched'): void;
export interface GuardVerdict {
    kind: 'deny' | 'ask';
    target: string;
    reason: string;
}
/**
 * Does this command line carry a write signal? A redirection counts only when it is a
 * real one: an `=>` in inline program text and a `2>&1` must not turn a read-only
 * command into an approval prompt.
 */
export declare function hasCommandWriteSignal(command: string): boolean;
/**
 * Delete-capable constructs, checked against BOTH a command line and a script body.
 * Destroying a source file is at least as consequential as overwriting it, and the first
 * version of this guard left deletion entirely ungated. API-level removals are included
 * because inline program text (`python -c "os.remove(...)"`) never names a verb the
 * command line displays. Word-anchored for the same reason as the write list: unanchored,
 * `rm` matches inside unrelated paths and `Move-Item` matches inside `Remove-Item`.
 */
export declare const DELETE_PRIMITIVES: RegExp;
/** Does this command line or script body carry a delete signal? */
export declare function hasCommandDeleteSignal(text: string): boolean;
/**
 * Decide whether a tool call would author source code from the cloud context.
 * Pure and exported so it can be unit-tested without a running server.
 * Returns null when the call has nothing to do with code authoring.
 */
export type SourceEgressPolicy = 'deny' | 'ask' | 'allow';
/** Blocks shorter than this are treated as quotations rather than as code being handed over. */
export declare const DEFAULT_SOURCE_EGRESS_MIN_LINES = 3;
export interface SourceEgressDetection {
    found: boolean;
    blocks: number;
    languages: string[];
}
/**
 * Look for source being handed to a cloud provider.
 *
 * Only fenced blocks with a source language tag and at least `minLines` lines count. Prose about code
 * does not, and neither does an untagged block — that is a real false negative and the oracle asserts
 * it, so this is never mistaken for a proof that source cannot leave. Like the rest of the guard it is
 * a deterrent, pointed at the one route the other gates do not cover: source sitting in the outbound
 * payload because it was typed into a cloud-bound conversation.
 */
export declare function detectSourceEgress(text: string, options?: {
    minLines?: number;
}): SourceEgressDetection;
/**
 * Rule 8: source may not reach the cloud. A request bound for the local worker is not egress at all,
 * so the policy never applies to it — which is the entire reason the lead tier runs locally.
 */
export declare function evaluateSourceEgress(action: SourceEgressPolicy, detection: SourceEgressDetection, destination: 'cloud' | 'local'): {
    kind: 'allow' | 'ask' | 'deny';
    reason: string;
};
export type DelegateReadPolicy = 'ask' | 'allow' | 'deny';
/**
 * What happens when an agent reads a file a delegated worker wrote.
 *
 * The guard cannot yet tell the architect from a lead, so it gates any agent reading delegated code.
 * `ask` is the right default: pulling that code back into the architect's context defeats the point of
 * having delegated it, but reviewing a line is sometimes exactly what an operator wants.
 *
 * `allow` is an escape hatch for a lead tier that has to read the code it writes contracts about. It is
 * an honest weakening of rule 3 rather than a fix, so the reason says which rule it costs — the config
 * entry documents its own price instead of quietly being a bypass.
 */
export declare function evaluateDelegatedReadPolicy(policy?: DelegateReadPolicy): {
    kind: 'allow' | 'ask' | 'deny';
    reason: string;
};
/** Bounded, newest-wins. Built from observed requests, because the host does not say which agent is which. */
export declare const AGENT_ROLE_LIMIT = 200;
/**
 * Remember which role an agent last made a request as.
 *
 * This is a correlation, not lineage: the plugin sees an `agent` on `agent/request` and an `agent` on
 * `tools/pre-execute`, and it assumes the same id means the same agent. That assumption is recorded
 * rather than trusted — an unobserved id resolves to 'unknown' and the observation says so, so the
 * record degrades honestly instead of inventing an attribution.
 */
export declare function rememberAgentRole(agentId: string | undefined, role: 'architect' | 'lead'): void;
export declare function roleForAgent(agentId: string | undefined): 'architect' | 'lead' | 'unknown';
/** The map is module state, so tests need a way to clear it. */
export declare function resetAgentRoles(): void;
export interface SourceReadObservation {
    track: boolean;
    role: 'architect' | 'lead' | 'unknown';
    target?: string;
    extension?: string;
    reason: string;
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
export declare function describeSourceRead(input: {
    tool?: string;
    target?: string;
    role?: 'architect' | 'lead' | 'unknown';
}): SourceReadObservation;
export declare function evaluateCodeWriteGuard(exec: any, config?: {
    askPaths?: string[];
    /** Injectable reader, so the script scan is testable without touching disk. */
    readScript?: (script: string) => string | undefined;
    /** How deep to follow script-invokes-script (default 2). */
    scriptDepth?: number;
    /** Paths a delegated worker wrote; reads of them are gated. Injectable for tests. */
    delegatedPaths?: Iterable<string>;
    /** ask | allow | deny for reading a delegated file back. Defaults to ask. */
    delegateReadPolicy?: DelegateReadPolicy;
    /** Paths the architect may author as the specification. Defaults to tests/. */
    contractPaths?: string[];
    /** allow | ask | deny for a write to a contract path. Defaults to ask. */
    contractWriteMode?: 'allow' | 'ask' | 'deny';
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
export declare function resolveVerificationPolicy(options?: PluginConfig): VerificationPolicy;
/**
 * Ask the operator to approve one model-selected verification command. Unlike the write
 * guard this is not a `tools/pre-execute` decision, because the command runs after the
 * worker responds; it is asked before dispatch so the operator sees it up front.
 * Fails closed on every error path.
 */
export declare function requestApprovalForVerification(ctx: any, exec: any, command: string): Promise<boolean>;
/**
 * Which role does this request belong to?
 *
 * The hook used to treat every agent as the architect: it repinned the provider, appended the
 * architect's system instruction, and injected `delegate_worker`. That is correct for the architect
 * and wrong for everything else — a lead configured to run locally would be redirected to the cloud
 * and told it was the architect, silently undoing the preset.
 *
 * The discriminator is an explicit operator allowlist. Inferring the role from "the resolved provider
 * is not the architect's" would be worse than useless: a profile that named its provider anything else
 * would stop being pinned, and the failure would be silent and in the direction of the cloud.
 */
/**
 * Which providers are the lead tier? `leadTier` derives the list from the LEAD profile so the provider
 * id is declared in one place; an explicit `leadProviders` list always wins.
 */
export declare function resolveLeadProviders(options?: PluginConfig): string[];
export declare function resolveAgentRole(input: {
    hostProvider?: string;
    leadProviders?: string[];
}): {
    role: 'architect' | 'lead';
    reason: string;
};
/**
 * The architect's request treatment: pin the provider, uncap the window, supply the tool and the role
 * instruction. Extracted from the hook so the behaviour is testable without a host.
 *
 * Deliberately unchanged: the instruction is only injected into a `system` string or a `messages`
 * array. A request carrying neither is left without it, because inventing a field the host may not
 * read would be a silent no-op dressed up as a fix.
 */
export declare function applyArchitectConfig(requestConfig: Record<string, any>, options?: {
    cloudProvider?: string;
    cloudModel?: string;
    localProvider?: string;
    localModel?: string;
    rerouteLocal?: boolean;
    architectInstruction?: string;
    workerTool?: any;
}): Record<string, any>;
/**
 * Apply the role. A lead request is returned unchanged: the plugin's job is to enforce boundaries, not
 * to reinvent a preset it did not write.
 */
export declare function applyAgentRole(requestConfig: Record<string, any>, role: {
    role: 'architect' | 'lead';
}, architectOptions?: Parameters<typeof applyArchitectConfig>[1]): Record<string, any>;
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
