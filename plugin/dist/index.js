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
exports.DELEGATE_WORKER_SCHEMA = exports.DELEGATE_WORKER_OPENAI_SCHEMA = exports.name = exports.using = exports.inject = exports.runSandboxVerification = exports.runInProcessFallback = exports.redactVerificationOutput = exports.parseTestOutput = exports.evaluateVerificationPolicy = exports.describeFailures = exports.commandProgram = exports.DEFAULT_VERIFICATION_POLICY = exports.sha256File = exports.saveDelegatedRegistry = exports.resolveDelegatedRegistryPath = exports.resolveContractFiles = exports.rememberDelegated = exports.pruneDelegatedRecords = exports.parseDelegatedRegistry = exports.mergeDelegatedRecords = exports.loadDelegatedRegistry = exports.contractViolations = exports.contractFileHashes = exports.resolveContextFiles = exports.DEFAULT_CONTEXT_MAX_BYTES = exports.roleForAgent = exports.resolveLeadProviders = exports.resolveAgentRole = exports.resetAgentRoles = exports.rememberAgentRole = exports.evaluateSourceEgress = exports.detectSourceEgress = exports.describeSourceRead = exports.applyArchitectConfig = exports.applyAgentRole = exports.DEFAULT_SOURCE_EGRESS_MIN_LINES = exports.AGENT_ROLE_LIMIT = exports.hasCommandWriteSignal = exports.hasCommandDeleteSignal = exports.evaluateDelegatedReadPolicy = exports.evaluateCodeWriteGuard = exports.DELETE_PRIMITIVES = exports.extractAndEmitFiles = exports.evaluateEmissionPath = exports.isPathWithin = exports.trace = exports.resolveDataDir = exports.SavingsTracker = exports.PROFILES = void 0;
exports.LocalRouter = exports.MIN_SEARCH_CHARS = exports.DEFAULT_LOCAL_ENDPOINT = void 0;
exports.scanDLP = scanDLP;
exports.resolveChatCompletionsUrl = resolveChatCompletionsUrl;
exports.parseSearchReplaceBlocks = parseSearchReplaceBlocks;
exports.applySearchReplaceBlocks = applySearchReplaceBlocks;
exports.resolveDelegateStatus = resolveDelegateStatus;
exports.delegateWorker = delegateWorker;
exports.extractPromptText = extractPromptText;
exports.estimateTokenCount = estimateTokenCount;
exports.requestApprovalForWrite = requestApprovalForWrite;
exports.resolveVerificationPolicy = resolveVerificationPolicy;
exports.requestApprovalForVerification = requestApprovalForVerification;
exports.apply = apply;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const savings_tracker_1 = require("./savings-tracker");
Object.defineProperty(exports, "SavingsTracker", { enumerable: true, get: function () { return savings_tracker_1.SavingsTracker; } });
const profiles_1 = require("./profiles");
Object.defineProperty(exports, "PROFILES", { enumerable: true, get: function () { return profiles_1.PROFILES; } });
const local_classifier_1 = require("./local-classifier");
const logging_1 = require("./logging");
const paths_1 = require("./paths");
const emission_1 = require("./emission");
const verification_1 = require("./verification");
const context_1 = require("./context");
const guard_1 = require("./guard");
const roles_1 = require("./roles");
const contracts_1 = require("./contracts");
var logging_2 = require("./logging");
Object.defineProperty(exports, "resolveDataDir", { enumerable: true, get: function () { return logging_2.resolveDataDir; } });
Object.defineProperty(exports, "trace", { enumerable: true, get: function () { return logging_2.trace; } });
var paths_2 = require("./paths");
Object.defineProperty(exports, "isPathWithin", { enumerable: true, get: function () { return paths_2.isPathWithin; } });
var emission_2 = require("./emission");
Object.defineProperty(exports, "evaluateEmissionPath", { enumerable: true, get: function () { return emission_2.evaluateEmissionPath; } });
Object.defineProperty(exports, "extractAndEmitFiles", { enumerable: true, get: function () { return emission_2.extractAndEmitFiles; } });
var guard_2 = require("./guard");
Object.defineProperty(exports, "DELETE_PRIMITIVES", { enumerable: true, get: function () { return guard_2.DELETE_PRIMITIVES; } });
Object.defineProperty(exports, "evaluateCodeWriteGuard", { enumerable: true, get: function () { return guard_2.evaluateCodeWriteGuard; } });
Object.defineProperty(exports, "evaluateDelegatedReadPolicy", { enumerable: true, get: function () { return guard_2.evaluateDelegatedReadPolicy; } });
Object.defineProperty(exports, "hasCommandDeleteSignal", { enumerable: true, get: function () { return guard_2.hasCommandDeleteSignal; } });
Object.defineProperty(exports, "hasCommandWriteSignal", { enumerable: true, get: function () { return guard_2.hasCommandWriteSignal; } });
var roles_2 = require("./roles");
Object.defineProperty(exports, "AGENT_ROLE_LIMIT", { enumerable: true, get: function () { return roles_2.AGENT_ROLE_LIMIT; } });
Object.defineProperty(exports, "DEFAULT_SOURCE_EGRESS_MIN_LINES", { enumerable: true, get: function () { return roles_2.DEFAULT_SOURCE_EGRESS_MIN_LINES; } });
Object.defineProperty(exports, "applyAgentRole", { enumerable: true, get: function () { return roles_2.applyAgentRole; } });
Object.defineProperty(exports, "applyArchitectConfig", { enumerable: true, get: function () { return roles_2.applyArchitectConfig; } });
Object.defineProperty(exports, "describeSourceRead", { enumerable: true, get: function () { return roles_2.describeSourceRead; } });
Object.defineProperty(exports, "detectSourceEgress", { enumerable: true, get: function () { return roles_2.detectSourceEgress; } });
Object.defineProperty(exports, "evaluateSourceEgress", { enumerable: true, get: function () { return roles_2.evaluateSourceEgress; } });
Object.defineProperty(exports, "rememberAgentRole", { enumerable: true, get: function () { return roles_2.rememberAgentRole; } });
Object.defineProperty(exports, "resetAgentRoles", { enumerable: true, get: function () { return roles_2.resetAgentRoles; } });
Object.defineProperty(exports, "resolveAgentRole", { enumerable: true, get: function () { return roles_2.resolveAgentRole; } });
Object.defineProperty(exports, "resolveLeadProviders", { enumerable: true, get: function () { return roles_2.resolveLeadProviders; } });
Object.defineProperty(exports, "roleForAgent", { enumerable: true, get: function () { return roles_2.roleForAgent; } });
var context_2 = require("./context");
Object.defineProperty(exports, "DEFAULT_CONTEXT_MAX_BYTES", { enumerable: true, get: function () { return context_2.DEFAULT_CONTEXT_MAX_BYTES; } });
Object.defineProperty(exports, "resolveContextFiles", { enumerable: true, get: function () { return context_2.resolveContextFiles; } });
var contracts_2 = require("./contracts");
Object.defineProperty(exports, "contractFileHashes", { enumerable: true, get: function () { return contracts_2.contractFileHashes; } });
Object.defineProperty(exports, "contractViolations", { enumerable: true, get: function () { return contracts_2.contractViolations; } });
Object.defineProperty(exports, "loadDelegatedRegistry", { enumerable: true, get: function () { return contracts_2.loadDelegatedRegistry; } });
Object.defineProperty(exports, "mergeDelegatedRecords", { enumerable: true, get: function () { return contracts_2.mergeDelegatedRecords; } });
Object.defineProperty(exports, "parseDelegatedRegistry", { enumerable: true, get: function () { return contracts_2.parseDelegatedRegistry; } });
Object.defineProperty(exports, "pruneDelegatedRecords", { enumerable: true, get: function () { return contracts_2.pruneDelegatedRecords; } });
Object.defineProperty(exports, "rememberDelegated", { enumerable: true, get: function () { return contracts_2.rememberDelegated; } });
Object.defineProperty(exports, "resolveContractFiles", { enumerable: true, get: function () { return contracts_2.resolveContractFiles; } });
Object.defineProperty(exports, "resolveDelegatedRegistryPath", { enumerable: true, get: function () { return contracts_2.resolveDelegatedRegistryPath; } });
Object.defineProperty(exports, "saveDelegatedRegistry", { enumerable: true, get: function () { return contracts_2.saveDelegatedRegistry; } });
Object.defineProperty(exports, "sha256File", { enumerable: true, get: function () { return contracts_2.sha256File; } });
var verification_2 = require("./verification");
Object.defineProperty(exports, "DEFAULT_VERIFICATION_POLICY", { enumerable: true, get: function () { return verification_2.DEFAULT_VERIFICATION_POLICY; } });
Object.defineProperty(exports, "commandProgram", { enumerable: true, get: function () { return verification_2.commandProgram; } });
Object.defineProperty(exports, "describeFailures", { enumerable: true, get: function () { return verification_2.describeFailures; } });
Object.defineProperty(exports, "evaluateVerificationPolicy", { enumerable: true, get: function () { return verification_2.evaluateVerificationPolicy; } });
Object.defineProperty(exports, "parseTestOutput", { enumerable: true, get: function () { return verification_2.parseTestOutput; } });
Object.defineProperty(exports, "redactVerificationOutput", { enumerable: true, get: function () { return verification_2.redactVerificationOutput; } });
Object.defineProperty(exports, "runInProcessFallback", { enumerable: true, get: function () { return verification_2.runInProcessFallback; } });
Object.defineProperty(exports, "runSandboxVerification", { enumerable: true, get: function () { return verification_2.runSandboxVerification; } });
exports.inject = ['tools'];
exports.using = ['tools'];
/**
 * Resolve the Session Workspace root WITHOUT declaring a hard inject dependency.
 *
 * ctx.workspace does not exist in Cordis (reading it throws), and dsh-workspace
 * exposes a REGISTRY (ctx.workspaceRegistry), not a per-Session cwd. So probe the
 * known shapes in order and report WHERE the answer came from: silently falling
 * back to process.cwd() writes files into the server's own directory instead of
 * the Session workspace, which is far worse than failing loudly.
 */
