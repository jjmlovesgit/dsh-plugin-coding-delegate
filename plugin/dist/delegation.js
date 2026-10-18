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
exports.MAX_ERROR_BODY_CHARS = exports.MIN_SEARCH_CHARS = exports.DEFAULT_LOCAL_ENDPOINT = exports.MAX_VERIFICATION_REPEATS = exports.DEFAULT_VERIFICATION_REPEATS = exports.DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER = exports.CANONICAL_DELEGATE_WORKER_PARAMETERS = exports.DELEGATE_WORKER_SCHEMA = exports.DELEGATE_WORKER_OPENAI_SCHEMA = void 0;
exports.resolveVerificationRepeats = resolveVerificationRepeats;
exports.resolveChatCompletionsUrl = resolveChatCompletionsUrl;
exports.parseSearchReplaceBlocks = parseSearchReplaceBlocks;
exports.applySearchReplaceBlocks = applySearchReplaceBlocks;
exports.resolveDelegateStatus = resolveDelegateStatus;
exports.classifyWorkerOutput = classifyWorkerOutput;
exports.truncateErrorBody = truncateErrorBody;
exports.delegateWorker = delegateWorker;
exports.extractPromptText = extractPromptText;
exports.estimateTokenCount = estimateTokenCount;
const child_process = __importStar(require("child_process"));
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
const canonical_json_1 = require("./canonical-json");
const crypto_attestation_1 = require("./crypto-attestation");
const attestation_notes_1 = require("./attestation-notes");
/**
 * The commit the delegation's workspace is actually on, or null.
 *
 * READ, NEVER DECLARED. An operator-supplied `baseCommit` would be a claim about a tree, and this
 * module's sibling already settled the principle: `recordOperatorAttestation` reads a file's hash
 * from disk rather than accepting one, because "a caller-supplied hash would let an attestation be
 * recorded for content that was never on disk". A commit is the same kind of fact and is read the
 * same way -- and when it cannot be read, the attestation is withheld rather than anchored to
 * whatever someone typed.
 *
 * Read-only and non-interactive. `-C` targets the delegation's own workspace rather than this
 * process's cwd, which is not the same directory. A missing git, a non-repository workspace or any
 * other failure returns null rather than throwing: the caller's job is to refuse, not to crash a
 * delegation that was otherwise fine.
 */
