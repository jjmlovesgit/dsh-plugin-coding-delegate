/**
 * The session events this plugin reads, checked against the host's own type map.
 *
 * Until this module existed the event names were strings written by hand in two places -- the fold in
 * `context-quality.ts` and the trace filter in `index.ts` -- and neither was checked against anything. A
 * DSH release could rename an event and the plugin would keep compiling, keep running, and quietly stop
 * counting, with no test able to notice: the oracles encode the same assumptions as the code they test.
 *
 * `satisfies readonly SessionEventType[]` is the fix. `SessionEventType` is the host's own
 * `keyof SessionEventMap`, so a name the host no longer declares is a compile error that names the
 * offending literal. That is what the `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-compaction`
 * devDependencies are for, and why their versions are pinned exactly rather than with a caret: a pinned
 * type package that drifts from the running host describes a host that does not exist, which is worse
 * than no check at all. `scripts/check-host-types-pin.cjs` exists to catch exactly that drift.
 *
 * `import type {} from '@deepseek-ai/dsh-compaction'` is load-bearing rather than decorative.
 * `dsh-compaction` declaration-merges `compaction/*` into `SessionEventMap` from a subpath, and a
 * `declare module` augmentation only applies if its module is part of the program. It is a *type* import
 * so that it emits nothing into `dist/`: a side-effect import would compile to a `require()` of a
 * devDependency that consumers of this package do not have.
 */
import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

/**
 * Events `foldContextQuality` reads. Every one of these has a `case` in that switch.
 */
const OBSERVED_EVENT_TYPES = [
  'turn/start',
  'step/start',
  'compaction/summary',
  'compaction/prune',
  'compaction/end',
  'assistant/message',
  'request/context',
] as const satisfies readonly SessionEventType[]

/**
 * The subset worth a trace line. `step/start` is folded but deliberately not traced: it fires once per
 * model call, and this plugin reads its own live evidence out of that log.
 */
const TRACED_EVENT_TYPES = [
  'turn/start',
  'assistant/message',
  'request/context',
  'compaction/summary',
  'compaction/prune',
  'compaction/end',
] as const satisfies readonly SessionEventType[]

/** One of the observed events, carrying the HOST's payload type for it rather than `any`. */
export type ObservedSessionEvent = {
  [K in (typeof OBSERVED_EVENT_TYPES)[number]]: { type: K; data: SessionEventMap[K] }
}[(typeof OBSERVED_EVENT_TYPES)[number]]

/** Runtime membership for the fold's vocabulary. `ReadonlySet<string>` so a plain `string` may be tested. */
export const OBSERVED_EVENTS: ReadonlySet<string> = new Set(OBSERVED_EVENT_TYPES)

/** Runtime membership for the traced subset, tested against the same plain `string` a firehose delivers. */
export const TRACED_EVENTS: ReadonlySet<string> = new Set(TRACED_EVENT_TYPES)
