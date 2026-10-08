/**
 * The Cordis hooks this plugin subscribes to, checked against the host's own `Events` interface.
 *
 * `ctx.on` was always invoked through `any`, so a name the host has never heard of compiled cleanly and
 * then failed silently for the whole life of the plugin. Three subscriptions were deleted for exactly
 * that: `agent/post-step` and `agent/step-finish` do not exist in the installed host at all, and
 * `agent/assistant-stream` exists but its frames carry no `usage`. A fourth, `ctx.on('tool/call')`, turned
 * out to be a *session event* being subscribed to as if it were a hook. None of them could ever have
 * fired, and nothing anywhere said so -- a subscription to a nonexistent event is invisible in a way that
 * a wrong payload shape is not.
 *
 * `onHost` makes the name a checked thing: `K extends keyof Events`, with `Events` augmented by the host
 * packages imported below. A subscription the host does not offer becomes a compile error naming the
 * literal. That is the same contract `session-events.ts` provides for session event TYPES, applied to
 * hook NAMES -- the half of the host contract that was still open.
 *
 * The package imports are type-only and load-bearing. A `declare module '@deepseek-ai/cordis'`
 * augmentation applies only if its module is part of the program, so importing the packages that declare
 * the events being subscribed to is what makes `keyof Events` the host's real vocabulary rather than an
 * empty interface. They emit nothing into `dist/`.
 */
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { Events } from '@deepseek-ai/cordis'

/**
 * Subscribe to a host event, with the event NAME and the handler's SHAPE both taken from the host.
 *
 * `OmitThisParameter` is load-bearing rather than cosmetic. Several host events declare `this:
 * Scoped<Agent>` or `this: Scoped<Session>`, and Cordis binds that itself; a plain arrow function has
 * `this: void` and would be rejected for a `this` it never uses. Stripping the parameter keeps the real
 * arguments and the return type, which are the parts a handler can get wrong.
 *
 * Declaring the handler this way is what makes the payloads checked: a handler written as
 * `(payload, next) => …` with no annotations now has both parameters inferred from the host's own
 * signature, so reading a field the host does not send is a compile error. Handlers that still annotate
 * `any` compile as before -- the check is available, not enforced by force.
 */
export function onHost<K extends keyof Events>(
  ctx: any,
  event: K,
  handler: OmitThisParameter<Events[K]>,
  options?: any
): void {
  if (typeof ctx?.on !== 'function') return
  // The optional third argument is Cordis's own listener options (`{ prepend: true }` is used by the DLP
  // and routing hooks, which must see a request before anything else does). Passed through rather than
  // dropped: a wrapper that silently changes dispatch order is a worse bug than the one it is preventing.
  if (options === undefined) ctx.on(event as any, handler)
  else ctx.on(event as any, handler, options)
}
