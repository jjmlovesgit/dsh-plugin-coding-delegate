import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { SavingsTracker, delegateWorker } from '../src/index'

/**
 * A verification command that moves HEAD must not produce a signed record.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM THE PLAN TESTS. `buildAttestationPlan` is pure, and its drift
 * gate can be tested by handing it two commits that differ. That test cannot fail if the caller never
 * reads HEAD twice -- a pure function can be perfectly correct while its call site is missing, and this
 * repository has already paid for that once (see the A2 relative-path defect in `docs/findings.md`).
 * The half that actually protects anything is the WIRING: HEAD read before the commands run, read again
 * after, and both observations handed to the planner. So this test drives `delegateWorker` against a real
 * git repository whose verification command really does commit, and asserts the record is refused.
 *
 * THE DEFECT BEING PINNED. `baseCommit` used to be read when the plan was built, which is after the unit
 * verification and the project coherence check have both run. A command that commits, checks out or
 * stashes moved HEAD underneath the record, and the envelope named the commit the workspace landed on
 * rather than the one the unit's files were written against. Nothing downstream can catch that: the
 * commit it names is real and is an ancestor of main, so every check the ledger audit makes passes.
 */

/** Permits the command outright, so the verification command actually runs. */
const ALLOW = { mode: 'allow' as const, allowlist: [], timeoutMs: 30000 }

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A real repository with a real HEAD, because an unborn HEAD cannot move. */
function makeRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
  git(dir, ['init', '-q'])
  git(dir, [
    '-c',
    'user.email=drift@example.test',
    '-c',
    'user.name=Drift Test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ])
  return dir
}

/** A readable signing key, so the only thing that can refuse the record is the drift gate. */
function writeSigningKey(dir: string): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const keyPath = path.join(dir, 'signer.pem')
  fs.writeFileSync(keyPath, String(privateKey.export({ type: 'pkcs8', format: 'pem' })))
  return keyPath
}

function reply(content: string, finishReason = 'stop') {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  }
}

const EMITS_A_FILE = '```typescript file="src/ok.ts"\nexport const ok = 1\n```'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attestation anchor: HEAD is frozen before the verification commands run', () => {
  it('refuses to attest when the verification command commits, and says which commits', async () => {
    const dir = makeRepo('lr-drift')
    const keyPath = writeSigningKey(dir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(EMITS_A_FILE)))

    const before = git(dir, ['rev-parse', 'HEAD']).trim()

    // A second commit, created here rather than by the command under test: the sandbox refuses
    // non-node verification commands and forbids child_process inside them, so the command cannot run
    // git. It does not need to — moving HEAD is the behaviour under test, and writing .git/HEAD to an
    // existing commit moves it just as a commit would.
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'drift-target'])
    const driftTarget = git(dir, ['rev-parse', 'HEAD']).trim()
    git(dir, ['reset', '-q', '--hard', before])

    const res: any = await delegateWorker(
      {
        taskName: 'Drift',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: dir,
        // The command under test. It passes, it writes the file the unit was asked for, and it moves
        // HEAD -- which is exactly the shape of a test hook or a command that tidies up after itself.
        runVerification: 'node -e "require(\'fs\').writeFileSync(\'.git/HEAD\', \'' + driftTarget + '\')"',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: keyPath,
      },
      new SavingsTracker(dir)
    )

    // The verification itself passed: the drift, not a failure, is what withholds the record.
    expect(res.testResults.failed).toBe(0)
    // ...and HEAD really did move, so the assertion below is about a state that occurred.
    const after = git(dir, ['rev-parse', 'HEAD']).trim()
    expect(after).not.toBe(before)

    expect(res.attestation).toBeUndefined()
    expect(String(res.attestationSkipped)).toContain('HEAD_DRIFT_DETECTED')
    expect(String(res.attestationSkipped)).toContain(before.slice(0, 8))
    expect(String(res.attestationSkipped)).toContain(after.slice(0, 8))
  })

  it('signs, anchored to the pre-command commit, when HEAD does not move', async () => {
    // The control. Without it, a gate that refused every record would pass the test above.
    const dir = makeRepo('lr-nodrift')
    const keyPath = writeSigningKey(dir)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(EMITS_A_FILE)))

    const before = git(dir, ['rev-parse', 'HEAD']).trim()

    const res: any = await delegateWorker(
      {
        taskName: 'NoDrift',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: dir,
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
        attestationPrivateKeyPath: keyPath,
      },
      new SavingsTracker(dir)
    )

    expect(res.attestationSkipped).toBeUndefined()
    expect(res.attestation).toBeDefined()
    // The recorded anchor is the commit the work was written against, not whatever HEAD is now.
    const payload = JSON.parse(String(res.attestation.payload))
    expect(payload.baseCommit).toBe(before)
    expect(payload.artifacts.map((a: any) => a.path)).toEqual(['src/ok.ts'])
    expect(payload.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