function resolveWorkspaceDir(ctx) {
    for (const key of ['DSH_WORKSPACE_ROOT', 'DSH_WORKSPACE', 'WORKSPACE_ROOT']) {
        const candidate = process.env[key];
        if (typeof candidate === 'string' && candidate && fs.existsSync(candidate)) {
            return { dir: candidate, source: `env:${key}` };
        }
    }
    try {
        for (const serviceName of ['workspace', 'workspaceRegistry', 'workspaceFiles', 'session']) {
            const service = typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined;
            if (!service)
                continue;
            for (const prop of ['dir', 'cwd', 'root', 'path', 'workspaceDir']) {
                const value = service[prop];
                if (typeof value === 'string' && value && fs.existsSync(value)) {
                    return { dir: value, source: `ctx.get('${serviceName}').${prop}` };
                }
            }
        }
    }
    catch {
        // service unavailable in this context - fall through to the cwd fallback
    }
    return { dir: process.cwd(), source: 'process.cwd() FALLBACK (not a Session workspace)' };
}
exports.name = 'dsh-plugin-coding-delegate';
// resolveDataDir and trace moved to ./logging.ts and are imported above. The re-export beside the other
// module re-exports keeps `resolveDataDir` on the public surface, where callers already depend on it.
exports.DELEGATE_WORKER_OPENAI_SCHEMA = {
    type: 'function',
    function: {
        name: 'delegate_worker',
        description: 'Dispatches a discrete implementation, testing, or code-generation task to the configured local execution worker -- any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp) -- with an isolated context window. The worker has no repository read: declare contextFiles for the code it must see, since it cannot discover anything itself.',
        parameters: {
            type: 'object',
            properties: {
                taskName: {
                    type: 'string',
                    description: 'A short descriptive identifier for the subtask',
                },
                instruction: {
                    type: 'string',
                    description: 'The complete technical prompt and specifications for the local worker',
                },
                targetFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional file paths to target or modify',
                },
                runVerification: {
                    type: 'string',
                    description: 'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
                },
                contractFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Paths to the tests that constitute this unit contract. They are hashed before the worker runs, the worker is forbidden to write them, and they are re-hashed afterwards: any change voids the verdict. The architect owns these files.',
                },
                contextFiles: {
                    type: 'array',
                    description: 'Existing files the worker needs to see, as { path, startLine?, endLine? }. The plugin reads them into the worker prompt; you receive a record of what was injected and never the contents. Paths outside the workspace are refused, and context carrying a credential is refused rather than transmitted.',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            startLine: { type: 'number' },
                            endLine: { type: 'number' },
                        },
                        required: ['path'],
                    },
                },
                workspaceDir: {
                    type: 'string',
                    description: 'Absolute path of the directory the worker may write into. Defaults to the session workspace; destinations outside it are refused.',
                },
            },
            required: ['taskName', 'instruction'],
        },
    },
};
exports.DELEGATE_WORKER_SCHEMA = exports.DELEGATE_WORKER_OPENAI_SCHEMA;
function scanDLP(text, options = {}) {
    if (!text)
        return { hasSensitiveData: false, violations: [], highConfidence: false };
    const violations = [];
    // Shared with the classifier: an enforcing gate must not use a weaker rule set
    // than the classifier that reports alongside it (it previously did, which let
    // `password: "..."` through to the cloud).
    for (const { name, pattern } of local_classifier_1.SECRET_PATTERN_RULES) {
        if (pattern.test(text)) {
            violations.push(name);
        }
    }
    // A recognised shape or keyword-assigned value is high confidence.
    const highConfidence = violations.length > 0;
    // The entropy backstop. Deliberately medium confidence: a high-entropy token may
    // equally be a digest or a base64 payload, so it must not hard-block a session.
    if (options.entropyCheck !== false) {
        const tokens = (0, local_classifier_1.findHighEntropyTokens)(text, {
            minBitsPerChar: options.entropyMinBitsPerChar,
            minLength: options.entropyMinLength,
        });
        if (tokens.length > 0)
            violations.push('High-entropy string');
    }
    return { hasSensitiveData: violations.length > 0, violations, highConfidence };
}
/** Where the local worker is assumed to live when nothing else is configured. */
exports.DEFAULT_LOCAL_ENDPOINT = 'http://127.0.0.1:1234/v1';
/**
 * Accept either a base URL or a full chat-completions URL and return the full one, so
 * `localEndpoint: 'http://127.0.0.1:11434/v1'` (Ollama, vLLM, llama.cpp, …) works exactly as
 * written without the operator having to know this plugin appends the path.
 */
function resolveChatCompletionsUrl(base) {
    const trimmed = String(base || '').trim().replace(/\/+$/, '');
    if (!trimmed)
        return `${exports.DEFAULT_LOCAL_ENDPOINT}/chat/completions`;
    return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}
/**
 * A one- or two-character search is unique by accident rather than by intent, so it is refused even
 * when the exactly-once rule would allow it. The property that matters is exactness, not cleverness.
 */
exports.MIN_SEARCH_CHARS = 8;
const SEARCH_MARKER = '<<<<<<< SEARCH';
const REPLACE_MARKER = '>>>>>>> REPLACE';
const DIVIDER_MARKER = '=======';
/**
 * Recognise a search/replace body. The fenced header is shared with whole-file emission, so the body
 * decides the mode and the worker does not have to know which of the two it is producing.
 *
 * Returns null when there is no delta here, which tells the caller to treat the body as a whole file.
 * A body that *starts* a search/replace block but never finishes it returns an empty list instead --
 * never null -- so a malformed patch cannot fall through and be written over a real file.
 */
function parseSearchReplaceBlocks(body) {
    if (typeof body !== 'string' || !body.includes(SEARCH_MARKER))
        return null;
    const blocks = [];
    let search = null;
    let replace = null;
    let state = 'idle';
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === SEARCH_MARKER) {
            search = [];
            replace = [];
            state = 'search';
            continue;
        }
        if (state === 'search' && trimmed === DIVIDER_MARKER) {
            state = 'replace';
            continue;
        }
        if (trimmed === REPLACE_MARKER) {
            if (search && replace)
                blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
            search = null;
            replace = null;
            state = 'idle';
            continue;
        }
        if (state === 'search' && search)
            search.push(line);
        else if (state === 'replace' && replace)
            replace.push(line);
    }
    return blocks;
}
/**
 * Apply every block, or none. A partially applied change is worse than no change: it leaves the tree
 * in a state that no contract was written against.
 *
 * Everything is normalised to LF for matching and the file's own ending is restored at the end.
 * Nothing else is normalised -- indentation is bytes -- because a near miss must fail loudly rather
 * than be massaged into a match. Fuzzy patching is not a tuning choice here; it is the mechanism by
 * which a wrong edit lands silently.
 */
function applySearchReplaceBlocks(content, blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return { ok: false, reason: 'the patch contained no complete search/replace block' };
    }
    const usesCrlf = content.includes('\r\n');
    let work = content.split('\r\n').join('\n');
    for (const block of blocks) {
        const search = String(block?.search ?? '').split('\r\n').join('\n');
        const replace = String(block?.replace ?? '').split('\r\n').join('\n');
        if (!search.trim()) {
            return { ok: false, reason: 'a search block was empty' };
        }
        if (search.trim().length < exports.MIN_SEARCH_CHARS) {
            return {
                ok: false,
                reason: `a search block was too short to be unambiguous (${search.trim().length} characters, ` +
                    `minimum ${exports.MIN_SEARCH_CHARS})`,
            };
        }
        const occurrences = work.split(search).length - 1;
        if (occurrences === 0) {
            return {
                ok: false,
                reason: `no exact match for a search block (${search.trim().slice(0, 60)})`,
            };
        }
        if (occurrences > 1) {
            return {
                ok: false,
                reason: `a search block matched more than once (${occurrences} times), so the edit is ambiguous`,
            };
        }
        work = work.replace(search, () => replace);
    }
    return { ok: true, content: usesCrlf ? work.split('\n').join('\r\n') : work };
}
/**
 * Status precedence, as a pure function so the ordering is testable without a server. Tampering
 * outranks everything: a modified contract voids the run even when verification passed, because
 * what passed was no longer the contract.
 */
