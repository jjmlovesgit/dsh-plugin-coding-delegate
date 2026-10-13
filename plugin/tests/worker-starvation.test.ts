import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SavingsTracker, delegateWorker } from '../src/index'
import { classifyWorkerOutput } from '../src/delegation'

/**
 * Token starvation must not settle as SUCCESS.
 *
 * WHY THIS FILE EXISTS. A worker that exhausts its budget does not fail. The server returns HTTP 200,
 * `finish_reason: 'length'`, and an empty message, and every later stage reads that as an ordinary
 * empty response: `extractAndEmitFiles('')` returns no files AND no errors, so the
 * `emission.errors.length === 0` clause in `unitSuccess` holds, the contract re-runs over a tree the
 * worker never touched and passes, and `resolveDelegateStatus` returns SUCCESS. Measured on
 * `qwen/qwen3.8-27b`: 34,076 characters of `reasoning_content` consumed the whole 8192-token budget
 * and no answer was emitted. See `docs/findings.md`.
 *
 * WIDENED SINCE. The gate was `finish_reason === 'length'` AND empty, which left the IDENTICAL empty
 * reply with `finish_reason: 'stop'` settling as SUCCESS -- the same route through
 * `extractAndEmitFiles('')`, the same empty passing run. That case was carried here as a KNOWN GAP test
 * rather than fixed, because widening the gate is an operator decision. The decision was taken, so the
 * gate is now empty-content-whatever-the-reason, and the two causes still report different remedies.
 *
 * The decision and the wiring are tested separately, and that separation is the point: a pure
 * function can be right while its call site is missing, which is precisely the failure mode this
 * gate was written to catch one level down.
 */

/** The stub endpoint's reply, shaped like an OpenAI-compatible completion. */
function workerReply(body: Record<string, unknown>) {
  return { ok: true, json: async () => body }
}

