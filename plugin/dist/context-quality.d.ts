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
export interface ContextQuality {
    /** Turns opened in this process. */
    turns: number;
    /** Steps opened in this process. */
    steps: number;
    /** Compactions that produced a summary -- the model-assisted kind. */
    compactions: number;
    /** Model-free prunes. Counted separately because they cost no model call. */
    prunes: number;
    /**
     * Compactions that ended with an error. Worth counting separately: a failed compaction leaves the
     * window exactly as bloated as it was, so it is the opposite of the thing this measures.
     */
    failedCompactions: number;
    /** Tokens the host reported as shadowed -- reclaimed -- by summaries and prunes. */
    tokensReclaimed: number;
}
export declare const EMPTY_CONTEXT_QUALITY: ContextQuality;
/** Fold one session event into the counters. Pure; returns `state` unchanged when it does not care. */
export declare function foldContextQuality(state: ContextQuality, event: any): ContextQuality;
/** One line, for a `CONTEXT_QUALITY` trace entry. Never multi-line: it is a trace payload. */
export declare function describeContextQuality(state: ContextQuality): string;