function resolveDelegateStatus(input) {
    if (input.contractViolations.length > 0)
        return 'CONTRACT_MODIFIED';
    if (input.verificationGate)
        return 'VERIFICATION_NOT_APPROVED';
    if (input.unverified)
        return 'UNVERIFIED';
    return input.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED';
}
async function delegateWorker(params = {}, tracker) {
    const endpoint = resolveChatCompletionsUrl(params.endpoint || profiles_1.PROFILES.WORKER.endpoint || exports.DEFAULT_LOCAL_ENDPOINT);
    const model = params.model || profiles_1.PROFILES.WORKER.model;
    const fileInstruction = 'To change part of an existing file, emit a patch block instead of the whole file:\n' +
        '```patch file="src/thing.ts"\n<<<<<<< SEARCH\n<the exact existing lines>\n=======\n<the replacement lines>\n>>>>>>> REPLACE\n```\n' +
        'The SEARCH text must match the file exactly and occur exactly once, and there is no fuzzy matching.\n' +
        'To create a file, or replace one wholesale, wrap it in a code block with the target file path in the header or first line, e.g. ```typescript file="src/math-helper.ts"\n...code...\n``` or // FILE: tests/math-helper.test.ts';
    const systemPrompt = params.systemPrompt || `You are a fast, accurate local coding worker executing a discrete task. ${fileInstruction}`;
    const taskText = params.instruction || params.taskPrompt || params.prompt || '';
    // Resolved before the worker runs: the contract hashes have to describe the tree as it was handed
    // over, and context has to be read while the architect is still blind to it.
    const workspaceBase = params.workspaceDir || process.cwd();
    const context = (0, context_1.resolveContextFiles)(params.contextFiles, workspaceBase);
    if (params.contextFiles && params.contextFiles.length > 0) {
        if (context.errors.length > 0) {
            return {
                success: false,
                status: 'CONTEXT_REFUSED',
                message: `Context injection refused:\n${context.errors.map((e) => `  - ${e}`).join('\n')}`,
                contextErrors: context.errors,
                resolvedWorkspace: workspaceBase,
                filesWritten: [],
                testResults: { passed: 0, failed: 0, output: 'The worker was not called.' },
                tokens: { prompt: 0, completion: 0 },
            };
        }
        // The declared context is about to travel to `endpoint`, which may be a vLLM port on another
        // machine rather than this one. A "local" endpoint that is remote is a cloud, so a credential in
        // the context is refused rather than transmitted: rule 1 does not care which port it is.
        const contextDlp = scanDLP(context.text);
        if (contextDlp.hasSensitiveData && contextDlp.highConfidence) {
            const refusal = `declared context carries a credential (${contextDlp.violations.join(', ')}), so it will not ` +
                `be sent to the worker endpoint. Narrow the range to exclude it, or remove it from the file.`;
            return {
                success: false,
                status: 'CONTEXT_REFUSED',
                message: `Context injection refused:\n  - ${refusal}`,
                contextErrors: [refusal],
                resolvedWorkspace: workspaceBase,
                filesWritten: [],
                testResults: { passed: 0, failed: 0, output: 'The worker was not called.' },
                tokens: { prompt: 0, completion: 0 },
            };
        }
    }
    let fileContextText = '';
    if (Array.isArray(params.targetFiles)) {
        fileContextText = `Target Files:\n${params.targetFiles.join('\n')}`;
    }
    else if (typeof params.targetFiles === 'string') {
        fileContextText = `Target Files:\n${params.targetFiles}`;
    }
    else if (typeof params.fileContext === 'string') {
        fileContextText = params.fileContext;
    }
    // Appended rather than chosen by an else-if. A unit normally has both targetFiles and context, and
    // the earlier shape meant a declared context was silently dropped whenever targetFiles was present.
    if (context.text) {
        fileContextText += `${fileContextText ? '\n\n' : ''}${context.text}`;
    }
    if (params.runVerification) {
        fileContextText += `\nVerification Command:\n${params.runVerification}`;
    }
    const combinedPrompt = fileContextText
        ? `Task: ${params.taskName || 'Subtask'}\n${taskText}\n\n${fileContextText}`
        : `Task: ${params.taskName || 'Subtask'}\n${taskText}`;
    const turnId = params.turnId ?? Math.floor(Math.random() * 1000000);
    const timeoutMs = params.timeoutMs ?? 300000;
    const contractPaths = (0, contracts_1.resolveContractFiles)(params.contractFiles, workspaceBase);
    const contractBefore = (0, contracts_1.contractFileHashes)(contractPaths);
    const requestStartedAt = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: combinedPrompt },
                ],
                temperature: profiles_1.PROFILES.WORKER.temperature ?? 0.2,
                max_tokens: profiles_1.PROFILES.WORKER.max_tokens ?? 2048,
                stop: profiles_1.PROFILES.WORKER.stop ?? ['<|im_end|>', '<|endoftext|>'],
                enable_thinking: profiles_1.PROFILES.WORKER.enable_thinking ?? false,
                reasoning_effort: profiles_1.PROFILES.WORKER.reasoning_effort ?? 'none',
            }),
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
        if (!response.ok) {
            const errText = await response.text();
            return {
                success: false,
                status: 'ERROR',
                message: `LM Studio returned HTTP ${response.status}: ${errText}`,
                filesWritten: [],
                testResults: { passed: 0, failed: 0, output: 'Request failed.' },
                tokens: { prompt: 0, completion: 0 },
            };
        }
        const elapsedMs = Date.now() - requestStartedAt;
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const promptTokens = data.usage?.prompt_tokens ?? estimateTokenCount(combinedPrompt);
        const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(content);
        const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);
        if (tracker) {
            tracker.recordUsage({
                turn: turnId,
                route: 'WORKER_LOCAL',
                model,
                reason: `SUBAGENT_DELEGATION (${params.taskName || 'subtask'})`,
                promptTokens,
                completionTokens,
                totalTokens,
                elapsedMs,
            });
        }
        if (!fs.existsSync(workspaceBase)) {
            try {
                fs.mkdirSync(workspaceBase, { recursive: true });
            }
            catch (err) {
                return {
                    success: false,
                    status: 'ERROR',
                    message: `Resolved workspace directory '${workspaceBase}' does not exist and could not be created: ${err?.message || String(err)}`,
                    resolvedWorkspace: workspaceBase,
                    filesWritten: [],
                    testResults: { passed: 0, failed: 0, output: 'No files written.' },
                    tokens: { prompt: promptTokens, completion: completionTokens },
                };
            }
        }
        const emission = (0, emission_1.extractAndEmitFiles)(content, params.targetFiles, workspaceBase, params.emitAllowlist ?? [], contractPaths);
        const filesWritten = emission.filesWritten;
        // Remember what we wrote on the architect's behalf, so reading it back can be gated -- distinguishing
        // files the worker created, which the architect never saw, from files it patched, which it did.
        const createdPaths = filesWritten.filter((f) => f.mode !== 'patch').map((f) => f.path);
        const patchedPaths = filesWritten.filter((f) => f.mode === 'patch').map((f) => f.path);
        if (createdPaths.length > 0)
            (0, contracts_1.rememberDelegated)(createdPaths, 'created');
        if (patchedPaths.length > 0)
            (0, contracts_1.rememberDelegated)(patchedPaths, 'patched');
        let testResults = undefined;
        let verificationGate = undefined;
        if (params.runVerification) {
            const policy = params.verificationPolicy ?? verification_1.DEFAULT_VERIFICATION_POLICY;
            const decision = (0, verification_1.evaluateVerificationPolicy)(params.runVerification, policy);
            let permitted = decision.kind === 'allow';
            if (decision.kind === 'ask') {
                // No approver means no consent. A missing approval seam must never degrade to a
                // silent yes for a command that runs with the host process's authority.
                permitted = params.verificationApproval
                    ? await params.verificationApproval(params.runVerification)
                    : false;
            }
            if (permitted) {
                testResults = (0, verification_1.runSandboxVerification)(params.runVerification, workspaceBase, {
                    redact: params.redactVerification ?? process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION !== '1',
                    rawLogPath: path.join((0, logging_1.resolveDataDir)(), 'last-verification.log'),
                    allowInProcessFallback: policy.allowInProcessFallback,
                });
            }
            else {
                verificationGate =
                    decision.kind === 'deny'
                        ? decision.reason
                        : `approval was not granted (${decision.reason})`;
            }
        }
        // A result is a verdict on a contract, and the contract is the verification command. Code
        // produced without one has an unchecked contract: reporting SUCCESS there would be the same
        // false green as counting unrecognised test output as a pass, which this plugin has already
        // been caught doing twice.
        const wroteFiles = filesWritten.length > 0 && emission.errors.length === 0;
        const unverified = !verificationGate && !params.runVerification && wroteFiles;
        // Re-hash once the worker has finished and verification has run. A violation voids the verdict
        // regardless of what the tests reported, because the tests are no longer the contract.
        const contractAfter = (0, contracts_1.contractFileHashes)(contractPaths);
        const contractViolationsFound = (0, contracts_1.contractViolations)(contractBefore, contractAfter);
        const isSuccess = contractViolationsFound.length === 0 &&
            !verificationGate &&
            !unverified &&
            (!testResults || testResults.failed === 0) &&
            emission.errors.length === 0;
        let summaryText = '';
        if (filesWritten.length > 0) {
            summaryText =
                `Task '${params.taskName || 'Subtask'}' completed. Wrote ${filesWritten.length} file(s):\n` +
                    filesWritten
                        .map((f) => `  - ${f.path} (${f.lines} lines, ${f.bytes} bytes${f.mode === 'patch' ? `, patched in place with ${f.hunks} hunk(s)` : ''})`)
                        .join('\n');
        }
        else {
            summaryText = `Task '${params.taskName || 'Subtask'}' completed. Worker returned ${content.split('\n').length} line(s) of output.`;
        }
        summaryText += `\nWorkspace: ${workspaceBase}${params.workspaceSource ? ` (resolved via ${params.workspaceSource})` : ''}`;
        if (params.workspaceSource && /FALLBACK/.test(params.workspaceSource) && filesWritten.length > 0) {
            summaryText += `\nWARNING: the Session workspace could not be resolved, so files were written relative to ${workspaceBase}. Pass absolute paths in targetFiles, or set DSH_WORKSPACE_ROOT, to be certain of the destination.`;
        }
        if (emission.errors.length > 0) {
            summaryText += `\nFILE WRITE ERRORS:\n${emission.errors.map((e) => `  - ${e}`).join('\n')}`;
        }
        if (verificationGate) {
            summaryText += `\nVerification was NOT run: ${verificationGate}`;
        }
        if (unverified) {
            summaryText +=
                `\nUNVERIFIED: no verification command was supplied, so the contract was never checked. ` +
                    `Files were written; nothing was proven.`;
        }
        if (testResults) {
            summaryText += `\nVerification Results: Passed ${testResults.passed}, Failed ${testResults.failed}.`;
            if (testResults.errorSummary) {
                summaryText += `\nFailures: ${testResults.errorSummary}`;
            }
        }
        if (contractPaths.length > 0) {
            summaryText +=
                contractViolationsFound.length > 0
                    ? `\nCONTRACT MODIFIED, verdict void: ${contractViolationsFound.join('; ')}.`
                    : `\nContract: ${contractPaths.length} declared file(s), unchanged.`;
        }
        return {
            success: isSuccess,
            filesWritten: filesWritten.map((f) => f.path),
            filesWrittenRelative: filesWritten.map((f) => f.relativeName || f.path),
            resolvedWorkspace: workspaceBase,
            workspaceSource: params.workspaceSource,
            testResults: testResults ||
                {
                    passed: 0,
                    failed: 0,
                    output: verificationGate
                        ? `Verification not run: ${verificationGate}`
                        : unverified
                            ? 'No verification command was supplied; the contract is unchecked.'
                            : 'No verification requested.',
                },
            ...(verificationGate ? { verificationSkipped: verificationGate } : {}),
            // Metadata only. The architect learns what the worker was shown, never what it says.
            ...(context.injected.length > 0
                ? {
                    contextInjected: context.injected.map((c) => ({
                        path: c.path,
                        relativeName: c.relativeName,
                        lineRange: c.lineRange,
                        lines: c.lines,
                        bytes: c.bytes,
                        sha256: c.sha256,
                    })),
                }
                : {}),
            // Metadata only. The architect learns what the contract did, never what the code says.
            ...(contractPaths.length > 0
                ? {
                    contractFiles: contractPaths.map((p) => ({
                        path: p,
                        relativeName: path.relative(workspaceBase, p) || p,
                        sha256: contractAfter[(0, paths_1.canonicalisePath)(p)] ?? null,
                        unchanged: contractBefore[(0, paths_1.canonicalisePath)(p)] === contractAfter[(0, paths_1.canonicalisePath)(p)],
                    })),
                    contractViolations: contractViolationsFound,
                }
                : {}),
            tokens: {
                prompt: promptTokens,
                completion: completionTokens,
            },
            summary: summaryText,
            status: resolveDelegateStatus({
                verificationGate,
                unverified,
                contractViolations: contractViolationsFound,
                isSuccess,
            }),
            taskName: params.taskName || 'Subtask',
            tokensUsed: totalTokens,
        };
    }
    catch (err) {
        const errMsg = err?.message || String(err);
        return {
            success: false,
            status: 'ERROR',
            message: `LM Studio at 127.0.0.1:1234 was unreachable or failed: ${errMsg}`,
            filesWritten: [],
            testResults: { passed: 0, failed: 0, output: errMsg },
            tokens: { prompt: 0, completion: 0 },
        };
    }
}
function extractPromptText(session) {
    if (!session)
        return '';
    const messages = session.messages ||
        session.options?.messages ||
        session.requestOptions?.messages ||
        session.session?.messages;
    if (Array.isArray(messages) && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.role === 'user') {
                if (typeof msg.content === 'string') {
                    const text = msg.content.trim();
                    if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
                        continue;
                    }
                    if (text.length > 0)
                        return text;
                }
                if (Array.isArray(msg.content)) {
                    const textPart = msg.content.find((p) => p.type === 'text');
                    if (textPart?.text?.trim()) {
                        const text = textPart.text.trim();
                        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
                            return text;
                        }
                    }
                }
            }
        }
        for (let i = messages.length - 1; i >= 0; i--) {
            const content = messages[i]?.content;
            if (typeof content === 'string') {
                const text = content.trim();
                if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
                    continue;
                }
                if (text.length > 0)
                    return text;
            }
        }
    }
    try {
        const inbox = session.inbox || session.session?.inbox;
        if (inbox && Array.isArray(inbox['next-turn']) && inbox['next-turn'].length > 0) {
            const item = inbox['next-turn'][inbox['next-turn'].length - 1];
            if (typeof item?.prompt === 'string') {
                const text = item.prompt.trim();
                if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
                    if (text.length > 0)
                        return text;
                }
            }
            if (typeof item?.content === 'string') {
                const text = item.content.trim();
                if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
                    if (text.length > 0)
                        return text;
                }
            }
        }
    }
    catch (e) { }
    if (typeof session.input === 'string') {
        const text = session.input.trim();
        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
            if (text.length > 0)
                return text;
        }
    }
    if (typeof session.prompt === 'string' && session.prompt.trim().length > 0) {
        const clean = session.prompt
            .replace(/^\[model changed:.*?\]\s*/i, '')
            .replace(/^Current runtime context\..*?\n\n/is, '')
            .trim();
        if (clean.length > 0 && !clean.startsWith('[model changed:') && !clean.startsWith('Current runtime context.')) {
            return clean;
        }
    }
    return '';
}
function estimateTokenCount(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / 4);
}
class LocalRouter {
    config;
    constructor(config = {}) {
        const contextThreshold = config.contextThreshold ??
            config.contextTokenThreshold ??
            parseInt(process.env.CONTEXT_TOKEN_THRESHOLD || '30000', 10);
        this.config = {
            localProvider: config.localProvider || profiles_1.PROFILES.WORKER.provider,
            cloudProvider: config.cloudProvider || profiles_1.PROFILES.ARCHITECT.provider,
            localModel: config.localModel || profiles_1.PROFILES.WORKER.model,
            cloudModel: config.cloudModel || profiles_1.PROFILES.ARCHITECT.model,
            contextThreshold,
            timeoutMs: config.timeoutMs || 2000,
            enforceDLP: config.enforceDLP ?? true,
        };
    }
    getConfig() {
        return this.config;
    }
    async predictRoute(promptText) {
        const dlpResult = scanDLP(promptText);
        if (dlpResult.hasSensitiveData) {
            return {
                provider: this.config.localProvider,
                model: this.config.localModel,
                route: 'WORKER_LOCAL',
                gate: 'Gate 1 (Local Classifier - DLP Firewall)',
                rationale: `Sensitive credentials detected by DLP firewall (${dlpResult.violations.join(', ')}). Routing payload locally to protect privacy.`,
                scores: { is_private: 0.99, complexity: 1, target: 'LOCAL_5090' },
                latencyMs: 0,
                dlpViolations: dlpResult.violations,
            };
        }
        const tokens = estimateTokenCount(promptText);
        if (tokens > this.config.contextThreshold) {
            return {
                provider: this.config.cloudProvider,
                model: this.config.cloudModel,
                route: 'ARCHITECT_CLOUD',
                gate: 'Gate 0 (Guard - Token Threshold)',
                rationale: `Prompt token count (${tokens}) exceeds local context threshold (${this.config.contextThreshold}). Routing directly to Cloud.`,
                scores: { is_private: 0, complexity: 5, target: 'CLOUD_DEEPSEEK' },
                latencyMs: 0,
            };
        }
        // Routing is decided in-process. There is no decision daemon, no HTTP hop and
        // no timeout to pay on every routing call, and nothing to fail over to: the
        // classifier always returns a decision.
        const decision = (0, local_classifier_1.classifyLocally)(promptText);
        const isCloud = decision.route === 'cloud';
        return {
            provider: isCloud ? this.config.cloudProvider : this.config.localProvider,
            model: isCloud ? this.config.cloudModel : this.config.localModel,
            route: isCloud ? 'ARCHITECT_CLOUD' : 'WORKER_LOCAL',
            gate: decision.gate,
            rationale: decision.rationale,
            scores: decision.scores,
            latencyMs: decision.latencyMs,
        };
    }
    async handleBeforeRequest(session) {
        if (!session)
            return session;
        const fullText = extractPromptText(session);
        if (!fullText || fullText.trim().length === 0) {
            return {
                ...session,
                provider: this.config.cloudProvider,
                model: this.config.cloudModel,
            };
        }
        const decision = await this.predictRoute(fullText);
        const routerMeta = {
            provider: decision.provider,
            model: decision.model,
            route: decision.route,
            gate: decision.gate,
            rationale: decision.rationale,
            scores: decision.scores,
            latencyMs: decision.latencyMs,
            dlpViolations: decision.dlpViolations,
            tier: decision.route === 'ARCHITECT_CLOUD' ? 'Cloud Tier (Cloud Architect)' : 'Local Tier (Local Worker)',
            estimatedTokens: estimateTokenCount(fullText),
        };
        (0, logging_1.trace)('ROUTER_DECISION', {
            prompt: fullText.slice(0, 100).replace(/\n/g, ' '),
            tokens: estimateTokenCount(fullText),
            gate: decision.gate,
            selectedProvider: decision.provider,
            selectedModel: decision.model,
            rationale: decision.rationale,
        });
        const isLocal = decision.provider === this.config.localProvider;
        if (Object.isExtensible(session)) {
            try {
                session.provider = decision.provider;
                session.model = decision.model;
                session.apiKey = isLocal ? 'KEY' : undefined;
                if (isLocal) {
                    delete session.reasoningEffort;
                }
                if (!session.options)
                    session.options = {};
                if (Object.isExtensible(session.options)) {
                    session.options.provider = decision.provider;
                    session.options.model = decision.model;
                    if (isLocal) {
                        session.options.apiKey = 'KEY';
                        delete session.options.reasoningEffort;
                    }
                }
                if (!session.metadata)
                    session.metadata = {};
                if (Object.isExtensible(session.metadata)) {
                    session.metadata.router = routerMeta;
                }
            }
            catch (err) { }
        }
        const updatedOptions = {
            ...(session.options || {}),
            provider: decision.provider,
            model: decision.model,
        };
        if (isLocal) {
            updatedOptions.apiKey = 'KEY';
            delete updatedOptions.reasoningEffort;
        }
        const updated = {
            ...session,
            provider: decision.provider,
            model: decision.model,
            options: updatedOptions,
            metadata: {
                ...(session.metadata || {}),
                router: routerMeta,
            },
        };
        if (isLocal) {
            updated.apiKey = 'KEY';
            delete updated.reasoningEffort;
        }
        return updated;
    }
    async handleError(session, error) {
        if (!session)
            return session;
        const currentProvider = session.provider || session.options?.provider || this.config.localProvider;
        if (currentProvider === this.config.localProvider || session.metadata?.router?.route === 'WORKER_LOCAL' || session.metadata?.router?.route === 'local') {
            const errorMessage = error?.message || String(error);
            const prevMetadata = session.metadata?.router;
            const routerMeta = {
                ...prevMetadata,
                failover: true,
                previousProvider: currentProvider,
                provider: this.config.cloudProvider,
                model: this.config.cloudModel,
                route: 'cloud-failover',
                gate: 'Gate 2 (Guard - Automatic Cloud Failover)',
                rationale: `Local LM Studio provider failure caught (${errorMessage}). Transparently re-dispatching turn to DeepSeek Cloud.`,
                tier: 'Cloud Tier (DeepSeek Cloud Fallback)',
                estimatedTokens: prevMetadata?.estimatedTokens || 0,
            };
            (0, logging_1.trace)('ROUTER_FAILOVER', {
                errorMessage,
                cloudProvider: this.config.cloudProvider,
                cloudModel: this.config.cloudModel,
            });
            if (Object.isExtensible(session)) {
                try {
                    session.provider = this.config.cloudProvider;
                    session.model = this.config.cloudModel;
                    if (session.options && Object.isExtensible(session.options)) {
                        session.options.provider = this.config.cloudProvider;
                        session.options.model = this.config.cloudModel;
                    }
                    if (session.metadata && Object.isExtensible(session.metadata)) {
                        session.metadata.router = routerMeta;
                    }
                }
                catch (err) { }
            }
            const updated = {
                ...session,
                provider: this.config.cloudProvider,
                model: this.config.cloudModel,
                options: {
                    ...(session.options || {}),
                    provider: this.config.cloudProvider,
                    model: this.config.cloudModel,
                },
                metadata: {
                    ...(session.metadata || {}),
                    router: routerMeta,
                },
            };
            if (typeof session.redispatch === 'function') {
                await session.redispatch();
            }
            else if (typeof session.retry === 'function') {
                await session.retry();
            }
            return updated;
        }
        return session;
    }
}
exports.LocalRouter = LocalRouter;
const pendingTurnPrompts = new Map();
/**
 * Every user-message text this plugin has seen, per session.
 *
 * The DLP gate can only scan what the host hands it: `agent/pre-step` receives the
 * messages claimed for the current turn, and `agent/request` receives no message content
 * at all because the outbound conversation is assembled from the session surface after
 * that waterfall. Scanning only the newest message therefore let a credential introduced
 * in an earlier turn be re-sent on every later request without tripping the gate.
 * Accumulating makes the gate sticky instead.
 */
