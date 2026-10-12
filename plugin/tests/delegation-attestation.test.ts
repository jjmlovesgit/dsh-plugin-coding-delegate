import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SavingsTracker, delegateWorker } from '../src/index'
import { generateWorkerKeyPair, verifyEnvelope } from '../src/crypto-attestation'

/**
 * `execFileSync` is replaced by a spy that still DELEGATES to the real implementation: behaviour is
 * unchanged, and the call becomes observable.
 *
 * `vi.spyOn` cannot be used for this. Vitest exposes Node builtins as a non-configurable ESM
 * namespace, so redefining a property on it throws "Cannot redefine property: execFileSync". Only
 * `vi.mock` replaces the module binding rather than mutating the namespace object.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

const execSpy = child_process.execFileSync as unknown as Mock

/**
 * The attestation as it behaves through the REAL delegation path.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE UNIT TESTS. `attestation.test.ts` proves the DECISION -- given
 * these inputs, withhold or sign, and here is the payload. It cannot prove that the delegation path
 * gathers those inputs correctly, because it never runs it. The gathering is where the disk reads,
 * the git subprocess and the cross-module stitching live, and those are exactly the parts a pure
 * function cannot vouch for. Documenting the option on the strength of the unit tests alone would
 * have described an assumption rather than a measurement.
 *
 * All three runtime postures are covered: not opted in, opted in but unable to attest, and signed.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
}

/** The stub endpoint's reply, shaped like an OpenAI-compatible completion. */
function workerReply(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  }
}

/** A policy that permits the command outright, so verification actually runs. */
const ALLOW = { mode: 'allow' as const, allowlist: [], timeoutMs: 30000 }

function git(dir: string, args: string[]): string {
  return String(
    child_process.execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  )
}

/** Is `dir` inside any git work tree? Used to assert a test premise rather than assume it. */
function insideRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Initialise a repository with one commit, and return its HEAD. */
function initRepo(dir: string): string {
  try {
    child_process.execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(
      'git is required by these tests: the attestation reads the base commit from the workspace, ' +
        'and a missing git must fail loudly rather than skip the only test that proves the signed path.'
    )
  }
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'Delegation Test'])
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'seed'])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

function writeKey(dir: string): { path: string; publicKeyPem: string } {
  const keys = generateWorkerKeyPair()
  const keyPath = path.join(dir, 'delegation-signer.pem')
  fs.writeFileSync(keyPath, keys.privateKeyPem, 'utf8')
  return { path: keyPath, publicKeyPem: keys.publicKeyPem }
}

