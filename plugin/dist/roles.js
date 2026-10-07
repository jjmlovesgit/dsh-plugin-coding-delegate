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
exports.AGENT_ROLE_LIMIT = exports.DEFAULT_SOURCE_EGRESS_MIN_LINES = void 0;
exports.detectSourceEgress = detectSourceEgress;
exports.evaluateSourceEgress = evaluateSourceEgress;
exports.rememberAgentRole = rememberAgentRole;
exports.roleForAgent = roleForAgent;
exports.resetAgentRoles = resetAgentRoles;
exports.describeSourceRead = describeSourceRead;
exports.resolveLeadProviders = resolveLeadProviders;
exports.resolveAgentRole = resolveAgentRole;
exports.applyArchitectConfig = applyArchitectConfig;
exports.applyAgentRole = applyAgentRole;
const path = __importStar(require("path"));
const profiles_1 = require("./profiles");
const guard_1 = require("./guard");
const paths_1 = require("./paths");
/**
 * Fenced-block languages that count as source. Scripts are included: a deployment script is source,
 * and it is exactly the sort of thing that should not be typed into a metered cloud conversation.
 */
const SOURCE_LANGUAGES = new Set([
    'ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'mjs', 'cjs',
    'py', 'python', 'rb', 'ruby', 'php', 'java', 'kt', 'kotlin', 'scala', 'swift', 'dart',
    'cs', 'csharp', 'fs', 'fsharp', 'vb', 'go', 'rs', 'rust',
    'c', 'h', 'cpp', 'c++', 'hpp', 'cc', 'mm',
    'ps1', 'powershell', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd',
    'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte', 'lua', 'pl', 'perl', 'r',
    'ex', 'exs', 'erl', 'hs', 'clj', 'asm', 'sol',
]);
/** Blocks shorter than this are treated as quotations rather than as code being handed over. */
exports.DEFAULT_SOURCE_EGRESS_MIN_LINES = 3;
/**
 * Find fenced source blocks in an outbound payload.
 *
 * The fence is built with `\x60` escapes rather than written literally: a literal triple backtick in
 * this file makes the file unpatchable by a confined agent, because the emission scanner truncates a
 * fenced body at the first backtick run inside it. The pattern is identical at runtime.
 */
function detectSourceEgress(text, options = {}) {
    if (typeof text !== 'string' || !text)
        return { found: false, blocks: 0, languages: [] };
    const minLines = Math.max(1, Number(options.minLines ?? exports.DEFAULT_SOURCE_EGRESS_MIN_LINES));
    const languages = [];
    let blocks = 0;
    const FENCE = '\x60\x60\x60';
    const fenced = new RegExp(FENCE + '([a-zA-Z0-9_+#-]+)[ \\t]*\\n([\\s\\S]*?)' + FENCE, 'g');
    let match;
    while ((match = fenced.exec(text)) !== null) {
        const language = match[1].toLowerCase();
        if (!SOURCE_LANGUAGES.has(language))
            continue;
        const body = match[2].replace(/\n$/, '');
        if (body.split('\n').length < minLines)
            continue;
        blocks += 1;
        languages.push(language);
    }
    return { found: blocks > 0, blocks, languages };
}
/**
 * Rule 8: source may not reach the cloud. A request bound for the local worker is not egress at all,
 * so the policy never applies to it — which is the entire reason the lead tier runs locally.
 */
function evaluateSourceEgress(action, detection, destination) {
    if (destination === 'local') {
        return {
            kind: 'allow',
            reason: 'the request is bound for the local worker, so nothing is leaving the machine',
        };
    }
    if (!detection.found) {
        return { kind: 'allow', reason: 'no fenced source block was found in the outbound payload' };
    }
    const summary = detection.blocks +
        ' fenced source block(s) in the outbound payload (' +
        detection.languages.join(', ') +
        ')';
    if (action === 'allow') {
        return { kind: 'allow', reason: 'sourceEgress is allow, so ' + summary + ' will be transmitted' };
    }
    if (action === 'ask') {
        return { kind: 'ask', reason: summary + ' needs an operator decision (sourceEgress is ask)' };
    }
    return {
        kind: 'deny',
        reason: 'rule 8 refuses this request: ' +
            summary +
            ". Set sourceEgress: 'ask' to approve case by case, or 'allow' to send source to the cloud " +
            'deliberately.',
    };
}
/** Bounded, newest-wins. Built from observed requests, because the host does not say which agent is which. */
exports.AGENT_ROLE_LIMIT = 200;
const agentRoles = new Map();
/**
 * Remember which role an agent last made a request as.
 *
 * This is a correlation, not lineage: the plugin sees an `agent` on `agent/request` and an `agent` on
 * `tools/pre-execute`, and it assumes the same id means the same agent. That assumption is recorded
 * rather than trusted — an unobserved id resolves to 'unknown' and the observation says so, so the
 * record degrades honestly instead of inventing an attribution.
 */
