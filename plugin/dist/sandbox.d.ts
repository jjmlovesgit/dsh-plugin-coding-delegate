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
export interface CommandValidationResult {
    valid: boolean;
    reason?: string;
}
/**
 * The runtime gate. Everything below is refused before a shim is written or a process spawned.
 *
 * THE RUNTIME IS PART OF THE BOUNDARY, not an implementation detail: `NODE_OPTIONS`, the permission
 * flags and the preload reach node processes only. A `python -c …` or `sh -c …` verification would run
 * with the operator's full rights while the attestation claimed isolation, so it is refused rather than
 * run. A boundary that can be sidestepped by changing the interpreter is a recommendation.
 *
 * THE RUNNER IS REFUSED for a different reason: `node --test` forks one child per test file, and the
 * permission model blocks that fork. Granting `--allow-child-process` would reopen the execution vector
 * the sandbox closes, so the direct form is required instead.
 *
 * Path forms are accepted deliberately, including a quoted Windows path with spaces — the plugin runs
 * on Windows, where the default install path is exactly that.
 */
export declare function validateVerificationCommand(command: string): CommandValidationResult;
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
