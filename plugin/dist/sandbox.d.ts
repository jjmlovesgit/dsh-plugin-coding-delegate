/**
 * The preflight, loaded with `--require` before any contract or worker code runs.
 *
 * It closes what the permission model does not: prototype pollution, and sockets — Node 22's permission
 * model does not restrict network access at all. `NODE_OPTIONS` is deliberately preserved by the
 * scrubber: deleting it would let a grandchild node process start unsandboxed, which is an escape
 * dressed as hygiene.
 */
export declare const SANDBOX_PREFLIGHT_SOURCE = "'use strict';\nObject.freeze(Object.prototype);\nObject.freeze(Array.prototype);\nObject.freeze(Function.prototype);\nconst deny = () => {\n  const error = new Error('ERR_SANDBOX_NETWORK_DENIED: network access is forbidden during verification');\n  error.code = 'ERR_SANDBOX_NETWORK_DENIED';\n  throw error;\n};\nconst net = require('node:net');\nnet.Socket.prototype.connect = deny;\nif (typeof globalThis.fetch === 'function') {\n  globalThis.fetch = () => Promise.reject(Object.assign(\n    new Error('ERR_SANDBOX_NETWORK_DENIED: fetch disabled'),\n    { code: 'ERR_SANDBOX_NETWORK_DENIED' }\n  ));\n}\ndelete globalThis.WebSocket;\nconst ALLOWED = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'NODE_ENV', 'TEMP', 'TMP', 'NODE_OPTIONS', 'PATHEXT', 'COMSPEC', 'WINDIR']);\nfor (const key of Object.keys(process.env)) {\n  if (!ALLOWED.has(key.toUpperCase())) delete process.env[key];\n}\n";
export declare function isRunnerStyleCommand(command: string): boolean;
export declare const RUNNER_REFUSAL_CODE = "REFUSED_UNSANDBOXED_RUNNER";
export declare const RUNTIME_REFUSAL_CODE = "REFUSED_UNSANDBOXED_RUNTIME";
export declare const EMPTY_REFUSAL_CODE = "REFUSED_EMPTY_COMMAND";
export declare const SHELL_REFUSAL_CODE = "REFUSED_SHELL_OPERATORS";
export interface TokenizeResult {
    tokens: string[];
    error?: string;
}
/**
 * Tokenize a command into argv WITHOUT a shell.
 *
 * BACKSLASH IS NOT A GENERAL ESCAPE HERE, and that is a Windows-first decision: `"C:\Program
 * Files\nodejs\node.exe"` is the default install path, and treating `\P` as an escape turns it into
 * `C:Program Filesnodejsnode.exe`. A backslash is consumed only when it precedes a double quote or
 * another backslash, which handles `console.log(\"hi\")` while leaving every other path intact.
 *
 * Unbalanced quotes fail closed: with a closing quote missing, what looks like quoted text is not, and
 * guessing where it ends is how a chained command slips through.
 */
export declare function tokenizeCommand(command: string): TokenizeResult;
export declare const UNBALANCED_REFUSAL_CODE = "REFUSED_UNBALANCED_QUOTES";
export declare const SHADOW_REFUSAL_CODE = "REFUSED_SHADOW_RUNTIME";
/**
 * The oldest Node the verification sandbox is willing to be trusted on.
 *
 * THE SANDBOX IS A CONSUMER OF THE RUNTIME'S PERMISSION MODEL, so it inherits that model's bugs. Three
 * advisories matter here, all filesystem-allowlist flaws: a wildcard-rule bypass (CVE-2026-106071), a
 * radix-tree split letting sibling paths that share a prefix reach each other (CVE-2026-58043), and an
 * unchecked `fs.realpathSync.native` that resolves symlinks outside the allowlist (CVE-2026-21715). Each
 * turns `--allow-fs-read` into advice rather than a boundary.
 *
 * v22.23.4 is the first line carrying those fixes alongside the Brotli RCE (CVE-2026-111497), the DNS
 * truncation and the TLS hostname bypasses. Below it the plugin still runs — refusing to start would
 * strand operators mid-upgrade — but it says so once, plainly.
 */
export declare const MINIMUM_SANDBOX_NODE = "22.23.4";
/** Is `version` at least `minimum`? Missing parts count as zero, so `22.23` is below `22.23.4`. */
export declare function versionAtLeast(version: string, minimum: string): boolean;
/**
 * The warning printed once when verification runs below the patched line, or null.
 *
 * NOT A REFUSAL, and the reason is stated rather than hidden: the host that produced this record runs
 * 22.19.0, and a hard refusal there would block every delegation, including this repository's own
 * oracles. What it must not do is stay silent, because the sandbox's own claim is what is at stake.
 */
export declare function sandboxRuntimeWarning(version: string): string | null;
export interface ValidatedInvocation {
    valid: true;
    binary: string;
    args: string[];
}
export interface RefusedInvocation {
    valid: false;
    reason: string;
}
export type InvocationPlan = ValidatedInvocation | RefusedInvocation;
/**
 * Decide what will be executed, from the TOKENS rather than from a regex over the raw string.
 *
 * `shell: false` already makes chaining impossible, so the operator refusal is a second lock on the
 * same door: a command shaped like a chain is a sign its author expected one, and running the first
 * half silently would teach them the wrong lesson.
 */
export declare function resolveVerificationInvocation(command: string): InvocationPlan;
export declare function runtimeRefusalMessage(command: string): string;
/** The refusal text, written to be enough to fix the command without reading source. */
export declare function runnerRefusalMessage(command: string): string;
/**
 * The environment a verification subprocess runs under: the permission model scoped to the workspace,
 * plus the preflight. The shim is written per call and removed by `cleanup`, so nothing is left in the
 * workspace and the package needs no non-TypeScript asset.
 */
export declare function sandboxEnv(workspaceDir: string): {
    env: NodeJS.ProcessEnv;
    cleanup: () => void;
};
