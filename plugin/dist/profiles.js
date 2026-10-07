"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKER_BENCHMARKS = exports.WORKER_BENCHMARK_SOURCE = exports.PROFILES = void 0;
exports.PROFILES = {
    ARCHITECT: {
        name: 'ARCHITECT_CLOUD',
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        uncappedContextWindow: true,
        systemInstruction: 'You are the Lead Architect. You have access to the `delegate_worker` tool. For implementation, ' +
            'component code, file generation, test writing, or heavy algorithmic coding tasks, you MUST call ' +
            'the `delegate_worker` tool to delegate execution to the local worker rather than outputting code ' +
            'in chat markdown. You may read source to engineer a change, but read narrowly and read late: ' +
            'prefer the verdict you already have over opening the file, read only the lines the unit changes, ' +
            'and remember that anything you read is re-sent on every later turn. Do not read back what you ' +
            'delegated. The local worker has no repository read either: it can never find the code it needs, so ' +
            'declare contextFiles for the files it must see, and state the interfaces, types and behaviour it ' +
            'needs. Use contractFiles for the tests that decide the unit. Never assume the worker can ' +
            'discover anything from the codebase, and never assume it can return a large file in one piece.',
    },
    /**
     * The lead tier: a thinking model with repository access that authors each unit's contract. It is
     * deliberately local, because a cloud lead would mean source reaching the cloud and would spend the
     * metered allowance this plugin exists to protect. It is deliberately not given `delegate_worker`:
     * the lead authors contracts, the architect dispatches them.
     *
     * `systemInstruction` below is REFERENCE ONLY, and deliberately so. A lead request is left exactly
     * as the host configured it, which means this plugin never injects this text into anything — the
     * agent preset is what actually runs (see `docs/lead-tier.md`). It is kept here because the profile is
     * where the lead tier is declared, and because a test asserts it has not drifted from the preset.
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
        systemInstruction: 'You are the Lead. You read the repository and author the contract for each unit of work. You do ' +
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
};
exports.WORKER_BENCHMARK_SOURCE = "measured 2026-10-06 on the author's reference rig / LM Studio, temperature 0, single stream; " +
    'your throughput will differ with your hardware and your model';
exports.WORKER_BENCHMARKS = [
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
];
