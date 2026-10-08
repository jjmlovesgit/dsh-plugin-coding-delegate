"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onHost = onHost;
/**
 * Subscribe to a host event, with the event NAME checked at compile time.
 *
 * The handler stays loosely typed deliberately. The payload shapes are host-owned and consuming them
 * exactly is a second, larger change; the name is what failed silently before, so the name is what is
 * made checkable here.
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