const sessionPromptCorpus = new Map();
const SESSION_CORPUS_MAX_CHARS = 200_000;
const GLOBAL_CORPUS_KEY = '__global__';
function corpusKeyFor(payload) {
    const id = payload?.agent?.id ?? payload?.agent?.session?.id ?? payload?.session?.id;
    return typeof id === 'string' && id.length > 0 ? id : GLOBAL_CORPUS_KEY;
}
function accumulateCorpus(key, text) {
    if (!text)
        return;
    const target = key || GLOBAL_CORPUS_KEY;
    const existing = sessionPromptCorpus.get(target) ?? '';
    if (existing.includes(text))
        return;
    const combined = existing ? `${existing}\n${text}` : text;
    sessionPromptCorpus.set(target, combined.length > SESSION_CORPUS_MAX_CHARS
        ? combined.slice(combined.length - SESSION_CORPUS_MAX_CHARS)
        : combined);
}
function extractTextFromClaimedMessages(messages) {
    if (!Array.isArray(messages))
        return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m)
            continue;
        if (typeof m.text === 'string' && m.text.trim())
            return m.text.trim();
        if (typeof m.prompt === 'string' && m.prompt.trim())
            return m.prompt.trim();
        if (typeof m.content === 'string' && m.content.trim())
            return m.content.trim();
        if (Array.isArray(m.content)) {
            for (const block of m.content) {
                if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
                    if (!block.text.startsWith('Current runtime context.')) {
                        return block.text.trim();
                    }
                }
            }
        }
    }
    return '';
}
let isPluginApplied = false;
/**
 * Print the measured reference throughput for the local worker models, so the
 * server console carries a baseline next to the live per-call LEDGER_AUDIT rate.
 */