/** A starved completion: HTTP 200, `finish_reason: 'length'`, empty content. */
function starvedReply() {
  return workerReply({
    choices: [{ message: { content: '' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
  })
}

function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
}

/** Permits the command outright, so verification would actually run if it were reached. */
const ALLOW = { mode: 'allow' as const, allowlist: [], timeoutMs: 30000 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyWorkerOutput: the decision', () => {
  it('treats length with empty content as starvation', () => {
    expect(classifyWorkerOutput({ finishReason: 'length', content: '' }).starved).toBe(true)
  })

  it('treats whitespace-only content as empty', () => {
    // A message of newlines is no more an answer than an absent one.
    expect(classifyWorkerOutput({ finishReason: 'length', content: '  \n\t ' }).starved).toBe(true)
  })

  it('does NOT treat length with real content as starvation', () => {
    // The deliberate narrowness. A model that emitted a complete file and then rambled into the cap
    // produced usable output; failing it would trade a silent green for a loud false red.
    expect(classifyWorkerOutput({ finishReason: 'length', content: 'export const x = 1' }).starved).toBe(
      false
    )
  })

  it('treats a normal stop with empty content as a failure, like any other empty reply', () => {
    // The case that used to be the KNOWN GAP. It differed from starvation only in the reason the server
    // gave for stopping, and the reason does not make an empty reply usable.
    expect(classifyWorkerOutput({ finishReason: 'stop', content: '' }).starved).toBe(true)
    expect(classifyWorkerOutput({ finishReason: 'stop', content: 'done' }).starved).toBe(false)
  })

  it('treats a missing finish_reason with empty content as a failure too', () => {
    // Fail closed on the reason, but only for a response that carries nothing. A server that reports no
    // finish reason and no content has still produced no content.
    expect(classifyWorkerOutput({ content: '' }).starved).toBe(true)
    expect(classifyWorkerOutput({ finishReason: null, content: '' }).starved).toBe(true)
    expect(classifyWorkerOutput({ finishReason: undefined, content: null }).starved).toBe(true)
    // ...and NON-empty content is still never this refusal, whatever the reason is.
    expect(classifyWorkerOutput({ content: 'export const x = 1' }).starved).toBe(false)
    expect(classifyWorkerOutput({ finishReason: 'stop', content: ' ' }).starved).toBe(true)
  })

  it('keeps the two causes distinguishable, because their remedies differ', () => {
    // Token exhaustion has a specific fix (the thinking toggle on the host). "Finished with nothing" does
    // not, so collapsing them into one message would send the operator to the wrong place.
    const exhausted = classifyWorkerOutput({ finishReason: 'length', content: '' })
    const stopped = classifyWorkerOutput({ finishReason: 'stop', content: '' })
    if (!exhausted.starved || !stopped.starved) throw new Error('unreachable')
    expect(exhausted.reason).toContain('token budget')
    expect(stopped.reason).toContain('finish_reason "stop"')
    expect(stopped.reason).not.toContain('token budget')
  })

  it('explains the cause and the remedy', () => {
    const verdict = classifyWorkerOutput({ finishReason: 'length', content: '' })
    expect(verdict.starved).toBe(true)
    if (!verdict.starved) throw new Error('unreachable')
    expect(verdict.reason).toContain('finish_reason "length"')
    expect(verdict.reason).toContain('thinking')
    expect(verdict.reason).toContain('contract was not run')
  })
})

describe('delegation integration: a starved worker must not settle as SUCCESS', () => {
  it('returns a non-success verdict, writes nothing, and never runs the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(starvedReply()))
    const tmpDir = makeTempWorkspace('lr-starved')

    const res: any = await delegateWorker(
      {
        taskName: 'Starved',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        // The command would PASS if it ran, which is the whole trap: a green verdict over a tree the
        // worker never touched. Asserting it did not run is the substantive claim here.
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.status).toBe('WORKER_OUTPUT_STARVED')
    expect(res.success).toBe(false)
    expect(res.filesWritten).toEqual([])
    expect(res.workerFinishReason).toBe('length')
    expect(res.message).toContain('finish_reason "length"')
    // No test result can be mistaken for a pass, because none was produced.
    expect(res.testResults.passed).toBe(0)
    expect(res.testResults.failed).toBe(0)
    expect(res.testResults.output).toContain('contract was not run')
    expect(fs.existsSync(path.join(tmpDir, 'src', 'ok.ts'))).toBe(false)
  })

  it('still accepts a real reply through the same path', async () => {
    // The control. Without this, the suite would pass if the gate rejected everything.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        workerReply({
          choices: [
            {
              message: { content: '```typescript file="src/ok.ts"\nexport const ok = 1\n```' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      )
    )
    const tmpDir = makeTempWorkspace('lr-not-starved')

    const res: any = await delegateWorker(
      {
        taskName: 'Fine',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        verificationPolicy: ALLOW,
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.status).not.toBe('WORKER_OUTPUT_STARVED')
    expect(res.filesWritten).toContain(path.join(tmpDir, 'src', 'ok.ts'))
  })

  it('an empty reply that stopped normally no longer settles as SUCCESS', async () => {
    // This was `KNOWN GAP: an empty reply that stopped normally still settles as SUCCESS`, and it said
    // what to do if it ever failed: assert the new outcome rather than delete the case. It failed when
    // the gate was widened, and this is that assertion. It goes through the same wiring as the starved
    // case, which is the half a pure-function test cannot cover.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        workerReply({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
      )
    )
    const tmpDir = makeTempWorkspace('lr-empty-stop')

    const res: any = await delegateWorker(
      {
        taskName: 'EmptyStop',
        instruction: 'write it',
        targetFiles: ['src/ok.ts'],
        workspaceDir: tmpDir,
        // Would PASS if it ran, which is the trap: a green verdict over a tree the worker never touched.
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
      },
      new SavingsTracker(tmpDir)
    )

    expect(res.status).toBe('WORKER_OUTPUT_STARVED')
    expect(res.success).toBe(false)
    expect(res.filesWritten).toEqual([])
    expect(res.workerFinishReason).toBe('stop')
    expect(res.testResults.output).toContain('contract was not run')
    expect(fs.existsSync(path.join(tmpDir, 'src', 'ok.ts'))).toBe(false)
  })
})
