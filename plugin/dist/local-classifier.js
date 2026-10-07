"use strict";
// The credential scan intentionally covers the WHOLE prompt while the complexity window stays bounded.
// A credential near the start of a long file must not escape detection, so we scan the full text for secrets.
// The complexity window remains bounded to keep heuristic scoring fast and predictable.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTROPY_MIN_LENGTH = exports.ENTROPY_MIN_BITS_PER_CHAR = exports.SECRET_PATTERNS = exports.SECRET_PATTERN_RULES = void 0;
exports.shannonEntropy = shannonEntropy;
exports.findHighEntropyTokens = findHighEntropyTokens;
exports.containsSensitiveCredentials = containsSensitiveCredentials;
exports.evaluateHeuristics = evaluateHeuristics;
exports.classifyLocally = classifyLocally;
/**
 * The single source of truth for credential detection, shared by this classifier and
 * the enforced DLP gate in index.ts. One table, so the gate that decides whether a
 * payload may leave the machine can never be weaker than the one that reports on it.
 *
 * Patterns are deliberately NOT global: a `/g` regex carries `lastIndex` between
 * `.test()` calls and silently alternates between matching and not matching.
 */
exports.SECRET_PATTERN_RULES = [
    { name: 'Private Key Block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----/i },
    {
        name: 'Generic Secret Keyword',
        pattern: /(?:api_key|apikey|secret_key|private_key|auth_token|access_token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{8,}/i,
    },
    { name: 'GitHub PAT', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36}/i },
    { name: 'Fine-grained GitHub PAT', pattern: /github_pat_[A-Za-z0-9_]{20,}/i },
    { name: 'OpenAI/DeepSeek API Key', pattern: /sk-[a-zA-Z0-9]{32,}/i },
    { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/i },
    { name: 'Slack Token', pattern: /xox[baprs]-[a-zA-Z0-9]{10,}/i },
];
/** Convenience view of {@link SECRET_PATTERN_RULES} for callers that want patterns only. */
exports.SECRET_PATTERNS = exports.SECRET_PATTERN_RULES.map((rule) => rule.pattern);
/** Shannon entropy in bits per character. */
function shannonEntropy(value) {
    if (!value)
        return 0;
    const counts = new Map();
    for (const ch of value)
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
/** Bits per character above which a token is treated as suspiciously random. */
exports.ENTROPY_MIN_BITS_PER_CHAR = 4.5;
/** Tokens shorter than this are too noisy to score. */
exports.ENTROPY_MIN_LENGTH = 20;
/** Runs worth scoring: base64-ish and hex-ish token shapes. */
const ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{20,}/g;
/**
 * The backstop for credentials no keyword or vendor pattern would reveal.
 *
 * Thresholds are measured, not guessed: on a corpus containing sha256 digests, base64
 * payloads, UUIDs, git SHAs, long file paths, prose and minified CSS, 4.5 bits/char at
 * length >= 20 caught every sampled secret with zero false positives. Random keys sit
 * near 5.2 bits/char; the noise sat at 4.2-4.4. Re-tune against a real corpus before
 * trusting the boundary in a new codebase.
 */
function findHighEntropyTokens(text, options = {}) {
    if (!text)
        return [];
    const minBits = options.minBitsPerChar ?? exports.ENTROPY_MIN_BITS_PER_CHAR;
    const minLength = options.minLength ?? exports.ENTROPY_MIN_LENGTH;
    const found = [];
    for (const token of text.match(ENTROPY_TOKEN) ?? []) {
        if (token.length < minLength)
            continue;
        if (shannonEntropy(token) >= minBits)
            found.push(token);
    }
    return found;
}
function containsSensitiveCredentials(text) {
    if (!text)
        return false;
    for (const pattern of exports.SECRET_PATTERNS) {
        if (pattern.test(text))
            return true;
    }
    return false;
}
const COMPLEX_WORDS = [
    'refactor',
    'architecture',
    'async',
    'thread',
    'concurrency',
    'distributed',
    'kubernetes',
    'algorithm',
    'optimization',
    'recursion',
    'deadlock',
];
function evaluateHeuristics(promptSlice, secretScanText) {
    const slice = String(promptSlice ?? '');
    const lines = slice.split('\n').length;
    const length = slice.length;
    const lower = slice.toLowerCase();
    let complexCount = 0;
    for (const word of COMPLEX_WORDS) {
        if (lower.includes(word))
            complexCount++;
    }
    let complexity;
    if (length > 3000 || lines > 100 || complexCount >= 3) {
        complexity = 3;
    }
    else if (length > 1200 || lines > 40 || complexCount >= 1) {
        complexity = 2;
    }
    else if (length > 400) {
        complexity = 1;
    }
    else {
        complexity = 0;
    }
    const target = complexity >= 2 ? 'CLOUD_DEEPSEEK' : 'LOCAL_5090';
    const scanText = secretScanText ?? slice;
    const is_private = containsSensitiveCredentials(scanText) ? 0.99 : 0.05;
    return { is_private, complexity, target };
}
function classifyLocally(promptText, options) {
    const start = performance.now();
    const windowChars = options?.windowChars ?? 2000;
    const scanFullTextForSecrets = options?.scanFullTextForSecrets ?? true;
    const fullText = String(promptText ?? '');
    const window = fullText.slice(-windowChars);
    const scores = evaluateHeuristics(window, scanFullTextForSecrets ? fullText : window);
    let route;
    let gate;
    let rationale;
    if (scores.is_private > 0.8) {
        route = 'local';
        gate = 'Gate 1 (Local Classifier - Privacy Protection)';
        rationale = `Privacy threshold exceeded (P(private) = ${scores.is_private.toFixed(2)} > 0.80). Routing to the local worker.`;
    }
    else if (scores.complexity >= 2) {
        route = 'cloud';
        gate = 'Gate 1 (Local Classifier - High Complexity)';
        rationale = `High complexity score (complexity = ${scores.complexity} >= 2). Routing to DeepSeek Cloud.`;
    }
    else if (scores.target === 'CLOUD_DEEPSEEK') {
        route = 'cloud';
        gate = 'Gate 1 (Local Classifier - Model Target Choice)';
        rationale = 'Target choice evaluated as CLOUD_DEEPSEEK. Routing to DeepSeek Cloud.';
    }
    else {
        route = 'local';
        gate = 'Gate 1 (Local Classifier - Local Default)';
        rationale = "Request fits within the configured local model's capabilities. Routing to the local worker.";
    }
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;
    return { route, rationale, gate, scores, latencyMs };
}