function readBaseCommit(workspaceDir) {
    try {
        const out = child_process.execFileSync('git', ['-C', workspaceDir, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const trimmed = String(out).trim();
        return trimmed || null;
    }
    catch {
        return null;
    }
}
/**
 * Store a signed record as a note against the commit it anchors to.
 *
 * NON-BLOCKING BY DESIGN. The code was verified and signed before this runs, so failing its promotion
 * because metadata storage failed would conflate the work artifact with the ledger receipt. Every
 * failure -- a lock held by another git process, a corrupt notes tree, a permission error -- comes
 * back as `{ written: false, reason }` beside an otherwise intact verdict.
 *
 * THE PLUGIN DOES NOT PUSH. Publishing the ref is the operator's or CI's call, run as the refspec the
 * README documents. Initiating a network operation here would break the egress posture and presume a
 * remote and credentials that a local or air-gapped host need not have.
 */
function writeDelegationNote(workspaceDir, notesRef, commit, envelope) {
    const command = (0, attestation_notes_1.buildNotesCommand)({ commit, notesRef, body: (0, canonical_json_1.canonicalizeJson)(envelope) });
    if (!command.ok)
        return { written: false, reason: command.reason };
    try {
        child_process.execFileSync('git', ['-C', workspaceDir, ...command.args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { written: true };
    }
    catch (err) {
        // git puts the useful part on stderr. The first line names the failure without turning a status
        // field into a transcript.
        const detail = String(err?.stderr || err?.message || err)
            .trim()
            .split('\n')[0];
        return { written: false, reason: detail.slice(0, 300) || 'git notes failed' };
    }
}
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
                    description: 'Optional shell command to verify the output. It executes with the authority of the DSH process and requires operator approval unless verificationApproval is set to allow. It runs THREE times by default: three agreeing runs prove the contract stable, and any disagreement reports UNIT_FLAKY rather than a pass, which is what stops a non-deterministic oracle promoting broken code on a lucky run.',
                },
                verificationRepeats: {
                    type: 'number',
                    description: 'How many times to run runVerification. Defaults to 3 and is capped at 20. Raise it for a rare race condition. Pass 1 ONLY for a suite you have measured as deterministic and whose three-fold cost you are deliberately declining -- a contract that runs once cannot disagree with itself, so a flaky oracle becomes invisible again.',
                },
                // REMOVED ON PURPOSE: `attestTargets`, `attestEvidence`, `attestOperator`.
                //
                // They let a MODEL choose who to name as the reviewing human and what evidence to record, and
                // `index.ts` then wrote an OPERATOR_ATTESTED record out of those values. An attestation is a claim
                // that a PERSON reviewed content, and a value the caller supplies cannot support that claim -- the
                // more of the record the caller controls, the more convincing the forgery. Removing only the
                // identity and the evidence would have left the TRIGGER: `attestTargets` present, `operatorIdentity`
                // set in plugin config, and the canned default evidence string still produced the record.
                //
                // All three are gone, from here and from `DelegateWorkerParameter` in contracts.ts, and
                // `DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER` below makes the removal compile-enforced: the
                // schema's keys and that union must be the same set, so a parameter re-added to one alone fails the
                // build rather than silently returning to the tool surface.
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
/** Freeze a value and everything reachable from it. `Object.freeze` is shallow; a schema is not. */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
        Object.freeze(value);
    }
    return value;
}
/**
 * A deep-frozen SNAPSHOT of the canonical parameter block, taken once at module load.
 *
 * WHY A SNAPSHOT, WHEN REGISTRATION ALREADY REFERENCES THE CANONICAL OBJECT. index.ts used to assert that an
 * INLINE copy of the parameter list agreed with this file's canonical one, because the two copies had already
 * drifted once and the drift was silent: `attestTargets`/`attestEvidence` were added to the inline copy only,
 * the tool call succeeded, and the parameters were stripped on the way in. The inline copy is gone now --
 * index.ts passes `DELEGATE_WORKER_OPENAI_SCHEMA.function.parameters` -- and the assertion was left comparing
 * that object to ITSELF. A check that cannot fail is worse than no check at all, because it is quoted as
 * evidence: it was the one place in the repository where "drift" was claimed to be caught and could not be.
 *
 * What this catches is the residual risk that object IDENTITY cannot: the block handed to Cordis being
 * MUTATED after load, by a monkey-patch, a misplaced `properties.x = ...`, or framework code decorating what
 * it was given. Registration compares the live block against this frozen snapshot and refuses to register a
 * surface that disagrees with the reviewed one.
 *
 * What it does NOT catch, stated so it is not quoted for more than it does: it cannot tell that the canonical
 * list is WRONG. That is `DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER` below (a value, so it is always
 * checked by the compiler) and the explicit parameter set in `tool-surface.oracle.mjs`. This one is about a
 * good list staying good through registration.
 */
exports.CANONICAL_DELEGATE_WORKER_PARAMETERS = deepFreeze(
// A JSON round-trip, not a shallow copy: the comparison is on CONTENT, so the reference has to be deep
// enough that a mutation of the live block cannot reach into it. Frozen after, so neither side can be
// edited by whoever notices the check exists.
JSON.parse(JSON.stringify(exports.DELEGATE_WORKER_OPENAI_SCHEMA.function.parameters)));
exports.DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER = true;
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
exports.DEFAULT_VERIFICATION_REPEATS = 3;
exports.MAX_VERIFICATION_REPEATS = 20;
function resolveVerificationRepeats(value) {
    if (value === undefined || value === null)
        return exports.DEFAULT_VERIFICATION_REPEATS;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return exports.DEFAULT_VERIFICATION_REPEATS;
    }
    return Math.min(value, exports.MAX_VERIFICATION_REPEATS);
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
    // A contract that cannot agree with itself has not established anything about the content, so it
    // outranks both the unit's own result and the project check. This is the clause that stops a
    // non-deterministic oracle from being read as a pass on the run where the defect did not trigger.
    if (input.flaky)
        return 'FLAKY';
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
/**
 * An empty worker response, judged from the response alone.
 *
 * A worker that produces nothing does not report an error. The server returns HTTP 200 with empty
 * content, and nothing downstream can tell that apart from a worker that legitimately had nothing to
 * say: `extractAndEmitFiles('')` returns no files AND no errors, so `emission.errors.length === 0`
 * holds, the contract then re-runs over a tree the worker never touched and passes, and
 * `resolveDelegateStatus` reports SUCCESS over a run that produced nothing. The envelope gate already
 * withholds on an empty artifact list, so the RECORD was safe; the VERDICT was not. See
 * `docs/findings.md`.
 *
 * Measured on `qwen/qwen3.8-27b` with thinking enabled at the host: 34,076 characters of
 * `reasoning_content` consumed the entire 8192-token budget and the answer never arrived.
 *
 * EMPTY CONTENT IS NOW THE WHOLE CONDITION. It used to be `finish_reason === 'length'` AND empty, on the
 * reasoning that only token exhaustion was known to produce this. That left the identical empty reply
 * with `finish_reason: 'stop'` settling as SUCCESS -- the same "empty, passing run" reached by a
 * different route, carried in this repository as a KNOWN GAP rather than as a fix. A worker that reports
 * the turn finished and emits nothing has produced nothing, and which reason it gave for stopping does
 * not make the empty reply usable. The two causes are still reported differently, because token
 * exhaustion has a specific remedy and "finished with nothing" does not.
 *
 * STILL NARROW WHERE IT MATTERS: NON-empty content is never this refusal, whatever the finish reason. A
 * model that emitted a complete file and then rambled into the cap produced usable output, and a worker
 * that answers a question in prose rather than emitting a file is a supported delegation, not a failure.
 * The refusal is about content that does not exist, not about content that wrote no file.
 *
 * Pure and exported, so the decision is testable without a server -- the caller's half is reading
 * the response, this half is judging it.
 */
function classifyWorkerOutput(input) {
    if ((input.content ?? '').trim() !== '')
        return { starved: false };
    if (input.finishReason === 'length') {
        return {
            starved: true,
            reason: 'the worker returned finish_reason "length" with empty content, so its token budget was ' +
                'exhausted before it emitted anything. This is token starvation rather than an empty edit: a ' +
                'reasoning model whose thinking is enabled at the host spends the whole budget on ' +
                'reasoning_content and returns no answer. Check the per-model thinking setting on the local ' +
                'server for this model and re-run the unit. The contract was not run.',
        };
    }
    return {
        starved: true,
        reason: 'the worker returned finish_reason "' +
            String(input.finishReason ?? '(absent)') +
            '" with empty content, so it reported the turn finished and emitted nothing. There is no file to ' +
            'write and no contract to run, so this is a unit that produced nothing rather than a unit that ' +
            'changed nothing. Re-run it; if it repeats, check what the model is doing with its budget on the ' +
            'local server. The contract was not run.',
    };
}
/**
 * The most of a non-2xx response body that may enter a message.
 *
 * This is the one string in the pipeline whose length nothing upstream bounds: `response.text()`
 * returns whatever the server sent, so an LM Studio traceback, a proxy's HTML error page or a
 * misrouted endpoint can append megabytes to a message that then enters the conversation and is
 * re-sent on every later turn. The worker's own completion is capped by `max_tokens` and the
 * verification log by `parseTestOutput`; this closes the third door, at the same 2000 characters so
 * there is one number to remember for "how much raw text can reach the architect".
 *
 * The full body is not persisted, deliberately. A verification log is the worker's work product and
 * is kept on disk; an error page is diagnostic text whose first 2000 characters already carry the
 * status, the content type and the first failure. Copying it to disk would replace one unbounded
 * write with another to fix a display problem.
 */
exports.MAX_ERROR_BODY_CHARS = 2000;
/** Bound a diagnostic body before appending it to a message. Never throws, and never grows it. */
function truncateErrorBody(text) {
    const body = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
    return body.length > exports.MAX_ERROR_BODY_CHARS
        ? body.slice(0, exports.MAX_ERROR_BODY_CHARS) + ' [truncated]'
        : body;
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
            // Capped at the append point rather than at the read: the body is diagnostic text, and a
            // traceback or an HTML error page is not a transcript worth carrying into every later turn.
            const errText = await response.text();
            return {
                success: false,
                status: 'ERROR',
                message: 'LM Studio returned HTTP ' + response.status + ': ' + truncateErrorBody(errText),
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
        // Checked HERE, at the ingestion point, rather than downstream. Every later stage reads a starved
        // response as an ordinary empty one: emission reports no files and no errors, the contract passes
        // over an unchanged tree, and the unit settles as SUCCESS. Failing at the point the response is
        // parsed is what keeps that from becoming a verdict.
        const starvation = classifyWorkerOutput({
            finishReason: data.choices?.[0]?.finish_reason,
            content,
        });
        if (starvation.starved) {
            return {
                success: false,
                status: 'WORKER_OUTPUT_STARVED',
                message: 'The delegation produced no output: ' + starvation.reason,
                resolvedWorkspace: workspaceBase,
                filesWritten: [],
                workerFinishReason: data.choices?.[0]?.finish_reason ?? null,
                testResults: {
                    passed: 0,
                    failed: 0,
                    output: 'The worker returned no content, so the contract was not run.',
                },
                tokens: { prompt: promptTokens, completion: completionTokens },
            };
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
        // How many times the contract runs, and how many it actually took. The second is reported so a reader
        // can tell a full consensus pass from one that short-circuited, which is the difference between
        // "agreeing three times" and "failing immediately" -- the same verdict, different amounts of evidence.
        const verificationRepeats = resolveVerificationRepeats(params.verificationRepeats);
        let verificationAttempts = 0;
        // Set when repeated runs of the same contract disagreed with each other.
        let flaky = false;
        // THE ANCHOR IS FROZEN BEFORE A COMMAND RUNS, NOT READ AFTERWARDS. `baseCommit` used to be read when
        // the attestation plan was built, which is after the unit's verification AND the project's coherence
        // command have both executed. A command that commits, checks out or stashes therefore moved HEAD
        // underneath the record, and the envelope named the commit the workspace landed on rather than the one
        // the unit's files were written against. Nothing downstream can catch that: the commit it names is a
        // real commit and a real ancestor of main, so every check the ledger audit makes passes. The parity
        // read below is what turns it into a refusal.
        //
        // Read ONLY when a signing key is configured, for the same reason the plan reads it that way: a host
        // that does not attest must not pay for git subprocesses it never asked for.
        const anchorBeforeCommands = params.attestationPrivateKeyPath
            ? readBaseCommit(workspaceBase)
            : null;
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
                // A non-deterministic oracle -- a property test, a concurrency harness -- can pass a broken
                // implementation on the run where the defect did not trigger, and a pass is what settles a file.
                // Repeating the contract and requiring the runs to AGREE is what turns that from a silent false
                // green into a verdict, without the plugin needing to know which oracles are deterministic.
                //
                // The loop short-circuits ONLY on disagreement, because disagreement is the one outcome that
                // cannot be changed by running more. Consensus cannot be established early: a contract that
                // agreed twice and flipped on the third run is flaky, so both PASS and FAIL have to spend the
                // whole budget to mean what they say.
                //
                // Exiting early on a first-run failure was the first version of this loop, and it was a bug in
                // the direction that matters. A race that happened to lose on runs 1 and 2 would be reported as
                // UNIT_FAILED -- a deterministic regression -- which is exactly the non-determinism this state
                // exists to expose. `FAIL` here means "failed every time we looked", not "failed once".
                //
                // The disagreement check is against the FIRST run rather than the previous one, so PASS-then-FAIL
                // and FAIL-then-PASS both land on FLAKY: two runs, one disagreement, and the same truthful label.
                const repeats = verificationRepeats;
                const first = (0, verification_1.runSandboxVerification)(params.runVerification, workspaceBase, {
                    redact: params.redactVerification ?? process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION !== '1',
                    rawLogPath: path.join((0, logging_1.resolveDataDir)(), 'last-verification.log'),
                    timeoutMs: policy.timeoutMs,
                });
                testResults = first;
                const firstPassed = first.failed === 0;
                let attempts = 1;
                for (let attempt = 1; attempt < repeats; attempt++) {
                    const next = (0, verification_1.runSandboxVerification)(params.runVerification, workspaceBase, {
                        redact: params.redactVerification ?? process.env.DSH_LOCAL_ROUTER_RAW_VERIFICATION !== '1',
                        rawLogPath: path.join((0, logging_1.resolveDataDir)(), 'last-verification.log'),
                        timeoutMs: policy.timeoutMs,
                    });
                    attempts++;
                    if ((next.failed === 0) !== firstPassed) {
                        flaky = true;
                        break;
                    }
                }
                verificationAttempts = attempts;
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
        // The parity half of the freeze above, taken after the last command that could move HEAD has run.
        // `null` on both sides means git was never asked, so a host without attestation pays nothing. Both
        // observations are handed to the planner, which decides -- the caller's half is gathering, and
        // comparing them here would be a second place for the rule to live.
        const anchorAfterCommands = params.attestationPrivateKeyPath
            ? readBaseCommit(workspaceBase)
            : null;
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
            // A contract that contradicted itself cannot be a success, whichever way the disagreement fell.
            // `testResults` is the first run, so without this clause a flaky oracle that happened to pass on
            // attempt one would read as a pass -- which is precisely the false green this state exists for.
            !flaky &&
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
        // Three outcomes, not two. An unverified unit is deliberately not a success in this plugin, but it
        // is not a failure either -- and counting it as one would inflate the very figure this field exists
        // to produce, because an edit delegated without a verification command is the common case.
        //
        // `neverRan` is the second way a contract goes unchecked, and it was missing from this expression
        // long enough to be found by running a real delegation rather than by reading it. The first way is
        // `unverified` -- no command was supplied. The second is `verificationGate` -- a command WAS supplied
        // and the gate stopped it, typically because approval was not granted. Both mean the contract was
        // never checked, which is what `resolveDelegateStatus` has always said at its own guard clause, so
        // this asks the same question it asks rather than inventing a second answer to it.
        //
        // Collapsing the gate case into UNIT_FAILED was not a cosmetic mislabel. `UNIT_FAILED` is what
        // `evaluateSettledFile` renders as "the unit that wrote it failed verification", so a file whose
        // tests passed but which was never allowed to run them was reported to the architect as having
        // failed -- a claim about content that nothing had established either way.
        const neverRan = Boolean(verificationGate) || unverified;
        // Four outcomes, and FLAKY is checked before PASSED for the reason it exists: a contract that
        // disagreed with itself has not established anything about the content, and the run it agreed with
        // itself on is exactly the run that could have passed a broken implementation. Reporting either
        // UNIT_PASSED or UNIT_FAILED here would pick one arbitrary run and present it as the verdict.
        const unitOutcome = flaky
            ? 'UNIT_FLAKY'
            : unitSuccess
                ? 'UNIT_PASSED'
                : neverRan
                    ? 'UNIT_UNVERIFIED'
                    : 'UNIT_FAILED';
        // Recorded here rather than when the model answered, because the OUTCOME is the point. A unit that
        // failed is a failed attempt, and without that the ledger cannot say how much churn the architect
        // never had to see. `unitSuccess` is the unit's own verdict, matching what `resolveDelegateStatus`
        // is given, so a coherence failure does not read as a failed attempt by this unit.
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
                outcome: unitOutcome,
                succeeded: unitSuccess,
                bytesWritten: filesWritten.reduce((sum, f) => sum + (f.bytes || 0), 0),
            });
        }
        // The registry was written before the verification ran, so the record it holds cannot carry the
        // verdict. This is the second half of that write, and the only thing that joins a per-file sha256 to
        // a per-unit verdict. One expression feeds both records deliberately: the ledger and the registry
        // must not be able to disagree about what happened.
        if (filesWritten.length > 0) {
            (0, contracts_1.recordDelegatedOutcome)(filesWritten.map((f) => f.path), unitOutcome, unitSuccess);
        }
        // A signed generation record, when the operator has provisioned a key. Opt-in, so an
        // unconfigured host runs exactly the path it ran before: no key read, no subprocess, no field.
        //
        // WHAT THE SIGNATURE IS WORTH, restated where it is produced. It binds the artifacts and the
        // verification result to a KEY, so it is evidence against anyone who does not hold that key and
        // evidence of nothing against anyone who does. It is not third-party non-repudiation, and the
        // local model never holds a key to sign with.
        //
        // WITHHELD RATHER THAN WEAKENED. If the key cannot be read, or the workspace is not a repository
        // and the commit cannot be read, nothing is signed and the reason is reported. An envelope
        // anchored to a guessed commit would verify perfectly while attesting to a tree that never
        // existed -- worse than an absent record, because it looks like a complete one.
        // Resolved HERE rather than at the return, because the attestation needs it: a record of a unit
        // that did not succeed is the one thing that must never be signed, and the status has to exist
        // before the envelope is built to be able to refuse it. One expression feeds both, so the status a
        // caller reads and the status the envelope was gated on cannot drift apart.
        const delegateStatus = resolveDelegateStatus({
            verificationGate,
            unverified,
            contractViolations: contractViolationsFound,
            isSuccess: unitSuccess,
            coherenceFailed,
            flaky,
        });
        let attestation;
        let attestationSkipped;
        /** The commit the envelope anchors to, kept so the note write does not re-parse the payload. */
        let attestedCommit;
        {
            // Gathering is this caller's half; deciding is `buildAttestationPlan`'s. That function is pure
            // and tested without a repository, a key file or a subprocess, which is what makes the withheld
            // paths -- the ones that are hardest to arrange for real -- reachable by a test.
            const privateKeyPath = params.attestationPrivateKeyPath;
            let privateKeyPem = null;
            if (privateKeyPath) {
                try {
                    privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
                }
                catch {
                    privateKeyPem = null;
                }
            }
            const plan = (0, crypto_attestation_1.buildAttestationPlan)({
                privateKeyPath,
                privateKeyReadable: privateKeyPem !== null,
                // A label for locating the record, not a security property: derived from what the delegation
                // already knows, so the same unit is findable by the same id.
                runId: 'turn-' + String(params.turnId ?? 0) + '-' + String(params.taskName || 'subtask'),
                // Read only when the feature is in use: an unconfigured host must not pay for a git
                // subprocess on every delegation, and must not acquire a git dependency it never asked for.
                // The value is the FROZEN anchor from before the commands ran, not a fresh read -- the parity
                // check above is what makes it trustworthy, and it withholds rather than signing if the two
                // reads disagree.
                baseCommit: privateKeyPath ? anchorBeforeCommands : null,
                headObserved: privateKeyPath
                    ? { before: anchorBeforeCommands, after: anchorAfterCommands }
                    : null,
                modelIdentifier: String(model || ''),
                // The unit's own outcome. A record is only worth signing for work that landed, so this is the
                // first thing `buildAttestationPlan` refuses on after the environment questions resolve.
                status: delegateStatus,
                contracts: contractPaths.map((p) => ({
                    path: path.relative(workspaceBase, p) || p,
                    sha256: contractAfter[(0, paths_1.canonicalisePath)(p)] ?? null,
                })),
                artifacts: filesWritten.map((f) => ({
                    path: f.relativeName || f.path,
                    // Re-read from disk rather than trusting the emission record: the hash must describe the
                    // bytes that are there now, which is the same reason the registry re-hashes on read.
                    sha256: (0, contracts_1.sha256File)(f.path),
                })),
                verification: {
                    command: String(params.runVerification || ''),
                    executed: verificationAttempts > 0,
                    // The observed status, or null when none was observed. The plan carries a null through as
                    // -1; nothing on this path coerces it to 0.
                    exitCode: testResults?.exitCode ?? null,
                    // The digest binds what was REPORTED. The raw log deliberately stays local, so this is not
                    // a digest of the evidence behind it -- a limit stated where the payload is built.
                    output: testResults?.output ?? '',
                    failed: testResults?.failed ?? 1,
                },
            });
            if (plan.action === 'sign' && privateKeyPem) {
                attestation = (0, crypto_attestation_1.signManifest)(plan.payload, privateKeyPem, (0, crypto_attestation_1.publicKeyFromPrivate)(privateKeyPem));
                attestedCommit = plan.payload.baseCommit;
            }
            else if (plan.action === 'withheld') {
                attestationSkipped = plan.reason;
            }
        }
        // Storing the record is a SEPARATE opt-in from signing it. A notes ref configured with no record
        // to store is a misconfiguration, and naming it beats a silent no-op.
        let attestationNotesStatus;
        if (params.attestationNotesRef) {
            if (!attestation || !attestedCommit) {
                attestationNotesStatus = {
                    written: false,
                    reason: 'no envelope was produced, so there was nothing to store. Storing a record requires a signing key.',
                };
            }
            else {
                attestationNotesStatus = writeDelegationNote(workspaceBase, params.attestationNotesRef, attestedCommit, attestation);
            }
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
            // Reported so a consensus pass can be told from a short-circuit: the same verdict, different
            // amounts of evidence behind it.
            ...(verificationAttempts > 0
                ? { verificationRuns: verificationAttempts, verificationRepeats }
                : {}),
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
            // The signing record when one was produced, and the reason when one was withheld. Reported
            // rather than silent: a configured key that never signs is a failure the caller cannot see.
            ...(attestation ? { attestation } : {}),
            ...(attestationSkipped ? { attestationSkipped } : {}),
            ...(attestationNotesStatus ? { attestationNotesStatus } : {}),
            tokens: {
                prompt: promptTokens,
                completion: completionTokens,
            },
            ...(coherenceResults ? { coherenceResults } : {}),
            summary: summaryText,
            // Already resolved above, where the attestation was gated on it. Recomputing it here would give
            // two call sites the chance to disagree about the same unit.
            status: delegateStatus,
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