function logWorkerBenchmarks() {
    console.log(`[WORKER_BENCH] Reference throughput (${profiles_1.WORKER_BENCHMARK_SOURCE})`);
    console.log('[WORKER_BENCH] Local work is unmetered, so the metered plan is spent on thinking rather than on reading code.');
    console.log('[WORKER_BENCH] LEDGER_AUDIT reports CloudEquiv: what the local tokens would have cost at the metered tier.');
    console.log('[WORKER_BENCH] That is the plan exposure you avoided, not money saved -- the GPU is a fixed cost.');
    console.log('[WORKER_BENCH] LEDGER_AUDIT carries running totals: Metered is what the plan paid, Local is what the GPU did.');
    console.log('[WORKER_BENCH]   model                     decode        ttft       note');
    for (const bench of profiles_1.WORKER_BENCHMARKS) {
        const active = bench.model === profiles_1.PROFILES.WORKER.model ? '  <- active worker' : '';
        console.log(`[WORKER_BENCH]   ${bench.model.padEnd(24)} ${`${bench.decodeTps.toFixed(1)} tok/s`.padEnd(13)} ${bench.ttft.padEnd(10)} ${bench.note}${active}`);
    }
    console.log(`[WORKER_BENCH] Active worker model: ${profiles_1.PROFILES.WORKER.model} (max_tokens: ${profiles_1.PROFILES.WORKER.max_tokens ?? 'unset'}, thinking: ${profiles_1.PROFILES.WORKER.enable_thinking === false ? 'off' : 'on'})`);
}
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
/**
 * Route an `ask` guard decision through the real approval seam.
 *
 * Returning `{ kind: 'ask' }` from a tools/pre-execute listener prompts nobody: the
 * pipeline understands only `deny`, so every other kind is an allow. The seam that
 * actually asks is `dsh-user-approval` (ctx.approval), and it fails closed — a
 * missing service, a missing agent, an idle turn or a throwing answerer all resolve
 * to 'unavailable', which this treats as a refusal.
 */
