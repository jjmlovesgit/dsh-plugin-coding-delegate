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
