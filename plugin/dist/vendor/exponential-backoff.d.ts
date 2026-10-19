export declare class ExponentialBackoff {
    #private;
    constructor(options: {
        baseDelayMs: number;
        maxDelayMs: number;
        factor?: number;
        jitter?: 'none' | 'full';
    });
    computeDelay(attempt: number, rngSeed?: number): number;
    reset(): void;
}
