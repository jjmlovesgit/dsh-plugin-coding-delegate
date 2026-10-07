export interface ProfileConfig {
    name: string;
    provider: string;
    model: string;
    endpoint?: string;
    contextWindow?: number;
    uncappedContextWindow?: boolean;
    systemInstruction?: string;
    temperature?: number;
    max_tokens?: number;
    stop?: string[];
    enable_thinking?: boolean;
    reasoning_effort?: string;
}
export interface Profiles {
    ARCHITECT: ProfileConfig;
    WORKER: ProfileConfig;
}
export declare const PROFILES: Profiles;
/**
 * Measured reference throughput for the local worker models (author's reference rig /
 * LM Studio, temperature 0, single stream, no concurrent load). Printed once at startup
 * for operator reference; live per-call rates ride the LEDGER_AUDIT line instead.
 * These are one machine's numbers: throughput is a property of the hardware and the
 * model, not of the plugin, and a different card will produce different figures.
 */
export interface WorkerBenchmark {
    model: string;
    decodeTps: number;
    ttft: string;
    note: string;
}
export declare const WORKER_BENCHMARK_SOURCE: string;
export declare const WORKER_BENCHMARKS: WorkerBenchmark[];
