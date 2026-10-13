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

  it('does not treat a normal stop as starvation, empty or not', () => {
    expect(classifyWorkerOutput({ finishReason: 'stop', content: '' }).starved).toBe(false)
    expect(classifyWorkerOutput({ finishReason: 'stop', content: 'done' }).starved).toBe(false)
  })

  it('does not treat a missing finish_reason as starvation', () => {
    // Fail closed against a malformed response means "do not invent a starvation that was not
    // reported"; the downstream checks still apply to whatever content arrived.
    expect(classifyWorkerOutput({ content: '' }).starved).toBe(false)
    expect(classifyWorkerOutput({ finishReason: null, content: '' }).starved).toBe(false)
    expect(classifyWorkerOutput({ finishReason: undefined, content: null }).starved).toBe(false)
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

  it('KNOWN GAP: an empty reply that stopped normally still settles as SUCCESS', async () => {
    // This gate is deliberately narrow -- `finish_reason === 'length'` AND empty -- so it does NOT
    // cover an empty message returned with `finish_reason: 'stop'`. That case takes the same route
    // through `extractAndEmitFiles('')`, which yields no files and no errors, so `unitSuccess` holds
    // and the status is still SUCCESS. The reported cause differs; the symptom is the same "empty,
    // passing run". Recorded here rather than left silent, and NOT endorsed: widening the gate is the
    // operator's decision, not a side effect of this change.
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
        runVerification: 'node --version',
        verificationPolicy: ALLOW,
      },
      new SavingsTracker(tmpDir)
    )

    // If this ever fails, the gate was widened: replace this case with one asserting the new
    // non-success status rather than deleting it.
    expect(res.status).toBe('SUCCESS')
    expect(res.filesWritten).toEqual([])
  })
})
