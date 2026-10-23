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
export const RUNTIME_REFUSAL_CODE = 'REFUSED_UNSANDBOXED_RUNTIME'
export const EMPTY_REFUSAL_CODE = 'REFUSED_EMPTY_COMMAND'

export interface CommandValidationResult {
  valid: boolean
  reason?: string
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
export function validateVerificationCommand(command: string): CommandValidationResult {
  const trimmed = String(command || '').trim()
  if (!trimmed) {
    return { valid: false, reason: EMPTY_REFUSAL_CODE + ': verification command cannot be empty.' }
  }

  if (/\bnode(?:\.exe)?\s+.*?(?:--test\b|-t\b)/.test(trimmed)) {
    return { valid: false, reason: runnerRefusalMessage(trimmed) }
  }

  const binaryMatch = trimmed.match(/^(?:(?:"([^"]+)")|(\S+))/)
  const binaryToken = binaryMatch ? binaryMatch[1] || binaryMatch[2] : ''
  // A quoted path arrives as one token; an UNQUOTED Windows path with spaces arrives split, and the
  // token comparison can only see `C:\Program`. That form is accepted explicitly, because the plugin
  // runs on Windows where the default install path is exactly that, and a shell that cannot parse it
  // will fail at spawn rather than run something unexpected.
  const isNodeBinary =
    /(?:^|[/\\])node(?:\.exe)?$/i.test(binaryToken) ||
    /^[A-Za-z]:\\[^"]*[\\/]node(?:\.exe)?\s/i.test(trimmed)
  if (!isNodeBinary) {
    return { valid: false, reason: runtimeRefusalMessage(trimmed) }
  }

  return { valid: true }
}

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
