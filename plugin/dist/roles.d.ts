export type SourceEgressPolicy = 'deny' | 'ask' | 'allow';
/** Blocks shorter than this are treated as quotations rather than as code being handed over. */
export declare const DEFAULT_SOURCE_EGRESS_MIN_LINES = 3;
export interface SourceEgressDetection {
    found: boolean;
    blocks: number;
    languages: string[];
}
/**
 * Find fenced source blocks in an outbound payload.
 *
 * The fence is built with `\x60` escapes rather than written literally: a literal triple backtick in
 * this file makes the file unpatchable by a confined agent, because the emission scanner truncates a
 * fenced body at the first backtick run inside it. The pattern is identical at runtime.
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
/**
 * Which providers are the lead tier? `leadTier` derives the list from the LEAD profile so the provider
 * id is declared in one place; an explicit `leadProviders` list always wins.
 *
 * Takes a structural type rather than `PluginConfig`: importing that would be a cycle, because
 * `index.ts` imports this module, and every field read here is optional anyway.
 */
export declare function resolveLeadProviders(options?: {
    leadProviders?: string[];
    leadTier?: boolean;
}): string[];
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
