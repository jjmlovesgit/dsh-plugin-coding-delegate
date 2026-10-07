import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LocalRouter,
  LLMSession,
  estimateTokenCount,
  extractPromptText,
  scanDLP,
  resolveDataDir,
  delegateWorker,
  extractAndEmitFiles,
  parseTestOutput,
  DELEGATE_WORKER_OPENAI_SCHEMA,
  PROFILES,
  SavingsTracker,
  inject,
  using,
  apply,
  hasCommandWriteSignal,
  hasCommandDeleteSignal,
  evaluateCodeWriteGuard,
} from '../src/index'
import { classifyLocally } from '../src/local-classifier'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

/** Temp workspace outside the plugin directory: writing into cwd pollutes the
 *  package and gets collected as a test file on the next run. */
function makeTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe('DSH Local Router Cordis Plugin Test Suite', () => {
  let router: LocalRouter

  beforeEach(() => {
    router = new LocalRouter({
      localProvider: 'lm-studio',
      cloudProvider: 'deepseek-official',
      contextTokenThreshold: 30000,
    })
    vi.restoreAllMocks()
  })

  it('Cordis Service Injection & Schema: Exports inject, using, and DELEGATE_WORKER_OPENAI_SCHEMA', () => {
    expect(inject).toContain('tools')
    expect(using).toContain('tools')
    expect(DELEGATE_WORKER_OPENAI_SCHEMA.function.name).toBe('delegate_worker')
    expect(PROFILES.ARCHITECT.systemInstruction).toContain('delegate_worker')
  })

  it('DSH Tool Registration: Registers delegate_worker with output schema and render on ctx.tools', () => {
    const registerFn = vi.fn()
    const mockCtx: any = {
      tools: { register: registerFn },
      on: vi.fn(),
    }

    apply(mockCtx, {})

    expect(registerFn).toHaveBeenCalled()
    const registeredDef = registerFn.mock.calls[0][0]
    expect(registeredDef.name).toBe('delegate_worker')
    expect(registeredDef.output).toBeDefined()
    expect(registeredDef.output.schema).toBeDefined()
    expect(typeof registeredDef.output.render).toBe('function')
    expect(typeof registeredDef.execute).toBe('function')
  })

  it('Profiles Integrity: Exported ARCHITECT and WORKER profiles match standards', () => {
    expect(PROFILES.ARCHITECT.provider).toBe('deepseek-official')
    expect(PROFILES.ARCHITECT.model).toBe('deepseek-chat')
    expect(PROFILES.ARCHITECT.uncappedContextWindow).toBe(true)

    expect(PROFILES.WORKER.provider).toBe('lm-studio')
    expect(PROFILES.WORKER.model).toBe('qwen/qwen3.8-27b')
    expect(PROFILES.WORKER.contextWindow).toBe(32768)
    expect(PROFILES.WORKER.temperature).toBe(0.2)
    expect(PROFILES.WORKER.max_tokens).toBe(8192)
    expect(PROFILES.WORKER.stop).toContain('<|im_end|>')
    expect(PROFILES.WORKER.enable_thinking).toBe(false)
    expect(PROFILES.WORKER.reasoning_effort).toBe('none')
  })

  it('Routing Is In-Process: decisions are produced with the network unavailable', async () => {
    // If any code path still reached for the network, this would throw.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled')))

    const local = await router.predictRoute('rename the variable x to y')
    expect(local.route).toBe('WORKER_LOCAL')
    expect(local.provider).toBe('lm-studio')
    expect(local.gate).toBe('Gate 1 (Local Classifier - Local Default)')

    const cloud = await router.predictRoute(
      'refactor multi-threaded async state machine algorithm with deadlock resolution'
    )
    expect(cloud.route).toBe('ARCHITECT_CLOUD')
    expect(cloud.provider).toBe('deepseek-official')
    expect(cloud.scores.complexity).toBeGreaterThanOrEqual(2)
  })

  it('No Daemon Surface: the built plugin exposes no endpoint configuration', () => {
    const built = fs.readFileSync(path.join(process.cwd(), 'dist', 'index.js'), 'utf8')
    expect(built).not.toContain('11435')
    expect(built).not.toMatch(/layaEndpoint|layaDaemonUrl/)
  })

  it('Derived State Directory: resolveDataDir avoids any hard-coded machine path', () => {
    const dir = resolveDataDir()
    expect(path.isAbsolute(dir)).toBe(true)
    expect(dir).not.toMatch(/DSHLaya/i)
    expect(dir.endsWith('local-router')).toBe(true)
  })

  it('File Emitter: Parses structured code blocks and writes files to workspace', () => {
    const tmpWorkspace = makeTempWorkspace('lr-emit')

    const sampleContent = `Here is the PriorityQueue code:

\`\`\`typescript file="src/PriorityQueue.ts"
export class PriorityQueue<T> {
  private items: T[] = [];
}
\`\`\`

And the test:

\`\`\`typescript
// FILE: tests/PriorityQueue.test.ts
import { PriorityQueue } from '../src/PriorityQueue';
\`\`\`
`

    const res = extractAndEmitFiles(sampleContent, undefined, tmpWorkspace)

    expect(res.filesWritten).toHaveLength(2)
    // entries carry both the absolute path and the workspace-relative name
    const relativeNames = res.filesWritten.map((f: any) => f.relativeName)
    expect(relativeNames).toContain(path.join('src', 'PriorityQueue.ts'))
    expect(path.isAbsolute(res.filesWritten[0].path)).toBe(true)
    expect(fs.existsSync(path.join(tmpWorkspace, 'src', 'PriorityQueue.ts'))).toBe(true)
    expect(fs.existsSync(path.join(tmpWorkspace, 'tests', 'PriorityQueue.test.ts'))).toBe(true)

    fs.rmSync(tmpWorkspace, { recursive: true, force: true })
  })

  it('File Emitter: refuses non-code output instead of clobbering a real file', () => {
    const tmpWorkspace = makeTempWorkspace('lr-guard')
    const target = path.join(tmpWorkspace, 'guarded.ts')
    fs.writeFileSync(target, '// a real module\n' + 'export const x = 1\n'.repeat(150), 'utf8')
    const originalSize = fs.statSync(target).size

    const transcript = '<tool_call>\n<function=Read>\n<parameter=file_path>\nsrc/guarded.ts\n'
    const res = extractAndEmitFiles(transcript, ['guarded.ts'], tmpWorkspace)

    expect(res.filesWritten).toHaveLength(0)
    expect(res.errors.length).toBeGreaterThan(0)
    expect(fs.statSync(target).size).toBe(originalSize)

    fs.rmSync(tmpWorkspace, { recursive: true, force: true })
  })

  it('Test Parser: Parses TAP assertions and counts passes/failures', () => {
    const tapOutput = `TAP version 13
ok 1 - PriorityQueue insert
ok 2 - PriorityQueue extractMin
not ok 3 - PriorityQueue isEmpty
  AssertionError: expected true but got false
`
    const parsed = parseTestOutput(tapOutput)
    expect(parsed.passed).toBe(2)
    expect(parsed.failed).toBe(1)
    // Redaction deliberately does NOT echo the raw "not ok 3" line or the assertion
    // diff; the subtest NAME and the error kind are what survive.
    expect(parsed.redacted).toBe(true)
    expect(parsed.errorSummary).toContain('PriorityQueue isEmpty')
    expect(parsed.errorSummary).not.toContain('not ok 3')
    expect(parsed.errorSummary).not.toContain('expected true but got false')
    expect(parsed.failures?.[0]?.kind).toBe('assertion')
    expect(parsed.failures?.[0]?.name).toContain('3. PriorityQueue isEmpty')
  })

  it('Test Parser: a non-zero exit is a failure even when output is unrecognised', () => {
    // tsc reports "error TS1234:", which matches no TAP marker. This previously
    // scored passed=1 and reported a broken build as SUCCESS.
    const tscOutput = 'src/a.ts(1,1): error TS1434: Unexpected keyword or identifier.'
    const parsed = parseTestOutput(tscOutput, 1)
    expect(parsed.failed).toBeGreaterThanOrEqual(1)
    expect(parsed.passed).toBe(0)

    const silentFailure = parseTestOutput('', 2)
    expect(silentFailure.failed).toBe(1)
  })

  it('Helper: token estimation and text extraction', () => {
    const text = 'Hello world'
    expect(estimateTokenCount(text)).toBe(3)

    const session: LLMSession = {
      prompt: 'Hello from prompt',
      options: {},
    }
    expect(extractPromptText(session)).toBe('Hello from prompt')
  })

  it('DLP Firewall Scanner: Detects sensitive credentials and API keys', () => {
    const cleanText = 'Please write a React button component'
    expect(scanDLP(cleanText).hasSensitiveData).toBe(false)
    expect(scanDLP(cleanText).violations).toHaveLength(0)

    const ghpText = 'Here is my GitHub token: ghp_1234567890abcdef1234567890abcdef1234'
    const ghpResult = scanDLP(ghpText)
    expect(ghpResult.hasSensitiveData).toBe(true)
    expect(ghpResult.violations).toContain('GitHub PAT')

    const skText = 'sk-1234567890abcdef1234567890abcdef1234'
    const skResult = scanDLP(skText)
    expect(skResult.hasSensitiveData).toBe(true)
    expect(skResult.violations).toContain('OpenAI/DeepSeek API Key')

    const keyBlock = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----'
    const keyResult = scanDLP(keyBlock)
    expect(keyResult.hasSensitiveData).toBe(true)
    expect(keyResult.violations).toContain('Private Key Block')
  })

  it('Local Classifier: privacy beats complexity and scans the whole prompt', () => {
    const secretThenComplex =
      'api_key = "sk-1234567890abcdef1234567890abcdef1234" ' + 'refactor the async architecture '.repeat(50)
    const decision = classifyLocally(secretThenComplex)
    expect(decision.route).toBe('local')
    expect(decision.scores.is_private).toBe(0.99)
    expect(decision.gate).toContain('Privacy Protection')

    // A credential behind the complexity window must still be found.
    const farBehind = 'sk-1234567890abcdef1234567890abcdef1234 ' + 'filler '.repeat(600)
    expect(classifyLocally(farBehind).scores.is_private).toBe(0.99)
  })

  it('DLP Privacy Routing: Sensitive credentials force WORKER_LOCAL route', async () => {
    const sensitivePrompt = 'ghp_1234567890abcdef1234567890abcdef1234 secret_key="super_secret_pass"'
    const session: LLMSession = {
      prompt: sensitivePrompt,
      options: {},
    }

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('lm-studio')
    expect(updated.metadata?.router?.route).toBe('WORKER_LOCAL')
    expect(updated.metadata?.router?.dlpViolations).toBeDefined()
    expect(updated.metadata?.router?.dlpViolations?.length).toBeGreaterThan(0)
  })

  it('Architect Primary Thread: Prompts > 30k tokens route to ARCHITECT_CLOUD with uncapped context', async () => {
    const longPrompt = 'A'.repeat(125000)
    const session: LLMSession = {
      prompt: longPrompt,
      options: { provider: 'lm-studio' },
    }

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.gate).toContain('Gate 0')
    expect(updated.metadata?.router?.route).toBe('ARCHITECT_CLOUD')
    expect(updated.metadata?.router?.tier).toContain('Cloud Tier')
  })

  it('Delegate Worker Tool: Dispatches task and returns structured receipt', async () => {
    const tmpDir = makeTempWorkspace('lr-delegate')

    const tracker = new SavingsTracker(tmpDir)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```typescript file="src/math.ts"\nfunction add(a, b) { return a + b }\n```' } }],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
      })
    )

    const res = await delegateWorker(
      {
        taskName: 'AddFunction',
        instruction: 'Write a helper function to add two numbers',
        targetFiles: ['src/math.ts'],
        endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
        workspaceDir: tmpDir,
      },
      tracker
    )

    expect(res.success).toBe(true)
    expect(res.status).toBe('SUCCESS')
    expect(res.filesWrittenRelative).toContain(path.join('src', 'math.ts'))
    expect(path.isAbsolute(res.filesWritten[0])).toBe(true)
    expect(res.tokens.prompt).toBe(30)
    expect(res.tokens.completion).toBe(15)
    expect(res.summary).toContain('Wrote 1 file')

    const ledgerFile = path.join(tmpDir, 'savings-ledger.json')
    expect(fs.existsSync(ledgerFile)).toBe(true)
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    expect(ledger.workerTurns).toBe(1)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Delegate Worker Tool: Returns clean ERROR receipt when LM Studio is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:1234')))

    const res = await delegateWorker({
      taskName: 'TestUnreachable',
      instruction: 'Run test',
    })

    expect(res.success).toBe(false)
    expect(res.status).toBe('ERROR')
    expect(res.message).toContain('LM Studio at 127.0.0.1:1234 was unreachable')
    expect(res.tokens.prompt).toBe(0)
  })

  it('Complexity Routing: high complexity routes to ARCHITECT_CLOUD via the local classifier', async () => {
    const complexPrompt = 'Refactor multi-threaded async state machine algorithm with deadlock resolution'
    const session: LLMSession = {
      prompt: complexPrompt,
      options: {},
    }

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.route).toBe('ARCHITECT_CLOUD')
    expect(updated.metadata?.router?.scores?.complexity).toBe(3)
    expect(updated.metadata?.router?.gate).toBe('Gate 1 (Local Classifier - High Complexity)')
  })

  it('Scenario 4: Simulated LM Studio failure triggers Cloud fallback', async () => {
    const session: LLMSession = {
      prompt: 'Simple query',
      options: { provider: 'lm-studio' },
      metadata: {
        router: {
          provider: 'lm-studio',
          route: 'WORKER_LOCAL',
          gate: 'Gate 1',
          rationale: 'Local route chosen',
          tier: 'Local Tier (RTX 5090 Worker)',
          estimatedTokens: 100,
        },
      },
      redispatch: vi.fn().mockResolvedValue({ ok: true }),
    }

    const oomError = new Error('ECONNREFUSED: LM Studio local server down or CUDA OOM')

    const updated = await router.handleError(session, oomError)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.route).toBe('cloud-failover')
    expect(updated.metadata?.router?.failover).toBe(true)
    expect(updated.metadata?.router?.previousProvider).toBe('lm-studio')
  })
})