describe('delegation integration: attestation opt-out', () => {
  it('runs no git call, reads no key, and returns a verdict with no envelope and no warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(workerReply('```typescript file="src/ok.ts"\nexport const ok = 1\n```'))
    )
    const tmpDir = makeTempWorkspace('lr-attest-off')

    // `execFileSync` isolates `readBaseCommit`: it is the only execFileSync on the delegation path,
    // while verification spawns through spawnSync and so does not appear here.
    execSpy.mockClear()

    const res: any = await delegateWorker(
      {
        taskName: 'OptedOut',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        // attestationPrivateKeyPath deliberately absent: the whole point of this case.
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.attestation).toBeUndefined()
    expect(res.attestationSkipped).toBeUndefined()
    expect(res.status).toBe('SUCCESS')

    // Not "nothing happened" -- specifically that nothing on the attestation path ran.
    const gitCalls = execSpy.mock.calls.filter((call) => call[0] === 'git')
    expect(gitCalls).toEqual([])

    execSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('delegation integration: attestation withheld', () => {
  it('reports a reason and still returns a verdict when the workspace is not a repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(workerReply('```typescript file="src/ok.ts"\nexport const ok = 1\n```'))
    )
    const tmpDir = makeTempWorkspace('lr-attest-hold')
    const key = writeKey(tmpDir)

    // Guard the premise. This case asserts the withheld path, and it is only meaningful where the
    // workspace genuinely has no commit to read -- a temp directory that happened to sit inside some
    // repository would otherwise make this test pass or fail for a reason it does not name.
    expect(insideRepo(tmpDir)).toBe(false)
    // Cleared here, AFTER the premise check above: `insideRepo` itself shells out to git, and leaving
    // those calls in the log would make the anti-vacuity assertion below pass for the wrong reason.
    execSpy.mockClear()

    const res: any = await delegateWorker(
      {
        taskName: 'Withheld',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: key.path,
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.attestation).toBeUndefined()
    expect(typeof res.attestationSkipped).toBe('string')
    expect(res.attestationSkipped).toMatch(/git commit/i)

    // The delegation itself must be unaffected: a withheld attestation is a missing record, not a
    // failed unit, and refusing the whole delegation over it would make the option hostile.
    expect(res.status).toBe('SUCCESS')

    // ANTI-VACUITY. The opt-out test asserts that no git call happens; that is only worth something
    // if the same spy DOES observe one when the attestation path runs. Same harness, same spy,
    // opposite observation -- which is what stops the earlier assertion passing on a dead instrument.
    expect(execSpy.mock.calls.some((call) => call[0] === 'git')).toBe(true)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports a key that could not be read, without crashing the delegation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(workerReply('```typescript file="src/ok.ts"\nexport const ok = 1\n```'))
    )
    const tmpDir = makeTempWorkspace('lr-attest-nokey')
    const head = initRepo(tmpDir)

    const res: any = await delegateWorker(
      {
        taskName: 'MissingKey',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: path.join(tmpDir, 'absent.pem'),
      },
      new SavingsTracker(tmpDir)
    )

    // The commit resolved here, so the ONLY unresolved input is the key -- which proves the reason
    // names the input that actually failed rather than the first one that was checked.
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(res.attestation).toBeUndefined()
    expect(res.attestationSkipped).toContain('absent.pem')
    expect(res.attestationSkipped).toMatch(/could not be read/i)
    expect(res.status).toBe('SUCCESS')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('delegation integration: attestation signed', () => {
  it('returns an envelope that verifies against the derived public key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(workerReply('```typescript file="src/ok.ts"\nexport const ok = 1\n```'))
    )
    const tmpDir = makeTempWorkspace('lr-attest-sign')
    const head = initRepo(tmpDir)
    const key = writeKey(tmpDir)

    const res: any = await delegateWorker(
      {
        taskName: 'Signed',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: key.path,
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.status).toBe('SUCCESS')
    expect(res.attestationSkipped).toBeUndefined()
    expect(res.attestation).toBeDefined()

    const envelope = res.attestation
    expect(envelope.payloadType).not.toContain('in-toto')
    // The whole point: the envelope verifies against the key DERIVED from the private key the
    // operator provisioned, with no second file to disagree with the first.
    expect(verifyEnvelope(envelope)).toBe(true)
    expect(envelope.publicKeyPem).toBe(key.publicKeyPem)

    // What was actually signed, read back out of the payload the path produced.
    const payload = JSON.parse(envelope.payload)
    expect(payload.baseCommit).toBe(head)
    expect(payload.specVersion).toBe('1.0')
    expect(payload.modelIdentifier).toBeTruthy()
    // Separators are platform-dependent, so this normalises rather than assuming a slash.
    expect(payload.artifacts.map((a: any) => String(a.path).replace(/\\/g, '/'))).toContain('src/ok.ts')
    expect(payload.verification.command).toBe('node --version')
    expect(payload.verification.exitCode).toBe(0)
    expect(payload.verification.passed).toBe(true)
    expect(payload.verification.stdoutHash).toMatch(/^[0-9a-f]{64}$/)

    // Tampering with what came back must break it, which is the property the envelope exists for.
    const forged = { ...envelope, payload: envelope.payload.replace(head, '0'.repeat(40)) }
    expect(verifyEnvelope(forged)).toBe(false)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('anchors the record to the commit the workspace is on, not a caller-supplied one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(workerReply('```typescript file="src/ok.ts"\nexport const ok = 1\n```'))
    )
    const tmpDir = makeTempWorkspace('lr-attest-second')
    const first = initRepo(tmpDir)
    const key = writeKey(tmpDir)

    // A second commit, so the anchored HEAD is provably the current one rather than the only one.
    fs.writeFileSync(path.join(tmpDir, 'second.txt'), 'second\n', 'utf8')
    git(tmpDir, ['add', '.'])
    git(tmpDir, ['commit', '-m', 'second'])
    const second = git(tmpDir, ['rev-parse', 'HEAD']).trim()
    expect(second).not.toBe(first)
    // The whole point of "read, never declared": both commits exist, and the record must name the
    // one the workspace is actually on.
    expect(insideRepo(tmpDir)).toBe(true)

    const res: any = await delegateWorker(
      {
        taskName: 'Anchored',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: key.path,
      },
      new SavingsTracker(tmpDir)
    )

    expect(verifyEnvelope(res.attestation)).toBe(true)
    expect(JSON.parse(res.attestation.payload).baseCommit).toBe(second)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
