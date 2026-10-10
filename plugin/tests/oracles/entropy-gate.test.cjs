// Oracle for the entropy backstop and its confidence tiering.
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { apply, scanDLP } = require(PLUGIN + "/dist/index.js");
const { shannonEntropy, findHighEntropyTokens } = require(PLUGIN + "/dist/local-classifier.js");

const RANDOM_TOKEN = "export TOKEN=Zk8Qm3Xr7Tp2Wv9Bn4Ld6Hs1Jy5Gc0Fa";
const REGEX_SECRET = 'api_key = "sk-' + "a".repeat(32) + '"';
const CLEAN = "rename the variable x to y in this function";

function hooksFor(options = {}) {
  const handlers = {};
  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    get: () => undefined,
    tools: { register: () => {} },
  };
  apply(ctx, options);
  return handlers;
}

// The host carries `agent` on the `agent/pre-step` payload (see its runtime-types), and the gate keys
// its per-session state on it. One fresh session per issued request, because the DLP corpus is keyed by
// session and lives for the process -- a shared id would carry one case's credential into the next.
let entropySessionSeq = 0;

async function issueRequest(handlers, prompt, turn = 1) {
  const agent = { id: `entropy-gate-session-${++entropySessionSeq}` };
  await handlers["agent/pre-step"]({ turn, agent, messages: [{ role: "user", content: prompt }] }, async () => ({}));
  const next = async () => ({ provider: "upstream", model: "upstream" });
  return handlers["agent/request"]({ agent, turn, step: 1, signal: new AbortController().signal }, next);
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------
test("entropy separates random tokens from ordinary content", () => {
  const noisy = shannonEntropy("aaaaaaaaaaaaaaaaaaaaaaaa");
  const random = shannonEntropy("Zk8Qm3Xr7Tp2Wv9Bn4Ld6Hs1Jy5Gc0Fa");
  assert.ok(random > noisy, "a random token must score above a repetitive one");
  assert.ok(random >= 4.5, `random token scored ${random.toFixed(2)}`);
});

test("no false positives on content that merely looks random", () => {
  const benign = {
    "sha256 digest": "sha256:ff5c4dbc165b35b4b6bd57c15aec03f580f78808756e575b2166ce303c8dcfa9",
    "base64 payload": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg",
    "uuid": "91df1d53-4bde-40e0-9eae-c290ecd29f5d",
    "git sha": "4f2a9c1e8b7d6a5f3e2c1b0a9d8e7f6c5b4a3928",
    "long identifier": "extractTextFromClaimedMessagesAndReturnThePrompt",
    "long file path": "C:/Users/example/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh-user-approval",
    "prose": "refactor this module into smaller pieces and add tests",
  };
  for (const [label, text] of Object.entries(benign)) {
    assert.deepEqual(findHighEntropyTokens(text), [], `false positive on ${label}`);
  }
});

test("a random token with no keyword or prefix IS caught", () => {
  assert.equal(findHighEntropyTokens(RANDOM_TOKEN).length > 0, true);
});

// ---------------------------------------------------------------------------
// Confidence reporting
// ---------------------------------------------------------------------------
test("scanDLP reports high confidence for a recognised shape", () => {
  const result = scanDLP(REGEX_SECRET);
  assert.equal(result.hasSensitiveData, true);
  assert.equal(result.highConfidence, true);
  assert.ok(result.violations.includes("OpenAI/DeepSeek API Key"));
});

test("scanDLP reports medium confidence for an entropy-only hit", () => {
  const result = scanDLP(RANDOM_TOKEN);
  assert.equal(result.hasSensitiveData, true);
  assert.equal(result.highConfidence, false, "entropy alone is not high confidence");
  assert.deepEqual(result.violations, ["High-entropy string"]);
});

test("scanDLP leaves clean prose alone", () => {
  const result = scanDLP(CLEAN);
  assert.equal(result.hasSensitiveData, false);
  assert.equal(result.highConfidence, false);
});

// ---------------------------------------------------------------------------
// Tiered gate behaviour
// ---------------------------------------------------------------------------
test("an entropy-only hit is REROUTED LOCAL, never hard-blocked", async () => {
  const handlers = hooksFor(); // default dlpAction is 'block'
  const config = await issueRequest(handlers, RANDOM_TOKEN);
  assert.equal(config.provider, "lm-studio", "entropy hits must be pinned local, not blocked");
  assert.equal(config.model, "qwen/qwen3.8-27b");
});

test("a recognised secret still BLOCKS under the default action", async () => {
  const handlers = hooksFor();
  await assert.rejects(() => issueRequest(handlers, REGEX_SECRET), /DLP firewall blocked/);
});

test("dlpAction 'local' reroutes a recognised secret instead of blocking", async () => {
  const handlers = hooksFor({ dlpAction: "local" });
  const config = await issueRequest(handlers, REGEX_SECRET);
  assert.equal(config.provider, "lm-studio");
});

test("entropyCheck:false restores the previous behaviour", async () => {
  const handlers = hooksFor({ entropyCheck: false });
  const config = await issueRequest(handlers, RANDOM_TOKEN);
  assert.equal(config.provider, "deepseek-official", "without the backstop the token is not detected");
});

test("entropy thresholds are configurable", () => {
  const strict = findHighEntropyTokens(RANDOM_TOKEN, { minBitsPerChar: 6.5 });
  assert.deepEqual(strict, [], "an impossible threshold flags nothing");
  const loose = findHighEntropyTokens("abc123def456ghi789jkl012", { minBitsPerChar: 3.0, minLength: 10 });
  assert.ok(loose.length > 0, "a loose threshold catches more");
});

test("clean requests still reach the cloud architect", async () => {
  const handlers = hooksFor();
  const config = await issueRequest(handlers, CLEAN);
  assert.equal(config.provider, "deepseek-official");
  assert.ok(config.tools.some((t) => (t?.function?.name || t?.name) === "delegate_worker"));
});
