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
exports.MIN_SEARCH_CHARS = exports.DEFAULT_LOCAL_ENDPOINT = exports.DELEGATE_WORKER_SCHEMA = exports.DELEGATE_WORKER_OPENAI_SCHEMA = void 0;
exports.resolveChatCompletionsUrl = resolveChatCompletionsUrl;
exports.parseSearchReplaceBlocks = parseSearchReplaceBlocks;
exports.applySearchReplaceBlocks = applySearchReplaceBlocks;
exports.resolveDelegateStatus = resolveDelegateStatus;
exports.delegateWorker = delegateWorker;
exports.extractPromptText = extractPromptText;
exports.estimateTokenCount = estimateTokenCount;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const profiles_1 = require("./profiles");
const logging_1 = require("./logging");
const emission_1 = require("./emission");
const context_1 = require("./context");
const retry_context_1 = require("./retry-context");
const verification_1 = require("./verification");
const contracts_1 = require("./contracts");
// `scanDLP` deliberately stays in index.ts and is imported from there. Moving it here instead would
// make verification.ts import from this module while this module imports verification.ts -- a cycle
// between two leaves. A cycle through the composition root is the shape that already works.
const index_1 = require("./index");
const paths_1 = require("./paths");
/**
 * Locations from the last failed unit, per workspace, waiting to be offered to the next attempt.
 *
 * Process-scoped and consumed once. Keyed by workspace rather than by task name because a retry is
 * usually the same designer asking again in different words, and keying on the words would miss exactly
 * the case this exists for.
 */
