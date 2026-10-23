/**
 * The verification sandbox: what may run, and with what rights.
 *
 * WHY REFUSE INSTEAD OF WARN. A verification run that falls back to bare execution makes every
 * attestation that cites it misleading: the note says the work was verified, and the reader assumes it
 * was verified inside the boundary. An operator under load will not read a yellow line, so the only
 * coherent failure is a hard one that names the fix.
 *
 * WHY `node --test` IS THE THING REFUSED. The runner forks one child process per test file, and the
 * permission model blocks that fork. Granting `--allow-child-process` to make the runner work would
 * reopen the exact vector the sandbox exists to close — measured: `node --test` under `--permission`
 * reports 0 pass / 1 fail, and passes only with the flag that reopens execution.
 *
 * Direct execution is not a downgrade for these units. A Tier 1 contract is a single file that asserts
 * invariants and exits 0 or 1; it needs no reporter, no concurrency, and no IPC. Measured: a direct run
 * exits 0 on pass and 1 on failure identically.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * The preflight, loaded with `--require` before any contract or worker code runs.
 *
 * It closes what the permission model does not: prototype pollution, and sockets — Node 22's permission
 * model does not restrict network access at all. `NODE_OPTIONS` is deliberately preserved by the
 * scrubber: deleting it would let a grandchild node process start unsandboxed, which is an escape
 * dressed as hygiene.
 */
export const SANDBOX_PREFLIGHT_SOURCE = `'use strict';
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);
const deny = () => {
  const error = new Error('ERR_SANDBOX_NETWORK_DENIED: network access is forbidden during verification');
  error.code = 'ERR_SANDBOX_NETWORK_DENIED';
  throw error;
};
const net = require('node:net');
net.Socket.prototype.connect = deny;
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = () => Promise.reject(Object.assign(
    new Error('ERR_SANDBOX_NETWORK_DENIED: fetch disabled'),
    { code: 'ERR_SANDBOX_NETWORK_DENIED' }
  ));
}
delete globalThis.WebSocket;
const ALLOWED = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'NODE_ENV', 'TEMP', 'TMP', 'NODE_OPTIONS', 'PATHEXT', 'COMSPEC', 'WINDIR']);
for (const key of Object.keys(process.env)) {
  if (!ALLOWED.has(key.toUpperCase())) delete process.env[key];
}
`

/** A command that asks the multi-file test runner to execute, which cannot run under the sandbox. */
const RUNNER_STYLE = /(^|[\s;&|])node(?:\.exe)?\s+(?:--test\b|-t\b)/i

export function isRunnerStyleCommand(command: string): boolean {
  return RUNNER_STYLE.test(command)
}

export const RUNNER_REFUSAL_CODE = 'REFUSED_UNSANDBOXED_RUNNER'

/**
 * The runtime is allowed only if the command's first token is `node` (optionally `node.exe`, optionally
 * preceded by a path). Anything else is refused, because none of the sandbox travels with it:
 * `NODE_OPTIONS` is ignored by python, sh and every other interpreter, so a `python -c ...` verification
 * would run with the operator's full rights while the attestation claimed isolation. A boundary that can
 * be sidestepped by changing the interpreter is a recommendation, not a boundary.
 */
export function isDirectNodeCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const token = trimmed.startsWith('"')
    ? trimmed.slice(1, trimmed.indexOf('"', 1) === -1 ? trimmed.length : trimmed.indexOf('"', 1))
    : trimmed.split(/\s+/)[0]
  const base = (token.split(/[\\/]/).pop() || '').toLowerCase()
  if (base !== 'node' && base !== 'node.exe') return false
  // `node` alone runs nothing; a script (or -e/-p) must follow.
  return trimmed.slice(trimmed.indexOf(token) + token.length).trim().length > 0
}

export const RUNTIME_REFUSAL_CODE = 'REFUSED_UNSANDBOXED_RUNTIME'

export function runtimeRefusalMessage(command: string): string {
  const runtime = command.trim().split(/\s+/)[0] || '(empty)'
  return (
    RUNTIME_REFUSAL_CODE + ": verification runtime '" + runtime + "' is not covered by the process " +
    'sandbox. The environment scrubbing, socket severing and permission flags reach node processes ' +
    'only, so any other interpreter would run with the operator\'s full rights while the attestation ' +
    'claimed isolation.\n' +
    '\nRemediation: run the check as a direct node script that asserts and exits 0 or 1:\n' +
    '  refused: ' + command + '\n' +
    '  allowed: node <your-contract>.cjs'
  )
}

/** The refusal text, written to be enough to fix the command without reading source. */
export function runnerRefusalMessage(command: string): string {
  return (
    RUNNER_REFUSAL_CODE +
    ": verification commands using 'node --test' cannot run under the isolation sandbox, because the " +
    'runner forks a child process per test file and the permission model forbids that fork. Granting ' +
    'the fork would reopen the execution vector the sandbox closes.\n' +
    '\nRemediation: convert the contract to direct execution, which asserts and exits 0 or 1:\n' +
    '  old: ' + command + '\n' +
    '  new: ' + command.replace(/\bnode(?:\.exe)?\s+(?:--test\b|-t\b)\s*/i, 'node ') + '\n' +
    'Direct contracts must assert their invariants and exit non-zero on failure.'
  )
}

/**
 * The environment a verification subprocess runs under: the permission model scoped to the workspace,
 * plus the preflight. The shim is written per call and removed by `cleanup`, so nothing is left in the
 * workspace and the package needs no non-TypeScript asset.
 */
export function sandboxEnv(workspaceDir: string): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sandbox-'))
  const shim = path.join(dir, 'preflight.cjs')
  fs.writeFileSync(shim, SANDBOX_PREFLIGHT_SOURCE, 'utf8')
  const temp = os.tmpdir()
  const flags = [
    '--permission',
    // The shim lives outside the workspace, so its directory needs READ access or `--require` fails
    // before any contract runs ("Access to this API has been restricted"). Measured: without this the
    // whole verification fails with that message, which looks like the contract's fault and is not.
    '--allow-fs-read=' + dir,
    '--allow-fs-read=' + workspaceDir,
    '--allow-fs-write=' + workspaceDir,
    // THE TEMP DIRECTORY IS DELIBERATELY ALLOWED. Contracts write counters, fixtures and logs there as a
    // matter of course, and the measured consequence of denying it was a flaky oracle reporting
    // VERIFICATION_FAILED on every run. Temp is ephemeral and holds nothing this boundary protects: the
    // repository, the home directory and the operator's keys stay unreadable, and execution stays denied.
    '--allow-fs-read=' + temp,
    '--allow-fs-write=' + temp,
    '--require=' + shim,
  ].join(' ')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, flags].filter(Boolean).join(' '),
  }
  return {
    env,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is not worth failing a verification over.
      }
    },
  }
}
