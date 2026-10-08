import type { Events } from '@deepseek-ai/cordis';
/**
 * Subscribe to a host event, with the event NAME checked at compile time.
 *
 * The handler stays loosely typed deliberately. The payload shapes are host-owned and consuming them
 * exactly is a second, larger change; the name is what failed silently before, so the name is what is
 * made checkable here.
 */
export declare function onHost<K extends keyof Events>(ctx: any, event: K, handler: (...args: any[]) => any, options?: any): void;
