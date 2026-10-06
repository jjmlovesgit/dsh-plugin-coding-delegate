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
  WORKER: ProfileConfig
}

export const PROFILES: Profiles = {
  ARCHITECT: {
    name: 'ARCHITECT_CLOUD',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    uncappedContextWindow: true,
    systemInstruction:
      'You are the Lead Architect. You have access to the `delegate_worker` tool. For implementation, component code, file generation, test writing, or heavy algorithmic coding tasks, you MUST call the `delegate_worker` tool to delegate execution to the local worker on the RTX 5090 rather than outputting all code directly in chat markdown.',
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
 * Measured reference throughput for the local worker models (RTX 5090 / LM Studio,
 * temperature 0, single stream, no concurrent load). Printed once at startup for
 * operator reference; live per-call rates ride the LEDGER_AUDIT line instead.
 */
export interface WorkerBenchmark {
  model: string
  decodeTps: number
  ttft: string
  note: string
}

export const WORKER_BENCHMARK_SOURCE =
  'measured 2026-10-06 on RTX 5090 / LM Studio, temperature 0, single stream'

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
