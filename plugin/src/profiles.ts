export interface ProfileConfig {
  name: string
  provider: string
  model: string
  endpoint?: string
  contextWindow?: number
  uncappedContextWindow?: boolean
  systemInstruction?: string
  temperature?: number
  max_tokens?: number
  stop?: string[]
  enable_thinking?: boolean
  reasoning_effort?: string
}

export interface Profiles {
  ARCHITECT: ProfileConfig
  LEAD: ProfileConfig
  WORKER: ProfileConfig
}

export const PROFILES: Profiles = {
  ARCHITECT: {
    name: 'ARCHITECT_CLOUD',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    uncappedContextWindow: true,
    systemInstruction:
      'You are the Lead Architect. You have access to the `delegate_worker` tool. For implementation, ' +
      'component code, file generation, test writing, or heavy algorithmic coding tasks, you MUST call ' +
      'the `delegate_worker` tool to delegate execution to the local worker rather than outputting code ' +
      'in chat markdown. Do not read implementation files into this conversation: your context is ' +
      'reserved for design, contracts and verdicts, and anything read into it is re-sent on every later ' +
      'turn. The local worker has no repository read either: it can never find the code it needs, so ' +
      'declare contextFiles for the files it must see, and state the interfaces, types and behaviour it ' +
      'needs. Use contractFiles for the tests that decide the unit. Never assume the worker can ' +
      'discover anything from the codebase, and never assume it can return a large file in one piece.',
  },
  /**
   * The lead tier: a thinking model with repository access that authors each unit's contract. It is
   * deliberately local, because a cloud lead would mean source reaching the cloud and would spend the
   * metered allowance this plugin exists to protect. It is deliberately not given `delegate_worker`:
   * the lead authors contracts, the architect dispatches them.
   */
  LEAD: {
    name: 'LEAD_LOCAL',
    provider: 'lm-studio',
    model: 'qwen/qwen3.8-27b',
    endpoint: 'http://127.0.0.1:1234/v1',
    contextWindow: 32768,
    temperature: 0.2,
    max_tokens: 8192,
    enable_thinking: true,
    reasoning_effort: 'high',
    systemInstruction:
      'You are the Lead. You read the repository and author the contract for each unit of work. You do ' +
      'not write implementation code, and you do not dispatch the worker -- the architect does that ' +
      'with your contract. For each unit, state: the files it touches, the exact change expected, the ' +
      'code the worker must see, and the command that decides whether the unit passed. Quote any code ' +
      'you are changing exactly as it appears, because a patch that does not match byte-for-byte is ' +
      'refused rather than approximated.',
  },
  WORKER: {
    name: 'WORKER_LOCAL',
    provider: 'lm-studio',
    model: 'qwen/qwen3.8-27b',
    endpoint: 'http://127.0.0.1:1234/v1',
    contextWindow: 32768,
    temperature: 0.2,
    max_tokens: 8192,
    stop: ['<|im_end|>', '<|endoftext|>'],
    enable_thinking: false,
    reasoning_effort: 'none',
  },
} as const

/**
 * Measured reference throughput for the local worker models (author's reference rig /
 * LM Studio, temperature 0, single stream, no concurrent load). Printed once at startup
 * for operator reference; live per-call rates ride the LEDGER_AUDIT line instead.
 * These are one machine's numbers: throughput is a property of the hardware and the
 * model, not of the plugin, and a different card will produce different figures.
 */
export interface WorkerBenchmark {
  model: string
  decodeTps: number
  ttft: string
  note: string
}

export const WORKER_BENCHMARK_SOURCE =
  "measured 2026-10-06 on the author's reference rig / LM Studio, temperature 0, single stream; " +
  'your throughput will differ with your hardware and your model'

export const WORKER_BENCHMARKS: WorkerBenchmark[] = [
  {
    model: 'qwen/qwen3.8-27b',
    decodeTps: 130.6,
    ttft: '~240 ms',
    note: 'prefill ~2400 tok/s cold, ~100 ms with a cached prompt',
  },
  {
    model: 'muse-glimmer-30b',
    decodeTps: 114.4,
    ttft: '~19.7 s',
    note: 'TTFT dominated by JIT model load, not prefill',
  },
]