async function requestApprovalForWrite(ctx, exec, verdict) {
    try {
        const service = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
        if (!service || typeof service.request !== 'function')
            return 'unavailable';
        if (!exec?.agent)
            return 'unavailable';
        const outcome = await service.request({
            agent: exec.agent,
            toolName: String(exec?.name || 'unknown'),
            ...(exec?.callId ? { callId: exec.callId } : {}),
            reason: verdict.reason,
            ...(exec?.signal ? { signal: exec.signal } : {}),
        });
        // Validate against the vocabulary rather than trusting the answerer: the service
        // normalises rogue values, but a bridge that assumes it would treat any unknown
        // string as a decision. Anything unrecognised fails closed.
        return typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)
            ? outcome
            : 'unavailable';
    }
    catch (err) {
        // No open turn, suspended session, or a broken answerer: fail closed.
        console.warn('[LOCAL_GUARD] approval request failed; failing closed:', err?.message || err);
        return 'unavailable';
    }
}
function resolveVerificationPolicy(options = {}) {
    return {
        mode: options.verificationApproval ?? 'ask',
        allowlist: Array.isArray(options.verificationAllowlist) ? options.verificationAllowlist : [],
        allowInProcessFallback: options.allowInProcessFallback === true,
    };
}
/**
 * Ask the operator to approve one model-selected verification command. Unlike the write
 * guard this is not a `tools/pre-execute` decision, because the command runs after the
 * worker responds; it is asked before dispatch so the operator sees it up front.
 * Fails closed on every error path.
 */