const pendingRetryContext = new Map();
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
                    description: 'The files this unit may write. ENFORCED: an emission to any path not listed here is refused and reported, because a unit that writes outside what it declared is how two units come to disagree about the same code. Declare every file the unit creates or changes, including a directory if the unit chooses the filenames within it. Omit the field to leave the unit unrestricted.',
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
        return exports.DEFAULT_LOCAL_ENDPOINT + '/chat/completions';
    return /\/chat\/completions$/i.test(trimmed) ? trimmed : trimmed + '/chat/completions';
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
                reason: 'a search block was too short to be unambiguous (' +
                    search.trim().length +
                    ' characters, minimum ' +
                    exports.MIN_SEARCH_CHARS +
                    ')',
            };
        }
        const occurrences = work.split(search).length - 1;
        if (occurrences === 0) {
            return {
                ok: false,
                reason: 'no exact match for a search block (' + search.trim().slice(0, 60) + ')',
            };
        }
        if (occurrences > 1) {
            return {
                ok: false,
                reason: 'a search block matched more than once (' +
                    occurrences +
                    ' times), so the edit is ambiguous',
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
    // Tampering voids the run whatever else happened: what passed was no longer the contract.
    if (input.contractViolations.length > 0)
        return 'CONTRACT_MODIFIED';
    // Nothing ran, so the outcome is unknown rather than a pass.
    if (input.verificationGate)
        return 'VERIFICATION_NOT_APPROVED';
    // The project check is evaluated BEFORE `unverified`, and that order is the point. `unverified` is an
    // absence of evidence -- no command was supplied for the unit. A failed project check is positive
    // evidence: something was proven, and what was proven is that the tree is broken. Reporting
    // "unverified" for a unit that demonstrably broke the build would understate what is known.
    if (input.coherenceFailed) {
        return input.isSuccess ? 'INCOHERENT' : 'VERIFICATION_FAILED';
    }
    if (input.unverified)
        return 'UNVERIFIED';
    return input.isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED';
}
async function delegateWorker(params = {}, tracker) {
    const endpoint = resolveChatCompletionsUrl(params.endpoint || profiles_1.PROFILES.WORKER.endpoint || exports.DEFAULT_LOCAL_ENDPOINT);
    const model = params.model || profiles_1.PROFILES.WORKER.model;
    // The fence is built with `\x60` escapes rather than written literally. A literal triple backtick in
    // this file makes it unpatchable by a confined agent, because the emission scanner truncates a fenced
    // body at the first backtick run inside it. The instruction the worker receives is identical.
    const FENCE = '\x60\x60\x60';
    const fileInstruction = 'To change part of an existing file, emit a patch block instead of the whole file:\n' +
        FENCE +
        'patch file="src/thing.ts"\n<<<<<<< SEARCH\n<the exact existing lines>\n=======\n<the replacement lines>\n>>>>>>> REPLACE\n' +
        FENCE +
        '\n' +
        'The SEARCH text must match the file exactly and occur exactly once, and there is no fuzzy matching.\n' +
        'To create a file, or replace one wholesale, wrap it in a code block with the target file path in the header or first line, e.g. ' +
        FENCE +
        'typescript file="src/math-helper.ts"\n...code...\n' +
        FENCE +
        ' or // FILE: tests/math-helper.test.ts';
    const systemPrompt = params.systemPrompt ||
        'You are a fast, accurate local coding worker executing a discrete task. ' + fileInstruction;
    const taskText = params.instruction || params.taskPrompt || params.prompt || '';
    // Resolved before the worker runs: the contract hashes have to describe the tree as it was handed
    // over, and context has to be read while the architect is still blind to it.
    const workspaceBase = params.workspaceDir || process.cwd();
    // Recovery from the previous failure in this workspace. Its locations become context for this attempt,
    // once: an old failure must not quietly influence every later unit in the session, so the pending set
    // is consumed here whether or not it turns out to be usable.
    const pendingRetry = params.retryContext === 'off' ? [] : pendingRetryContext.get(workspaceBase) ?? [];
    if (pendingRetry.length > 0)
        pendingRetryContext.delete(workspaceBase);
    const declaredContext = Array.isArray(params.contextFiles) ? params.contextFiles : [];
    let context = (0, context_1.resolveContextFiles)(declaredContext, workspaceBase);
    let retryInjected = [];
    if (pendingRetry.length > 0 && context.errors.length === 0) {
        // Compared as resolved paths, not as the strings the architect typed. A failure reports its location
        // relative to the workspace its command ran in, so a raw string comparison matches only when the
        // architect happened to spell the path exactly as the failing tool did.
        const locate = (p) => (0, paths_1.canonicalisePath)(path.isAbsolute(p) ? p : path.resolve(workspaceBase, p));
        const declaredPaths = new Set(context.injected.map((c) => (0, paths_1.canonicalisePath)(c.path)));
        // A contract file is not context. `contractFiles` exists so the implementer cannot see or edit what
        // judges it -- and a failing contract names itself, so the locations fed back here point straight at
        // it. Resolved independently of `contractPaths` further down because the retry set is decided before
        // that is computed. The integrity check does not cover this case: it protects the contract from being
        // WRITTEN, not from being shown.
        const protectedPaths = new Set((0, contracts_1.resolveContractFiles)(params.contractFiles, workspaceBase).map((p) => (0, paths_1.canonicalisePath)(p)));
        const additions = (0, retry_context_1.retryContextRequests)(pendingRetry).filter((r) => !declaredPaths.has(locate(r.path)) && !protectedPaths.has(locate(r.path)));
        if (additions.length > 0) {
            // Best-effort, and deliberately so. If widening the injection would push it over its byte budget,
            // resolveContextFiles refuses the WHOLE injection and this unit dies for a reason the architect
            // never asked for. So the widened set is used only when it resolves cleanly; otherwise the declared
            // set stands, exactly as it would have without this feature.
            const widened = (0, context_1.resolveContextFiles)([...declaredContext, ...additions], workspaceBase);
            if (widened.errors.length === 0) {
                context = widened;
                retryInjected = additions;
            }
        }
    }
    // Covers the auto-injected set as well as the declared one, so a credential in a file that was pulled
    // in automatically is refused on the same terms as one the architect named.
    if (declaredContext.length > 0 || context.injected.length > 0) {
        if (context.errors.length > 0) {
            return {
                success: false,
                status: 'CONTEXT_REFUSED',
                message: 'Context injection refused:\n' + context.errors.map((e) => '  - ' + e).join('\n'),
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
        const contextDlp = (0, index_1.scanDLP)(context.text);
        if (contextDlp.hasSensitiveData && contextDlp.highConfidence) {
            const refusal = 'declared context carries a credential (' +
                contextDlp.violations.join(', ') +
                '), so it will not ' +
                'be sent to the worker endpoint. Narrow the range to exclude it, or remove it from the file.';
            return {
                success: false,
                status: 'CONTEXT_REFUSED',
                message: 'Context injection refused:\n  - ' + refusal,
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
        fileContextText = 'Target Files:\n' + params.targetFiles.join('\n');
    }
    else if (typeof params.targetFiles === 'string') {
        fileContextText = 'Target Files:\n' + params.targetFiles;
    }
    else if (typeof params.fileContext === 'string') {
        fileContextText = params.fileContext;
    }
    // Appended rather than chosen by an else-if. A unit normally has both targetFiles and context, and
    // the earlier shape meant a declared context was silently dropped whenever targetFiles was present.
    if (context.text) {
        fileContextText += (fileContextText ? '\n\n' : '') + context.text;
    }
    if (params.runVerification) {
        fileContextText += '\nVerification Command:\n' + params.runVerification;
    }
    const combinedPrompt = fileContextText
        ? 'Task: ' + (params.taskName || 'Subtask') + '\n' + taskText + '\n\n' + fileContextText
        : 'Task: ' + (params.taskName || 'Subtask') + '\n' + taskText;
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
                stop: profiles_1.PROFILES.WORKER.stop ?? ['<|im_' + 'end|>', '<|endof' + 'text|>'],
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
                message: 'LM Studio returned HTTP ' + response.status + ': ' + errText,
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
        const totalTokens = data.usage?.total_tokens ?? promptTokens + completionTokens;
        if (tracker) {
            tracker.recordUsage({
                turn: turnId,
                route: 'WORKER_LOCAL',
                model,
                reason: 'SUBAGENT_DELEGATION (' + (params.taskName || 'subtask') + ')',
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
                    message: "Resolved workspace directory '" +
                        workspaceBase +
                        "' does not exist and could not be created: " +
                        (err?.message || String(err)),
                    resolvedWorkspace: workspaceBase,
                    filesWritten: [],
                    testResults: { passed: 0, failed: 0, output: 'No files written.' },
                    tokens: { prompt: promptTokens, completion: completionTokens },
                };
            }
        }
        const emission = (0, emission_1.extractAndEmitFiles)(content, params.targetFiles, workspaceBase, params.emitAllowlist ?? [], contractPaths, { enforceUnitScope: params.unitScope !== 'off' });
        const filesWritten = emission.filesWritten;
        // Remember what we wrote on the architect's behalf, so reading it back can be gated -- distinguishing
        // files the worker created, which the architect never saw, from files it patched, which it did.
        const createdPaths = filesWritten.filter((f) => f.mode !== 'patch').map((f) => f.path);
        const patchedPaths = filesWritten.filter((f) => f.mode === 'patch').map((f) => f.path);
        if (createdPaths.length > 0)
            (0, contracts_1.rememberDelegated)(createdPaths, 'created');
        if (patchedPaths.length > 0)
            (0, contracts_1.rememberDelegated)(patchedPaths, 'patched');
        const policy = params.verificationPolicy ?? verification_1.DEFAULT_VERIFICATION_POLICY;
        let testResults = undefined;
        let verificationGate = undefined;
        if (params.runVerification) {
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
                    timeoutMs: policy.timeoutMs,
                });
            }
            else {
                verificationGate =
                    decision.kind === 'deny'
                        ? decision.reason
                        : 'approval was not granted (' + decision.reason + ')';
            }
        }
        // A result is a verdict on a contract, and the contract is the verification command. Code
        // produced without one has an unchecked contract: reporting SUCCESS there would be the same
        // false green as counting unrecognised test output as a pass, which this plugin has already
        // been caught doing twice.
        const wroteFiles = filesWritten.length > 0 && emission.errors.length === 0;
        const unverified = !verificationGate && !params.runVerification && wroteFiles;
        // The project's own check, which is the only thing here that spans units.
        //
        // Skipped in two cases, both deliberate. A unit that wrote no files cannot have broken coherence, so
        // a delegation that only answered a question does not pay for a build. And `mode: 'deny'` means no
        // verification command is executed, which this is -- consistent rather than an exception to it.
        let coherenceResults = undefined;
        const coherenceCommand = policy.coherenceVerification;
        if (coherenceCommand && wroteFiles && policy.mode !== 'deny') {
            coherenceResults = (0, verification_1.runSandboxVerification)(coherenceCommand, workspaceBase, {
                redact: params.redactVerification ?? process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION !== '1',
                // A separate raw log, so a failing project check cannot overwrite the unit's own evidence.
                rawLogPath: path.join((0, logging_1.resolveDataDir)(), 'last-coherence.log'),
                timeoutMs: policy.timeoutMs,
            });
        }
        // A spawn the sandbox refused reports failed > 0, so a check that could not run is a failure here
        // rather than a silent pass -- which is the direction this has to fail in.
        const coherenceFailed = Boolean(coherenceResults && coherenceResults.failed > 0);
        // Re-hash once the worker has finished and verification has run. A violation voids the verdict
        // regardless of what the tests reported, because the tests are no longer the contract.
        const contractAfter = (0, contracts_1.contractFileHashes)(contractPaths);
        const contractViolationsFound = (0, contracts_1.contractViolations)(contractBefore, contractAfter);
        // The unit's own verdict, before the project is considered -- kept separate on purpose.
        // `resolveDelegateStatus` needs this one rather than the combined one, because INCOHERENT means
        // exactly "the unit passed and the project did not", so the status function has to be told which of
        // the two failed. Folding coherence in here first made every broken tree report VERIFICATION_FAILED,
        // which points the architect at the unit when the unit is fine.
        const unitSuccess = contractViolationsFound.length === 0 &&
            !verificationGate &&
            !unverified &&
            (!testResults || testResults.failed === 0) &&
            emission.errors.length === 0;
        // What the caller is told: both the unit and the project have to hold.
        const isSuccess = unitSuccess && !coherenceFailed;
        let summaryText = '';
        if (filesWritten.length > 0) {
            summaryText =
                "Task '" +
                    (params.taskName || 'Subtask') +
                    "' completed. Wrote " +
                    filesWritten.length +
                    ' file(s):\n' +
                    filesWritten
                        .map((f) => '  - ' +
                        f.path +
                        ' (' +
                        f.lines +
                        ' lines, ' +
                        f.bytes +
                        ' bytes' +
                        (f.mode === 'patch' ? ', patched in place with ' + f.hunks + ' hunk(s)' : '') +
                        ')')
                        .join('\n');
        }
        else {
            summaryText =
                "Task '" +
                    (params.taskName || 'Subtask') +
                    "' completed. Worker returned " +
                    content.split('\n').length +
                    ' line(s) of output.';
        }
        summaryText +=
            '\nWorkspace: ' +
                workspaceBase +
                (params.workspaceSource ? ' (resolved via ' + params.workspaceSource + ')' : '');
        if (params.workspaceSource && /FALLBACK/.test(params.workspaceSource) && filesWritten.length > 0) {
            summaryText +=
                '\nWARNING: the Session workspace could not be resolved, so files were written relative to ' +
                    workspaceBase +
                    '. Pass absolute paths in targetFiles, or set DSH_WORKSPACE_ROOT, to be certain of the destination.';
        }
        if (emission.errors.length > 0) {
            summaryText +=
                '\nFILE WRITE ERRORS:\n' +
                    emission.errors.map((e) => '  - ' + e).join('\n');
        }
        if (verificationGate) {
            summaryText += '\nVerification was NOT run: ' + verificationGate;
        }
        if (unverified) {
            summaryText +=
                '\nUNVERIFIED: no verification command was supplied, so the contract was never checked. ' +
                    'Files were written; nothing was proven.';
        }
        if (testResults) {
            summaryText +=
                '\nVerification Results: Passed ' +
                    testResults.passed +
                    ', Failed ' +
                    testResults.failed +
                    '.';
            if (testResults.errorSummary) {
                summaryText += '\nFailures: ' + testResults.errorSummary;
            }
        }
        if (coherenceResults) {
            summaryText +=
                '\nCoherence check: Passed ' +
                    coherenceResults.passed +
                    ', Failed ' +
                    coherenceResults.failed +
                    '.';
            if (coherenceFailed) {
                summaryText +=
                    '\nINCOHERENT: this unit passed its own contract, but the project check failed. The tree is ' +
                        'broken by this unit even though the tests written for it pass, so the verdict is void.';
            }
            if (coherenceResults.errorSummary) {
                summaryText += '\nCoherence failures: ' + coherenceResults.errorSummary;
            }
        }
        if (contractPaths.length > 0) {
            summaryText +=
                contractViolationsFound.length > 0
                    ? '\nCONTRACT MODIFIED, verdict void: ' + contractViolationsFound.join('; ') + '.'
                    : '\nContract: ' + contractPaths.length + ' declared file(s), unchanged.';
        }
        if (retryInjected.length > 0) {
            summaryText +=
                '\nContext widened with the previous failure at ' +
                    retryInjected.map((c) => c.path).join(', ') +
                    '. The worker was shown code the architect did not name.';
        }
        // What the next attempt in this workspace should be shown. Stored only for a failure, and only from
        // locations the failure actually carried: a unit that passed must not seed a retry, and a failure with
        // no usable location clears the set rather than leaving a stale one to resurface later.
        if (unitSuccess) {
            pendingRetryContext.delete(workspaceBase);
        }
        else {
            const failureLocations = (0, retry_context_1.parseFailureLocations)(testResults?.failures);
            if (failureLocations.length > 0)
                pendingRetryContext.set(workspaceBase, failureLocations);
            else
                pendingRetryContext.delete(workspaceBase);
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
                        ? 'Verification not run: ' + verificationGate
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
            ...(coherenceResults ? { coherenceResults } : {}),
            summary: summaryText,
            status: resolveDelegateStatus({
                verificationGate,
                unverified,
                contractViolations: contractViolationsFound,
                isSuccess: unitSuccess,
                coherenceFailed,
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
            message: 'LM Studio at 127.0.0.1:1234 was unreachable or failed: ' + errMsg,
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
// The delta machinery and the module that consumes it now live together, so the two halves are joined
// here instead of at the composition root. ./emission.ts still cannot import this module back; it is
// handed its engine instead. Both seams in that module default closed, so a mis-ordered load refuses
// rather than crashing.
(0, emission_1.configurePatchEngine)({
    parse: parseSearchReplaceBlocks,
    apply: applySearchReplaceBlocks,
});
