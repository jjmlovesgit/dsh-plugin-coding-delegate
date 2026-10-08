"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onHost = onHost;
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
function onHost(ctx, event, handler, options) {
    if (typeof ctx?.on !== 'function')
        return;
    // The optional third argument is Cordis's own listener options (`{ prepend: true }` is used by the DLP
    // and routing hooks, which must see a request before anything else does). Passed through rather than
    // dropped: a wrapper that silently changes dispatch order is a worse bug than the one it is preventing.
    if (options === undefined)
        ctx.on(event, handler);
    else
        ctx.on(event, handler, options);
}
