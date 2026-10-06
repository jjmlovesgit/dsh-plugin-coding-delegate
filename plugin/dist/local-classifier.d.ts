export type ClassifierRoute = 'local' | 'cloud';
export interface ClassifierScores {
    is_private: number;
    complexity: number;
    target: 'LOCAL_5090' | 'CLOUD_DEEPSEEK';
}
export interface ClassifierDecision {
    route: ClassifierRoute;
    rationale: string;
    gate: string;
    scores: ClassifierScores;
    latencyMs: number;
}
/**
 * The single source of truth for credential detection, shared by this classifier and
 * the enforced DLP gate in index.ts. One table, so the gate that decides whether a
 * payload may leave the machine can never be weaker than the one that reports on it.
 *
 * Patterns are deliberately NOT global: a `/g` regex carries `lastIndex` between
 * `.test()` calls and silently alternates between matching and not matching.
 */
export declare const SECRET_PATTERN_RULES: {
    name: string;
    pattern: RegExp;
}[];
/** Convenience view of {@link SECRET_PATTERN_RULES} for callers that want patterns only. */
export declare const SECRET_PATTERNS: RegExp[];
/** Shannon entropy in bits per character. */
export declare function shannonEntropy(value: string): number;
/** Bits per character above which a token is treated as suspiciously random. */
export declare const ENTROPY_MIN_BITS_PER_CHAR = 4.5;
/** Tokens shorter than this are too noisy to score. */
export declare const ENTROPY_MIN_LENGTH = 20;
/**
 * The backstop for credentials no keyword or vendor pattern would reveal.
 *
 * Thresholds are measured, not guessed: on a corpus containing sha256 digests, base64
 * payloads, UUIDs, git SHAs, long file paths, prose and minified CSS, 4.5 bits/char at
 * length >= 20 caught every sampled secret with zero false positives. Random keys sit
 * near 5.2 bits/char; the noise sat at 4.2-4.4. Re-tune against a real corpus before
 * trusting the boundary in a new codebase.
 */
export declare function findHighEntropyTokens(text: string, options?: {
    minBitsPerChar?: number;
    minLength?: number;
}): string[];
export declare function containsSensitiveCredentials(text: string): boolean;
export declare function evaluateHeuristics(promptSlice: string, secretScanText?: string): ClassifierScores;
export declare function classifyLocally(promptText: string, options?: {
    windowChars?: number;
    scanFullTextForSecrets?: boolean;
}): ClassifierDecision;
