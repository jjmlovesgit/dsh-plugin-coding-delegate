import type { Events } from '@deepseek-ai/cordis';
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
export declare function onHost<K extends keyof Events>(ctx: any, event: K, handler: OmitThisParameter<Events[K]>, options?: any): void;
