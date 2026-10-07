import { SavingsTracker } from './savings-tracker';
import { ContextRequest } from './context';
import { VerificationPolicy } from './verification';
import type { LLMSession } from './index';
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
    /**
     * What to do when the worker writes a file the unit did not declare in `targetFiles`. `'enforce'`
     * (the default) refuses it and reports why; `'off'` restores the permissive behaviour that predates
     * the boundary.
     *
     * Enforced by default because declaring targets is what makes a later project-level failure
     * attributable: without it, a unit can sprawl and no record says which unit broke the tree.
     */
    unitScope?: 'enforce' | 'off';
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
    /**
     * The project's own check ran and failed, whatever the unit's own contract said. Absent means no
     * coherence check was configured, or it was skipped -- never "it passed".
     */
    coherenceFailed?: boolean;
}): string;
export declare function delegateWorker(params?: DelegateWorkerParams, tracker?: SavingsTracker): Promise<any>;
export declare function extractPromptText(session: LLMSession | any): string;
export declare function estimateTokenCount(text: string): number;
