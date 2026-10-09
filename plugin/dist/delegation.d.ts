import { SavingsTracker } from './savings-tracker';
import { ContextRequest } from './context';
import { VerificationPolicy } from './verification';
import type { DelegateWorkerParameter } from './contracts';
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
/**
 * Compile-time assertion that the schema's parameters are EXACTLY `DelegateWorkerParameter`.
 *
 * TWO earlier versions of this did nothing, and both failures are worth recording because they are the same
 * mistake in different clothes:
 *
 *   1. A type alias asserting the same thing. An exported type alias is never checked unless referenced, so
 *      it was decoration. Verified by mutating the schema and watching tsc pass.
 *   2. A one-directional conditional. `Record<SchemaKeys, true> extends Record<Canonical, true>` only asks
 *      whether the canonical keys are all present; structural assignability permits EXTRA properties, so a
 *      schema key that is not canonical was still accepted. Verified by mutation again.
 *
 * This version requires set EQUALITY: both directions, expressed as one condition so there is no ordering to
 * get wrong. It is a value, so it is always checked, and both mutations now fail the build.
 */
type SchemaKeys = Extract<keyof (typeof DELEGATE_WORKER_OPENAI_SCHEMA)['function']['parameters']['properties'], string>;
type SchemaMatchesCanonicalParameters = [SchemaKeys] extends [DelegateWorkerParameter] ? [DelegateWorkerParameter] extends [SchemaKeys] ? true : never : never;
export declare const DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER: SchemaMatchesCanonicalParameters;
/**
 * How many times a contract should run, from a caller-supplied value that cannot be trusted.
 *
 * **The default is 3, and that is a deliberate break with the previous behaviour.** It used to be 1,
 * chosen to guarantee no caller saw a change. That was backwards for an integrity boundary: it left a
 * non-deterministic oracle unprotected unless the caller happened to KNOW the contract was flaky -- and
 * the caller who does not know is exactly the one whose race condition gets promoted by a lucky pass.
 * A guardrail that has to be opted into is not a guardrail.
 *
 * The cost is real and worth naming: every delegated verification now runs three subprocesses instead of
 * one. A deterministic suite pays that to prove its own stability, which is not wasted -- three agreeing
 * runs are strictly more evidence than one. A caller who has measured their suite and wants the speed
 * back passes `verificationRepeats: 1` explicitly, which is the honest way round: the fast path is the
 * one that requires a decision.
 *
 * The ceiling is not cosmetic. Each repeat is a real subprocess with the host process's authority, so an
 * unbounded value would be a denial-of-service lever through a tool argument.
 */
export declare const DEFAULT_VERIFICATION_REPEATS = 3;
export declare const MAX_VERIFICATION_REPEATS = 20;
export declare function resolveVerificationRepeats(value: unknown): number;
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
    /**
     * How many times to run `runVerification`. Defaults to 3: a contract that runs three times and agrees
     * with itself has proved its own stability, and one that disagrees produces `UNIT_FLAKY` instead of a
     * pass. Raise it for a genuinely rare race; pass 1 only for a suite you have measured as deterministic
     * and whose three-fold cost you are deliberately declining.
     */
    verificationRepeats?: number;
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
    /**
     * Whether the previous failure's locations are offered to this attempt as context. `'auto'` (the
     * default) adds a window around each file the last failure named, once; `'off'` disables it.
     *
     * Bounded three ways: it is consumed by a single attempt, it never overrides a file the caller already
     * declared, and it is dropped entirely if adding it would push the injection over its byte budget.
     */
    retryContext?: 'auto' | 'off';
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
    /**
     * The contract disagreed with itself across repeated runs. A statement about the ORACLE, not the
     * code, and it is checked before the coherence result for the same reason `verificationGate` is:
     * there is no trustworthy unit verdict to compare the project against.
     */
    flaky?: boolean;
}): string;
export declare function delegateWorker(params?: DelegateWorkerParams, tracker?: SavingsTracker): Promise<any>;
export declare function extractPromptText(session: LLMSession | any): string;
export declare function estimateTokenCount(text: string): number;
export {};
