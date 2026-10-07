"use strict";
/**
 * Context-quality counters: the measurement that turns this plugin's central claim into an observation.
 *
 * README is explicit that the claim is currently argued rather than shown -- "What the plugin does not
 * yet do is measure context quality; it measures tokens." This module is the missing half.
 *
 * It folds DSH's OWN session events, read from the installed packages rather than invented here:
 *
 *   dsh-session    augments `SessionEventMap` with `turn/start`, `turn/end`, `step/start`, `step/end`, ...
 *   dsh-compaction augments it with `compaction/start`, `compaction/summary`, `compaction/end`,
 *                  `compaction/prune`
 *
 * `compaction/summary` and `compaction/prune` each carry `shadowedTokenCount`: the host's own figure for
 * how much context the replacement removed, and the exact span it replaced. That is why this module
 * counts rather than estimates. The number that matters is reported by the harness, not guessed by the
 * plugin, which is the difference between evidence and a proxy.
 *
 * Two properties the fold must keep, because it runs inside a firehose handler:
 *
 * 1. **It never throws.** It is attached to every session event; an exception there would put this
 *    plugin's error into someone else's event loop. Unusable input is ignored, never fatal.
 * 2. **An uninteresting event returns the same reference.** DSH's own projections do this so the change
 *    feed stays quiet, and the same discipline here keeps a long session from allocating on every tool
 *    result it will never look at.
 *
 * A note on what these counters do NOT see: the `session/event` firehose does not publish events that
 * entered through construction (replay, fork, resume), so a resumed session is counted from the resume
 * rather than from its true beginning. That is a real limit of the measurement and is recorded in
 * `docs/findings.md` rather than glossed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_CONTEXT_QUALITY = void 0;
exports.foldContextQuality = foldContextQuality;
exports.describeContextQuality = describeContextQuality;
exports.EMPTY_CONTEXT_QUALITY = {
    turns: 0,
    steps: 0,
    compactions: 0,
    prunes: 0,
    failedCompactions: 0,
    tokensReclaimed: 0,
    lastPromptTokens: 0,
    peakPromptTokens: 0,
    contextWindow: null,
    route: '',
};
/**
 * The token figure the host reported for a replaced span, or null when it is missing or unusable.
 *
 * Both fields this reads are REQUIRED by DSH's own types, so a well-formed event always carries one. A
 * missing or non-numeric value therefore means the event is not what it claims to be, and the caller
 * refuses to count it -- a completion is only counted with its receipt, so the compaction count and the
 * reclaimed-token count can never disagree about whether something happened.
 */
function shadowedTokens(data) {
    const value = data?.shadowedTokenCount;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return null;
    return value;
}
/**
 * The prompt one model call received, or null when the record is unusable.
 *
 * `inputTokens` alone is NOT that number, and reading it as though it were is the defect this function
 * was rewritten to fix: measured on a live session, a call reported `inputTokens` 228 with
 * `cacheReadTokens` 659456 and `totalTokens` 661541, and `input + cacheRead + output === total` exactly.
 * So `inputTokens` counts only the uncached remainder, and the cached prefix — which on any caching
 * provider is most of the window — has to be added back.
 *
 * Null is load-bearing rather than cosmetic: a call that reported nothing must leave the last known
 * figure standing. Treating it as zero would render a full window as an empty one, which is the wrong
 * direction for a measurement whose whole purpose is to show the window filling up.
 */
function promptTokens(usage) {
    const fresh = usage?.inputTokens;
    if (typeof fresh !== 'number' || !Number.isFinite(fresh) || fresh < 0)
        return null;
    const cached = usage?.cacheReadTokens;
    const cacheRead = typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? cached : 0;
    return fresh + cacheRead;
}
/** The advertised context window, or null when absent or not a positive finite number. */
function advertisedWindow(data) {
    const value = data?.contextWindow;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return null;
    return value;
}
/** Fold one session event into the counters. Pure; returns `state` unchanged when it does not care. */
function foldContextQuality(state, event) {
    // The event arrives from a firehose typed `any`, so this cast is a claim rather than a guarantee, and
    // the guards inside the readers below are what keep it safe at runtime. Its value is at COMPILE time:
    // the cases and their payloads now come from the host's own `SessionEventMap`, so a renamed event or a
    // moved field fails the build instead of quietly zeroing a counter.
    if (!event || typeof event !== 'object')
        return state;
    const candidate = event;
    switch (candidate.type) {
        case 'turn/start':
            return { ...state, turns: state.turns + 1 };
        case 'step/start':
            return { ...state, steps: state.steps + 1 };
        case 'compaction/summary': {
            const tokens = shadowedTokens(candidate.data);
            if (tokens === null)
                return state;
            return {
                ...state,
                compactions: state.compactions + 1,
                tokensReclaimed: state.tokensReclaimed + tokens,
            };
        }
        case 'compaction/prune': {
            const tokens = shadowedTokens(candidate.data);
            if (tokens === null)
                return state;
            return {
                ...state,
                prunes: state.prunes + 1,
                tokensReclaimed: state.tokensReclaimed + tokens,
            };
        }
        case 'compaction/end': {
            // `error` is present only on an unsuccessful attempt, which is the one worth counting here.
            if (typeof candidate.data?.error !== 'string' || !candidate.data.error)
                return state;
            return { ...state, failedCompactions: state.failedCompactions + 1 };
        }
        case 'assistant/message': {
            const tokens = promptTokens(candidate.data?.usage);
            // No reported usage means no new information. Returning `state` keeps the last known window size
            // standing rather than reporting the call as free.
            if (tokens === null)
                return state;
            return {
                ...state,
                lastPromptTokens: tokens,
                peakPromptTokens: Math.max(state.peakPromptTokens, tokens),
            };
        }
        case 'request/context': {
            const window = advertisedWindow(candidate.data);
            const provider = typeof candidate.data?.provider === 'string' ? candidate.data.provider : '';
            const model = typeof candidate.data?.model === 'string' ? candidate.data.model : '';
            const route = provider && model ? provider + '/' + model : state.route;
            // Both figures are optional on this event, and it is only logged when the route or capacity
            // changes, so a repeat with nothing new must not allocate.
            if (window === null && route === state.route)
                return state;
            return { ...state, contextWindow: window ?? state.contextWindow, route };
        }
        default:
            return state;
    }
}
/** One line, for a `CONTEXT_QUALITY` trace entry. Never multi-line: it is a trace payload. */
function describeContextQuality(state) {
    return (state.turns +
        ' turn(s), ' +
        state.steps +
        ' step(s), ' +
        state.compactions +
        ' compaction(s), ' +
        state.prunes +
        ' prune(s), ' +
        state.failedCompactions +
        ' failed compaction(s), ' +
        state.tokensReclaimed +
        ' token(s) reclaimed, ' +
        (state.contextWindow === null
            ? state.lastPromptTokens + ' token(s) at the last call'
            : state.lastPromptTokens +
                '/' +
                state.contextWindow +
                ' token(s) at the last call') +
        (state.peakPromptTokens > state.lastPromptTokens
            ? ' (peak ' + state.peakPromptTokens + ')'
            : '') +
        (state.route ? ' on ' + state.route : ''));
}