describe('Local-code guard: command-line write detection', () => {
  const shell = (command: string) => ({ name: 'pwsh', arguments: { command } })

  it('word-anchors its verbs so a delete is not misread as a write', () => {
    // Regression found by live testing in the desktop app: `Move-Item` is a substring of
    // `Remove-Item`, so an unanchored alternative classified a plain delete as a write
    // signal and asked for approval on any command that also named a source file.
    expect(hasCommandWriteSignal('Remove-Item src/gone.ts')).toBe(false)
    expect(hasCommandWriteSignal("Remove-Item 'C:\\tmp\\x' -Recurse -Force")).toBe(false)
  })

  it('still detects the verbs it is meant to detect', () => {
    expect(hasCommandWriteSignal('Move-Item src/a.ts src/b.ts')).toBe(true)
    expect(hasCommandWriteSignal('Copy-Item src/a.ts src/b.ts')).toBe(true)
    expect(hasCommandWriteSignal('New-Item src/a.ts')).toBe(true)
    expect(hasCommandWriteSignal('cp a.ts b.ts')).toBe(true)
    expect(hasCommandWriteSignal('git checkout src/index.ts')).toBe(true)
    expect(hasCommandWriteSignal('sed -i s/a/b/ src/x.ts')).toBe(true)
  })

  it('asks for approval when a source file is named alongside a write signal', () => {
    expect(evaluateCodeWriteGuard(shell('cp a.ts b.ts'))?.kind).toBe('ask')
    expect(evaluateCodeWriteGuard(shell('git checkout src/index.ts'))?.kind).toBe('ask')
  })

  it('stays silent for read-only commands that name a source file', () => {
    expect(evaluateCodeWriteGuard(shell('git diff src/index.ts'))).toBeNull()
    expect(evaluateCodeWriteGuard(shell("Test-Path 'src/index.ts'"))).toBeNull()
  })

  it('gates deletion of source files, not only overwriting them', () => {
    // Destroying source from the cloud context is gated the same way as writing it.
    expect(hasCommandDeleteSignal('Remove-Item src/gone.ts')).toBe(true)
    expect(evaluateCodeWriteGuard(shell('Remove-Item src/gone.ts'))?.kind).toBe('ask')
    expect(evaluateCodeWriteGuard(shell('rm src/gone.ts'))?.kind).toBe('ask')
    expect(evaluateCodeWriteGuard(shell('git rm src/gone.ts'))?.kind).toBe('ask')
  })

  it('reports deletion as deletion, not as a write', () => {
    const verdict = evaluateCodeWriteGuard(shell('rm src/gone.ts'))
    expect(verdict?.reason).toMatch(/would delete/i)
  })

  it('detects deletion performed through inline program text', () => {
    expect(evaluateCodeWriteGuard(shell('python -c "import os; os.remove(\'src/gone.ts\')"'))?.kind).toBe('ask')
  })

  it('leaves non-source files alone', () => {
    // Only source extensions are in scope; a build artefact is not the guard's business.
    expect(evaluateCodeWriteGuard(shell('Remove-Item build/output.log'))).toBeNull()
  })
})
