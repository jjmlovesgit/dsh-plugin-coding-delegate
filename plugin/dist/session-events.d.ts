import type { SessionEventMap } from '@deepseek-ai/dsh-session';
/**
 * Events `foldContextQuality` reads. Every one of these has a `case` in that switch.
 */
declare const OBSERVED_EVENT_TYPES: readonly ["turn/start", "step/start", "compaction/summary", "compaction/prune", "compaction/end", "assistant/message", "request/context"];
/** One of the observed events, carrying the HOST's payload type for it rather than `any`. */
export type ObservedSessionEvent = {
    [K in (typeof OBSERVED_EVENT_TYPES)[number]]: {
        type: K;
        data: SessionEventMap[K];
    };
}[(typeof OBSERVED_EVENT_TYPES)[number]];
/** Runtime membership for the fold's vocabulary. `ReadonlySet<string>` so a plain `string` may be tested. */
export declare const OBSERVED_EVENTS: ReadonlySet<string>;
/** Runtime membership for the traced subset, tested against the same plain `string` a firehose delivers. */
export declare const TRACED_EVENTS: ReadonlySet<string>;
export {};
