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
