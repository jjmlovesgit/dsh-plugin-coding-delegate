// Oracle: routing is in-process -- no sidecar process, no network call to a classifier.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { LocalRouter, scanDLP, estimateTokenCount } = require(PLUGIN + "/dist/index.js");
const { classifyLocally } = require(PLUGIN + "/dist/local-classifier.js");

const GOLDENS = JSON.parse(
  fs.readFileSync(PLUGIN + "/tests/fixtures/classifier-goldens.json", "utf8")
);

// predictRoute is deliberately layered, and the oracle must model all three:
//   1. DLP firewall (scanDLP) -> local, complexity 1, its own gate
//   2. Gate 0 token threshold -> cloud
//   3. the local classifier    -> the ported decision
function expectedDecision(input, config = {}) {
  const dlp = scanDLP(input);
  if (dlp.hasSensitiveData) {
    return {
      route: "WORKER_LOCAL",
      gate: "Gate 1 (Local Classifier - DLP Firewall)",
      scores: { is_private: 0.99, complexity: 1, target: "LOCAL_5090" },
      layered: "dlp",
    };
  }
  const threshold = config.contextThreshold ?? 30000;
  if (estimateTokenCount(input) > threshold) {
    return { route: "ARCHITECT_CLOUD", gate: "Gate 0 (Guard - Token Threshold)", layered: "gate0" };
  }
  const decision = classifyLocally(input);
  return {
    route: decision.route === "cloud" ? "ARCHITECT_CLOUD" : "WORKER_LOCAL",
    gate: decision.gate,
    scores: decision.scores,
    layered: "classifier",
  };
}

test("router decisions follow the DLP -> Gate0 -> classifier layering, for every golden input", async () => {
  const router = new LocalRouter({
    localProvider: "lm-studio",
    cloudProvider: "deepseek-official",
    localModel: "qwen/qwen3.8-27b",
    cloudModel: "deepseek-chat",
  });

  const mismatches = [];
  const layerCounts = { dlp: 0, gate0: 0, classifier: 0 };

  for (const entry of GOLDENS.entries) {
    const decision = await router.predictRoute(entry.input);
    const want = expectedDecision(entry.input);
    layerCounts[want.layered]++;

    const checks = [
      ["route", decision.route, want.route],
      ["gate", decision.gate, want.gate],
      ["provider", decision.provider, want.route === "ARCHITECT_CLOUD" ? "deepseek-official" : "lm-studio"],
      ["model", decision.model, want.route === "ARCHITECT_CLOUD" ? "deepseek-chat" : "qwen/qwen3.8-27b"],
    ];
    if (want.scores) {
      checks.push(["is_private", decision.scores.is_private, want.scores.is_private]);
      checks.push(["complexity", decision.scores.complexity, want.scores.complexity]);
      checks.push(["target", decision.scores.target, want.scores.target]);
    }
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) {
        mismatches.push(`${entry.label}: ${field} = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
      }
    }
  }

  assert.deepEqual(mismatches, [], `router divergence:\n${mismatches.join("\n")}`);
  // The corpus must actually exercise more than one layer, or this proves little.
  assert.ok(layerCounts.dlp > 0, "expected the DLP layer to fire on some golden inputs");
  assert.ok(layerCounts.classifier > 0, "expected the classifier layer to fire on some golden inputs");
});

test("the DLP gate and the classifier share one rule set", async () => {
  // `password: "..."` used to be missed by scanDLP (which only covered
  // secret_key|api_key|access_token with '='), so it reached the cloud. Both layers
  // now consume SECRET_PATTERN_RULES, so the enforcing gate cannot be weaker than
  // the classifier that reports alongside it.
  const router = new LocalRouter();
  const input = 'config password: "hunter2hunter2" and then a long description '.repeat(2);
  assert.equal(scanDLP(input).hasSensitiveData, true, "the DLP gate must catch this form");
  assert.ok(scanDLP(input).violations.includes("Generic Secret Keyword"));
  const decision = await router.predictRoute(input);
  assert.equal(decision.route, "WORKER_LOCAL");
  assert.equal(decision.scores.is_private, 0.99);
});

test("routing no longer pays a network round-trip or timeout", async () => {
  const router = new LocalRouter();
  const prompt = "rename the variable x to y in this function";

  await router.predictRoute(prompt); // warm up
  const iterations = 100;
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await router.predictRoute(prompt);
  const perCall = (performance.now() - started) / iterations;

  assert.ok(perCall < 20, `expected in-process routing (<20ms), measured ${perCall.toFixed(2)}ms per call`);
});

test("the deterministic token-threshold gate still short-circuits to cloud", async () => {
  const router = new LocalRouter({ contextThreshold: 10 });
  const decision = await router.predictRoute("x".repeat(200)); // ~50 estimated tokens
  assert.match(decision.gate, /Gate 0/);
  assert.equal(decision.route, "ARCHITECT_CLOUD");
  assert.equal(decision.provider, "deepseek-official");
});

test("no daemon endpoint survives anywhere in the build", () => {
  const built = ["dist/index.js", "dist/local-classifier.js"]
    .map((f) => fs.readFileSync(path.join(PLUGIN, f), "utf8"))
    .join("\n");
  assert.ok(!built.includes("11435"), "the daemon port must not appear in the build");
  assert.ok(!/layaEndpoint/.test(built), "layaEndpoint must be gone");
  assert.ok(!/layaDaemonUrl/.test(built), "layaDaemonUrl must be gone");
  assert.ok(!/Daemon Unreachable/.test(built), "the daemon failover gate must be gone");
});

test("a credential-bearing prompt never reaches the cloud route", async () => {
  const router = new LocalRouter();
  const secret = 'api_key = "sk-' + "abcdefghijklmnopqrstuvwxyz" + "0123456789" + '" ' + "refactor the async architecture ".repeat(50);
  const decision = await router.predictRoute(secret);
  assert.equal(decision.route, "WORKER_LOCAL");
  assert.match(decision.gate, /DLP Firewall/);
});