async function requestApprovalForVerification(ctx, exec, command) {
    try {
        const service = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
        if (!service || typeof service.request !== 'function')
            return false;
        if (!exec?.agent)
            return false;
        const outcome = await service.request({
            agent: exec.agent,
            toolName: 'delegate_worker',
            ...(exec?.callId ? { callId: exec.callId } : {}),
            reason: `delegate_worker wants to run this verification command with the full authority of the DSH ` +
                `process:\n  ${command}\n` +
                `It is model-selected and is not confined to the workspace. Approve it only if you recognise it.`,
            ...(exec?.signal ? { signal: exec.signal } : {}),
        });
        return outcome === 'allowed-once';
    }
    catch (err) {
        console.warn('[LOCAL_GUARD] verification approval request failed; failing closed:', err?.message || err);
        return false;
    }
}
// Role resolution, the architect config and the lead tier moved to ./roles.ts and are imported
// above. They are re-exported beside the other module re-exports because callers depend on them.
function apply(ctx, options = {}) {
    // Restore what was delegated before this process started. Without this, a restart silently widened
    // what the architect may read back — the gap a live run found, and the reason this is not merely
    // in-memory state any more.
    for (const record of (0, contracts_1.loadDelegatedRegistry)()) {
        if (record.mode === 'created')
            contracts_1.delegatedPaths.add((0, paths_1.canonicalisePath)(record.path));
    }
    const REGISTERED_KEY = Symbol.for('dsh-plugin-coding-delegate.registered');
    const isTest = process.env.NODE_ENV === 'test';
    if (!isTest) {
        if (isPluginApplied || ctx[REGISTERED_KEY] || globalThis[REGISTERED_KEY]) {
            console.warn('[LOCAL_ROUTER] Plugin already registered. Skipping duplicate mounting.');
            return;
        }
        isPluginApplied = true;
        ctx[REGISTERED_KEY] = true;
        globalThis[REGISTERED_KEY] = true;
    }
    console.log('[LOCAL_ROUTER_DEBUG] ctx.tools available:', Boolean(ctx.tools));
    const router = new LocalRouter(options);
    const config = router.getConfig();
    const tracker = new savings_tracker_1.SavingsTracker((0, logging_1.resolveDataDir)());
    (0, logging_1.trace)('PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR', { config });
    // Register `delegate_worker` strictly adhering to `@deepseek-ai/dsh-tools` and DeepSeek JSON Schema contract
    if (ctx.tools && typeof ctx.tools.register === 'function') {
        try {
            const dshToolDef = {
                name: 'delegate_worker',
                description: 'Dispatches a discrete implementation, testing, or code-generation task to the configured local execution worker -- any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp) -- with an isolated context window. The worker has no repository read: declare contextFiles for the code it must see, since it cannot discover anything itself.',
                parameters: {
                    type: 'object',
                    properties: {
                        taskName: {
                            type: 'string',
                            description: 'A short descriptive identifier for the subtask',
                        },
                        instruction: {
                            type: 'string',
                            description: 'The complete technical prompt and specifications for the local worker',
                        },
                        targetFiles: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional file paths to target or modify',
                        },
                        runVerification: {
                            type: 'string',
                            description: 'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow.',
                        },
                        contractFiles: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Paths to the tests that constitute this unit contract. They are hashed before the worker runs, the worker is forbidden to write them, and they are re-hashed afterwards: any change voids the verdict. The architect owns these files.',
                        },
                        contextFiles: {
                            type: 'array',
                            description: 'Existing files the worker needs to see, as { path, startLine?, endLine? }. The plugin reads them into the worker prompt; you receive a record of what was injected and never the contents. Paths outside the workspace are refused, and context carrying a credential is refused rather than transmitted.',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string' },
                                    startLine: { type: 'number' },
                                    endLine: { type: 'number' },
                                },
                                required: ['path'],
                            },
                        },
                        workspaceDir: {
                            type: 'string',
                            description: 'Absolute path of the directory the worker may write into. Defaults to the session workspace; destinations outside it are refused.',
                        },
                    },
                    required: ['taskName', 'instruction'],
                },
                output: {
                    schema: {
                        type: 'object',
                        additionalProperties: true,
                    },
                    render: (_args, value) => [
                        {
                            type: 'text',
                            text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
                        },
                    ],
                },
                async execute(args, exec) {
                    const resolved = resolveWorkspaceDir(ctx);
                    const explicitDir = args?.workspaceDir;
                    // `endpoint` is not a declared tool argument and is deliberately dropped:
                    // delegateWorker would otherwise POST the task to whatever URL a caller named.
                    const { endpoint: _ignoredEndpoint, ...callerArgs } = args || {};
                    const policy = resolveVerificationPolicy(options);
                    return await delegateWorker({
                        ...callerArgs,
                        // Operator settings, not caller arguments. The local endpoint and model are
                        // trusted configuration; a caller-supplied `endpoint` was dropped just above.
                        ...(options?.localEndpoint ? { endpoint: options.localEndpoint } : {}),
                        ...(options?.localModel ? { model: options.localModel } : {}),
                        workspaceDir: explicitDir || resolved.dir,
                        workspaceSource: explicitDir ? 'caller-supplied workspaceDir' : resolved.source,
                        verificationPolicy: policy,
                        emitAllowlist: options?.emitAllowlist,
                        verificationApproval: (command) => requestApprovalForVerification(ctx, exec, command),
                    }, tracker);
                },
            };
            try {
                ;
                ctx.tools.register(dshToolDef);
            }
            catch (e) {
                ;
                ctx.tools.register('delegate_worker', dshToolDef, dshToolDef.execute);
            }
            console.log("[LOCAL_ROUTER_INIT] Tool 'delegate_worker' registered successfully on ctx.tools.");
            logWorkerBenchmarks();
        }
        catch (e) {
            console.warn("[LOCAL_ROUTER_INIT] Failed to register tool via ctx.tools.register:", e?.message || String(e));
        }
    }
    else {
        console.log("[LOCAL_ROUTER_INIT] Service ctx.tools not available. Registering fallback event listener for 'delegate_worker'.");
    }
    // Fallback listener for tool execution calls in DSH microkernel
    ctx.on('tool/call', async (payload) => {
        if (payload?.name === 'delegate_worker' || payload?.tool === 'delegate_worker') {
            const args = payload.args || payload.arguments || {};
            const resolved = resolveWorkspaceDir(ctx);
            const explicitDir = args?.workspaceDir;
            // `endpoint: options.localProvider` used to sit here, which set the POST URL to the
            // provider *id* ('lm-studio') rather than a URL. delegateWorker's default is correct.
            const { endpoint: _ignoredEndpoint, ...callerArgs } = args || {};
            return await delegateWorker({
                ...callerArgs,
                // Same operator settings as the registered tool path above.
                ...(options?.localEndpoint ? { endpoint: options.localEndpoint } : {}),
                ...(options?.localModel ? { model: options.localModel } : {}),
                workspaceDir: explicitDir || resolved.dir,
                workspaceSource: explicitDir ? 'caller-supplied workspaceDir' : resolved.source,
                // This path has no agent or call id, so no approval can be requested: with the
                // default 'ask' policy the verification command is refused rather than run.
                verificationPolicy: resolveVerificationPolicy(options),
                emitAllowlist: options?.emitAllowlist,
            }, tracker);
        }
    });
    // Local-only code guard: refuse cloud-authored source writes so that all code
    // work routes through delegate_worker to the local worker.
    if (options?.localCodeGuard !== false) {
        ctx.on('tools/pre-execute', async (exec, next) => {
            const decision = typeof next === 'function' ? await next() : { kind: 'allow' };
            if (!decision || decision.kind !== 'allow')
                return decision;
            try {
                const verdict = (0, guard_1.evaluateCodeWriteGuard)(exec, {
                    askPaths: options?.guardAskPaths,
                    delegatedPaths: contracts_1.delegatedPaths,
                    delegateReadPolicy: options?.delegateReadPolicy,
                    contractPaths: options?.contractPaths,
                    contractWriteMode: options?.contractWriteMode,
                });
                if (verdict) {
                    // guardMode 'deny' wins outright: an operator who said "never prompt" must
                    // not be prompted just because this path would otherwise be ask-eligible.
                    const wantsAsk = options?.guardMode !== 'deny' && (options?.guardMode === 'ask' || verdict.kind === 'ask');
                    if (!wantsAsk) {
                        console.log(`[LOCAL_GUARD] DENY ${exec?.name} -> ${verdict.target}`);
                        return { kind: 'deny', reason: verdict.reason };
                    }
                    // Ask for real, through the approval seam. Only 'allowed-once' grants.
                    const outcome = await requestApprovalForWrite(ctx, exec, verdict);
                    if (outcome === 'allowed-once') {
                        console.log(`[LOCAL_GUARD] ALLOWED-ONCE ${exec?.name} -> ${verdict.target}`);
                        return decision;
                    }
                    console.log(`[LOCAL_GUARD] DENY (${outcome}) ${exec?.name} -> ${verdict.target}`);
                    return {
                        kind: 'deny',
                        reason: `${verdict.reason} (approval outcome: ${outcome})`,
                    };
                }
                // Observation, not enforcement: the architect is allowed to read source, and this records it.
                // The guard above answers "may this happen"; this answers "did it, and who by" — which is what
                // will later say whether that access is used at all, and so whether it can be taken away.
                const observed = (0, roles_1.describeSourceRead)({
                    tool: exec?.name,
                    target: (0, guard_1.extractWriteTarget)(exec?.arguments),
                    role: (0, roles_1.roleForAgent)(exec?.agent?.id),
                });
                if (observed.track) {
                    (0, logging_1.trace)('SOURCE_READ', {
                        role: observed.role,
                        agent: String(exec?.agent?.id ?? '').slice(0, 8) || 'unknown',
                        tool: String(exec?.name ?? ''),
                        target: observed.target,
                        extension: observed.extension,
                    });
                }
            }
            catch (err) {
                // Fail closed: a guard that cannot evaluate must not wave the call through.
                console.warn('[LOCAL_GUARD] evaluation failed; failing closed:', err);
                return {
                    kind: 'deny',
                    reason: `Local-code guard could not evaluate this call: ${err?.message || err}`,
                };
            }
            return decision;
        });
        console.log('[LOCAL_ROUTER_INIT] Local-code guard registered on tools/pre-execute.');
    }
    // 1. Lightweight agent/pre-step prompt capture & DLP scanner ONLY
    ctx.on('agent/pre-step', async (payload, next) => {
        const turn = payload?.turn;
        const prompt = extractTextFromClaimedMessages(payload?.messages);
        if (turn !== undefined && prompt) {
            pendingTurnPrompts.set(turn, prompt);
            accumulateCorpus(corpusKeyFor(payload), prompt);
            (0, logging_1.trace)('HOOK_CAPTURE: PROMPT_CAPTURED (agent/pre-step)', {
                turn,
                prompt: prompt.slice(0, 100),
            });
        }
        return typeof next === 'function' ? await next() : payload;
    }, { prepend: true });
    // 2. Primary Thread (Architect) Request Hook: Pin primary thread to DeepSeek Cloud with native uncapped context and tool schema injection
    ctx.on('agent/request', async (payload, next) => {
        const resolvedConfig = typeof next === 'function' ? await next() : {};
        const turn = payload?.turn;
        const agent = payload?.agent;
        let prompt = (turn !== undefined ? pendingTurnPrompts.get(turn) : '') || '';
        if (turn !== undefined) {
            pendingTurnPrompts.delete(turn);
        }
        if (!prompt) {
            try {
                if (agent?.inbox?.nextTurn && Array.isArray(agent.inbox.nextTurn) && agent.inbox.nextTurn.length > 0) {
                    const item = agent.inbox.nextTurn[agent.inbox.nextTurn.length - 1];
                    prompt = item?.prompt || item?.text || item?.content || '';
                }
            }
            catch { }
        }
        if (!prompt && agent?.session)
            prompt = extractPromptText(agent.session);
        if (!prompt && payload?.session)
            prompt = extractPromptText(payload.session);
        if (!prompt && payload)
            prompt = extractPromptText(payload);
        // Pre-flight DLP Firewall. This is a GATE, not a log line: a payload carrying
        // credentials is either refused outright or pinned to the local worker, but it
        // is never transmitted to the cloud. (Earlier versions logged "Blocking WAN
        // transmission" and then sent the payload anyway.)
        // Scan everything this session has said, not just the newest message: the host
        // re-sends the conversation on every request, so a clean latest message is not
        // evidence that the outbound payload is clean.
        const corpus = sessionPromptCorpus.get(corpusKeyFor(payload)) || '';
        const dlpSubject = corpus.length > prompt.length ? corpus : prompt;
        const dlpResult = scanDLP(dlpSubject, {
            entropyCheck: options?.entropyCheck,
            entropyMinBitsPerChar: options?.entropyMinBitsPerChar,
            entropyMinLength: options?.entropyMinLength,
        });
        const dlpTripped = config.enforceDLP && dlpResult.hasSensitiveData;
        // Entropy-only hits are medium confidence: always rerouted local (so they are
        // never transmitted) but never hard-blocked, because digests and base64 payloads
        // are legitimate content that merely looks random.
        const entropyOnly = dlpTripped && !dlpResult.highConfidence;
        const rerouteLocal = dlpTripped && (entropyOnly || options?.dlpAction === 'local');
        const shouldBlock = dlpTripped && !rerouteLocal;
        if (dlpTripped) {
            const violations = dlpResult.violations.join(', ');
            (0, logging_1.trace)('DLP_FIREWALL_TRIPPED', {
                violations,
                action: rerouteLocal ? 'reroute-local' : 'block',
                confidence: dlpResult.highConfidence ? 'high' : 'entropy-only',
                prompt: prompt.slice(0, 100),
            });
            if (shouldBlock) {
                console.error(`[DLP_FIREWALL_BLOCK] Refusing to transmit: credentials detected (${violations}). Nothing was sent to the cloud.`);
                throw new Error(`DLP firewall blocked this request: ${violations} detected in the outbound payload. ` +
                    `Nothing was transmitted. Remove the credential from the conversation and retry. This gate scans every ` +
                    `user message it has seen in this session, so a credential that appeared in an earlier turn keeps ` +
                    `blocking until the session is restarted. Set dlpAction: 'local' to route such requests to the local ` +
                    `worker instead of refusing them. Assistant output and tool results are assembled by the host after ` +
                    `this hook runs and are not scanned.`);
            }
            console.warn(`[DLP_FIREWALL_REROUTE] Sensitive data (${violations}) pinned to the LOCAL worker; it will not reach the WAN.`);
        }
        // Which role is this request? The plugin used to treat every agent as the architect, which is
        // right for the architect and wrong for everything else: a lead configured to run locally would
        // be repinned to the cloud and told it was the architect. The DLP gate above runs either way, so
        // opting a provider out of the architect role does not opt it out of the firewall.
        const role = (0, roles_1.resolveAgentRole)({
            hostProvider: resolvedConfig?.provider,
            leadProviders: (0, roles_1.resolveLeadProviders)(options),
        });
        // Correlate the role with the agent, so a later tool call can be attributed. Best effort by
        // construction: the host does not expose lineage, so this is the plugin's own inference.
        (0, roles_1.rememberAgentRole)(agent?.id, role.role);
        const mutatedConfig = (0, roles_1.applyAgentRole)(resolvedConfig || {}, role, {
            cloudProvider: config.cloudProvider,
            cloudModel: config.cloudModel,
            localProvider: config.localProvider,
            localModel: config.localModel,
            rerouteLocal,
            architectInstruction: profiles_1.PROFILES.ARCHITECT.systemInstruction,
            workerTool: exports.DELEGATE_WORKER_OPENAI_SCHEMA,
        });
        // Rule 8: source may not reach the cloud. The read guard covers pulling delegated code back, and
        // contextFiles injects into the worker; this covers the blunt route — source sitting in the
        // outbound payload because it was typed into a cloud-bound conversation.
        const destination = rerouteLocal ||
            String(mutatedConfig.provider || '').toLowerCase() ===
                String(config.localProvider || '').toLowerCase()
            ? 'local'
            : 'cloud';
        const egressDetection = (0, roles_1.detectSourceEgress)(dlpSubject, {
            minLines: options?.sourceEgressMinLines,
        });
        const egress = (0, roles_1.evaluateSourceEgress)(options?.sourceEgress ?? 'deny', egressDetection, destination);
        if (egress.kind !== 'allow') {
            let permitted = false;
            if (egress.kind === 'ask') {
                try {
                    const approvalService = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
                    if (approvalService && typeof approvalService.request === 'function' && agent) {
                        const outcome = await approvalService.request({
                            agent,
                            toolName: 'agent/request',
                            reason: `This cloud-bound request carries source: ${egress.reason} Source is not supposed ` +
                                `to reach the cloud (rule 8). Approve only if you mean to transmit it.`,
                            ...(payload?.signal ? { signal: payload.signal } : {}),
                        });
                        permitted = outcome === 'allowed-once';
                    }
                }
                catch (err) {
                    console.warn('[SOURCE_EGRESS] approval request failed; failing closed:', err?.message || err);
                    permitted = false;
                }
            }
            if (!permitted) {
                (0, logging_1.trace)('SOURCE_EGRESS_BLOCKED', {
                    blocks: egressDetection.blocks,
                    languages: egressDetection.languages,
                    destination,
                    action: options?.sourceEgress ?? 'deny',
                });
                throw new Error(`Source may not reach the cloud (rule 8): ${egress.reason} Nothing was transmitted. ` +
                    `This gate reads every user message the session has sent, so a block from an earlier ` +
                    `turn keeps it closed until the session is restarted.`);
            }
        }
        (0, logging_1.trace)(role.role === 'lead'
            ? 'HOOK_EXIT: LEAD_LEFT_AS_CONFIGURED (agent/request)'
            : rerouteLocal
                ? 'HOOK_EXIT: DLP_PINNED_LOCAL (agent/request)'
                : 'HOOK_EXIT: ARCHITECT_CLOUD_PINNED (agent/request)', {
            role: role.role,
            roleReason: role.reason,
            provider: mutatedConfig.provider,
            model: mutatedConfig.model,
            uncappedContextWindow: role.role === 'architect',
            toolsCount: mutatedConfig.tools?.length || 0,
        });
        return mutatedConfig;
    }, { prepend: true });
    // 3. Post-step usage listener for actual token usage & ledger recording
    function handlePostStepUsage(payload) {
        const session = payload?.session || payload;
        const usage = payload?.usage ||
            session?.usage ||
            session?.response?.usage ||
            session?.result?.usage ||
            payload?.payload?.usage;
        if (!usage)
            return;
        const promptTokens = usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0;
        const completionTokens = usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens ?? 0;
        const totalTokens = usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens);
        const cacheHitTokens = usage.prompt_cache_hit_tokens ?? usage.cacheHitTokens ?? usage.prompt_cache_hit ?? 0;
        if (totalTokens > 0) {
            tracker.recordUsage({
                turn: payload?.turn ?? session?.turn ?? payload?.step ?? 1,
                route: 'ARCHITECT_CLOUD',
                model: 'deepseek-chat',
                reason: 'STEP_COMPLETION',
                promptTokens,
                completionTokens,
                totalTokens,
                cacheHitTokens,
            });
        }
    }
    ctx.on('agent/post-step', handlePostStepUsage);
    ctx.on('agent/step-finish', handlePostStepUsage);
    // 4. Stream chunk listener for output token accumulation if usage is emitted on stream frames
    ctx.on('agent/assistant-stream', (payload) => {
        const frame = payload?.frame;
        const raw = frame || payload;
        if (typeof raw?.usage?.completion_tokens === 'number') {
            const usage = raw.usage;
            const promptTokens = usage.prompt_tokens ?? 0;
            const completionTokens = usage.completion_tokens ?? 0;
            const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
            const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
            if (totalTokens > 0) {
                tracker.recordUsage({
                    turn: payload?.turn ?? frame?.turn ?? 1,
                    route: 'ARCHITECT_CLOUD',
                    model: 'deepseek-chat',
                    reason: 'STREAM_USAGE_FRAME',
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    cacheHitTokens,
                });
            }
        }
    });
}
// The delta machinery still lives in this file (it moves to ./delegation.ts later), and ./emission.ts
// must not import this module back, so the two halves are joined here, at the composition root.
(0, emission_1.configurePatchEngine)({
    parse: parseSearchReplaceBlocks,
    apply: applySearchReplaceBlocks,
});
const pluginExport = {
    name: exports.name,
    inject: exports.inject,
    using: exports.using,
    apply,
    LocalRouter,
    SavingsTracker: savings_tracker_1.SavingsTracker,
    scanDLP,
    delegateWorker,
    extractAndEmitFiles: emission_1.extractAndEmitFiles,
    runSandboxVerification: verification_1.runSandboxVerification,
    parseTestOutput: verification_1.parseTestOutput,
    sha256File: contracts_1.sha256File,
    resolveContextFiles: context_1.resolveContextFiles,
    parseSearchReplaceBlocks,
    applySearchReplaceBlocks,
    MIN_SEARCH_CHARS: exports.MIN_SEARCH_CHARS,
    DEFAULT_CONTEXT_MAX_BYTES: context_1.DEFAULT_CONTEXT_MAX_BYTES,
    resolveContractFiles: contracts_1.resolveContractFiles,
    contractFileHashes: contracts_1.contractFileHashes,
    contractViolations: contracts_1.contractViolations,
    resolveDelegateStatus,
    resolveLeadProviders: roles_1.resolveLeadProviders,
    evaluateDelegatedReadPolicy: guard_1.evaluateDelegatedReadPolicy,
    rememberAgentRole: roles_1.rememberAgentRole,
    roleForAgent: roles_1.roleForAgent,
    resetAgentRoles: roles_1.resetAgentRoles,
    describeSourceRead: roles_1.describeSourceRead,
    AGENT_ROLE_LIMIT: roles_1.AGENT_ROLE_LIMIT,
    detectSourceEgress: roles_1.detectSourceEgress,
    evaluateSourceEgress: roles_1.evaluateSourceEgress,
    DEFAULT_SOURCE_EGRESS_MIN_LINES: roles_1.DEFAULT_SOURCE_EGRESS_MIN_LINES,
    resolveDelegatedRegistryPath: contracts_1.resolveDelegatedRegistryPath,
    parseDelegatedRegistry: contracts_1.parseDelegatedRegistry,
    mergeDelegatedRecords: contracts_1.mergeDelegatedRecords,
    pruneDelegatedRecords: contracts_1.pruneDelegatedRecords,
    saveDelegatedRegistry: contracts_1.saveDelegatedRegistry,
    loadDelegatedRegistry: contracts_1.loadDelegatedRegistry,
    rememberDelegated: contracts_1.rememberDelegated,
    resolveAgentRole: roles_1.resolveAgentRole,
    applyArchitectConfig: roles_1.applyArchitectConfig,
    applyAgentRole: roles_1.applyAgentRole,
    DELEGATE_WORKER_SCHEMA: exports.DELEGATE_WORKER_SCHEMA,
    DELEGATE_WORKER_OPENAI_SCHEMA: exports.DELEGATE_WORKER_OPENAI_SCHEMA,
    PROFILES: profiles_1.PROFILES,
    default: apply,
};
exports.default = pluginExport;