function rememberAgentRole(agentId, role) {
    const id = String(agentId ?? '').trim();
    if (!id)
        return;
    if (agentRoles.has(id))
        agentRoles.delete(id);
    agentRoles.set(id, role);
    while (agentRoles.size > exports.AGENT_ROLE_LIMIT) {
        const oldest = agentRoles.keys().next().value;
        if (typeof oldest === 'string')
            agentRoles.delete(oldest);
    }
}
function roleForAgent(agentId) {
    const id = String(agentId ?? '').trim();
    if (!id)
        return 'unknown';
    return agentRoles.get(id) ?? 'unknown';
}
/** The map is module state, so tests need a way to clear it. */
function resetAgentRoles() {
    agentRoles.clear();
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
function describeSourceRead(input) {
    const role = input?.role ?? 'unknown';
    const tool = String(input?.tool ?? '').trim().toLowerCase();
    if (!guard_1.READ_TOOLS.has(tool)) {
        return { track: false, role, reason: `'${tool || 'unknown tool'}' is not a read tool` };
    }
    const target = String(input?.target ?? '').trim();
    if (!target)
        return { track: false, role, reason: 'no target to attribute' };
    const extension = path.extname(target).toLowerCase();
    if (!paths_1.CODE_EXTENSIONS.has(extension)) {
        return { track: false, role, target, extension, reason: 'not a source file' };
    }
    return {
        track: true,
        role,
        target,
        extension,
        reason: `source read attributed to ${role}`,
    };
}
/**
 * Which providers are the lead tier? `leadTier` derives the list from the LEAD profile so the provider
 * id is declared in one place; an explicit `leadProviders` list always wins.
 *
 * Takes a structural type rather than `PluginConfig`: importing that would be a cycle, because
 * `index.ts` imports this module, and every field read here is optional anyway.
 */
function resolveLeadProviders(options = {}) {
    if (Array.isArray(options.leadProviders) && options.leadProviders.length > 0) {
        return options.leadProviders;
    }
    return options.leadTier ? [profiles_1.PROFILES.LEAD.provider] : [];
}
function resolveAgentRole(input) {
    const host = String(input.hostProvider ?? '')
        .trim()
        .toLowerCase();
    const declared = (input.leadProviders ?? [])
        .map((p) => String(p ?? '').trim().toLowerCase())
        .filter(Boolean);
    if (!host) {
        return {
            role: 'architect',
            reason: 'the host resolved no provider, so the architect default applies',
        };
    }
    if (declared.includes(host)) {
        return {
            role: 'lead',
            reason: `provider '${host}' is declared as a non-architect (lead) provider`,
        };
    }
    return { role: 'architect', reason: `provider '${host}' is not declared as a lead provider` };
}
/**
 * The architect's request treatment: pin the provider, uncap the window, supply the tool and the role
 * instruction. Extracted from the hook so the behaviour is testable without a host.
 *
 * Deliberately unchanged: the instruction is only injected into a `system` string or a `messages`
 * array. A request carrying neither is left without it, because inventing a field the host may not
 * read would be a silent no-op dressed up as a fix.
 */
function applyArchitectConfig(requestConfig, options = {}) {
    // A tripped DLP under dlpAction 'local' pins this request to the local provider instead of the cloud.
    const mutatedConfig = {
        ...(requestConfig || {}),
        provider: options.rerouteLocal ? options.localProvider : options.cloudProvider,
        model: options.rerouteLocal ? options.localModel : options.cloudModel,
    };
    // Uncap the context window for the cloud architect.
    delete mutatedConfig.contextWindow;
    delete mutatedConfig.maxTokens;
    delete mutatedConfig.max_tokens;
    delete mutatedConfig.max_completion_tokens;
    delete mutatedConfig.apiKey;
    // Inject the `delegate_worker` tool definition for the architect thread.
    if (Array.isArray(mutatedConfig.tools)) {
        const hasWorker = mutatedConfig.tools.some((t) => (t?.function?.name || t?.name) === 'delegate_worker');
        if (!hasWorker && options.workerTool)
            mutatedConfig.tools.push(options.workerTool);
    }
    else if (options.workerTool) {
        mutatedConfig.tools = [options.workerTool];
    }
    if (options.architectInstruction) {
        if (typeof mutatedConfig.system === 'string') {
            if (!mutatedConfig.system.includes('delegate_worker')) {
                mutatedConfig.system += '\n\n' + options.architectInstruction;
            }
        }
        else if (Array.isArray(mutatedConfig.messages)) {
            const sysMsg = mutatedConfig.messages.find((m) => m.role === 'system');
            if (sysMsg) {
                if (typeof sysMsg.content === 'string' && !sysMsg.content.includes('delegate_worker')) {
                    sysMsg.content += '\n\n' + options.architectInstruction;
                }
            }
            else {
                mutatedConfig.messages.unshift({
                    role: 'system',
                    content: options.architectInstruction,
                });
            }
        }
    }
    return mutatedConfig;
}
/**
 * Apply the role. A lead request is returned unchanged: the plugin's job is to enforce boundaries, not
 * to reinvent a preset it did not write.
 */
function applyAgentRole(requestConfig, role, architectOptions = {}) {
    if (role.role === 'lead')
        return { ...(requestConfig || {}) };
    return applyArchitectConfig(requestConfig, architectOptions);
}
