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
  turns: number
  /** Steps opened in this process. */
  steps: number
  /** Compactions that produced a summary -- the model-assisted kind. */
  compactions: number
  /** Model-free prunes. Counted separately because they cost no model call. */
  prunes: number
  /**
   * Compactions that ended with an error. Worth counting separately: a failed compaction leaves the
   * window exactly as bloated as it was, so it is the opposite of the thing this measures.
   */
  failedCompactions: number
  /** Tokens the host reported as shadowed -- reclaimed -- by summaries and prunes. */
  tokensReclaimed: number
  /**
   * The prompt the model actually received on the most recent model call: the window as it stood at
   * that step. Measured against a real session rather than inferred from a field name.
   *
   * Explicitly NOT `usage.inputTokens`, which is what the first version of this counter used and why
   * it was wrong. That field is only the UNCACHED portion of the prompt: a live call reported
   * `inputTokens` 228 alongside `cacheReadTokens` 659456 and `totalTokens` 661541, with
   * `input + cacheRead + output === total` exactly. Reading it as the window understates a 660k-token
   * window by a factor of about 2900 — in the direction that makes a full window look empty.
   */
  lastPromptTokens: number
  /**
   * The high-water mark of that figure. This, not the last value, is the number that forces a
   * compaction, and it is the one to compare against a window.
   */
  peakPromptTokens: number
  /** The context window the route advertised, when it advertised one. */
  contextWindow: number | null
  /**
   * The route the session's model calls are going to, as `provider/model`.
   *
   * Recorded because the counters above cannot say whether they are the *frontier* figures without it.
   * With the default two-tier configuration every session call is the architect's, so they are; with a
   * lead tier configured the session is pinned elsewhere and they are that model's instead. Labelling
   * them "frontier" without the route would be the kind of claim this project tries not to make.
   */
  route: string
}

export const EMPTY_CONTEXT_QUALITY: ContextQuality = {
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
}

/**
 * The token figure the host reported for a replaced span, or null when it is missing or unusable.
 *
 * Both fields this reads are REQUIRED by DSH's own types, so a well-formed event always carries one. A
 * missing or non-numeric value therefore means the event is not what it claims to be, and the caller
 * refuses to count it -- a completion is only counted with its receipt, so the compaction count and the
 * reclaimed-token count can never disagree about whether something happened.
 */
function shadowedTokens(data: any): number | null {
  const value = data?.shadowedTokenCount
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
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
function promptTokens(usage: any): number | null {
  const fresh = usage?.inputTokens
  if (typeof fresh !== 'number' || !Number.isFinite(fresh) || fresh < 0) return null
  const cached = usage?.cacheReadTokens
  const cacheRead = typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? cached : 0
  return fresh + cacheRead
}

/** The advertised context window, or null when absent or not a positive finite number. */
function advertisedWindow(data: any): number | null {
  const value = data?.contextWindow
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

/** Fold one session event into the counters. Pure; returns `state` unchanged when it does not care. */
export function foldContextQuality(state: ContextQuality, event: any): ContextQuality {
  const type = typeof event?.type === 'string' ? event.type : ''
  const data = event?.data

  switch (type) {
    case 'turn/start':
      return { ...state, turns: state.turns + 1 }

    case 'step/start':
      return { ...state, steps: state.steps + 1 }

    case 'compaction/summary': {
      const tokens = shadowedTokens(data)
      if (tokens === null) return state
      return {
        ...state,
        compactions: state.compactions + 1,
        tokensReclaimed: state.tokensReclaimed + tokens,
      }
    }

    case 'compaction/prune': {
      const tokens = shadowedTokens(data)
      if (tokens === null) return state
      return {
        ...state,
        prunes: state.prunes + 1,
        tokensReclaimed: state.tokensReclaimed + tokens,
      }
    }

    case 'compaction/end': {
      // `error` is present only on an unsuccessful attempt, which is the one worth counting here.
      if (typeof data?.error !== 'string' || !data.error) return state
      return { ...state, failedCompactions: state.failedCompactions + 1 }
    }

    case 'assistant/message': {
      const tokens = promptTokens(data?.usage)
      // No reported usage means no new information. Returning `state` keeps the last known window size
      // standing rather than reporting the call as free.
      if (tokens === null) return state
      return {
        ...state,
        lastPromptTokens: tokens,
        peakPromptTokens: Math.max(state.peakPromptTokens, tokens),
      }
    }

    case 'request/context': {
      const window = advertisedWindow(data)
      const provider = typeof data?.provider === 'string' ? data.provider : ''
      const model = typeof data?.model === 'string' ? data.model : ''
      const route = provider && model ? provider + '/' + model : state.route
      // Both figures are optional on this event, and it is only logged when the route or capacity
      // changes, so a repeat with nothing new must not allocate.
      if (window === null && route === state.route) return state
      return { ...state, contextWindow: window ?? state.contextWindow, route }
    }

    default:
      return state
  }
}

/** One line, for a `CONTEXT_QUALITY` trace entry. Never multi-line: it is a trace payload. */
export function describeContextQuality(state: ContextQuality): string {
  return (
    state.turns +
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
    (state.route ? ' on ' + state.route : '')
  )
}
