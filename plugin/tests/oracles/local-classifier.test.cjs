// Oracle for the TypeScript port of the local routing heuristics.
//
// Python-Free by design: the reference behaviour was FROZEN into
// tests/fixtures/classifier-goldens.json (captured from the Python daemon while it
// was still running), so this suite needs no daemon, no Python and no localhost.
//
// The few intentional divergences caused by the two security hardening fixes are
// declared explicitly and must occur — anything else fails the run.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const GOLDENS = PLUGIN + "/tests/fixtures/classifier-goldens.json";
const MODULE = PLUGIN + "/dist/local-classifier.js";

const {
  SECRET_PATTERNS,
  containsSensitiveCredentials,
  evaluateHeuristics,
  classifyLocally,
} = require(MODULE);

// Intentional divergences from the frozen Python reference (security hardening).
const EXPECTED_DIVERGENCES = {
  "github pat": { "is_private": 0.99 },
  "secret beyond the 2000-char window": { "is_private": 0.99, route: "local" },
};

test("matches every frozen Python decision except the declared security fixes", () => {
  const fixture = JSON.parse(fs.readFileSync(GOLDENS, "utf8"));
  const unexpected = [];
  const declaredSeen = new Set();

  for (const entry of fixture.entries) {
    const ts = classifyLocally(entry.input);
    const actual = {
      route: ts.route,
      complexity: ts.scores.complexity,
      is_private: ts.scores.is_private,
      target: ts.scores.target,
    };
    const allowance = EXPECTED_DIVERGENCES[entry.label] || {};

    for (const [key, goldenValue] of Object.entries(entry.expected)) {
      const permitted = allowance[key] !== undefined ? allowance[key] : goldenValue;
      if (actual[key] !== permitted) {
        unexpected.push(
          `${entry.label}: ${key} = ${JSON.stringify(actual[key])}, expected ${JSON.stringify(permitted)}`
        );
      }
      if (allowance[key] !== undefined) declaredSeen.add(`${entry.label}:${key}`);
    }
  }

  assert.deepEqual(unexpected, [], `unexpected divergences:\n${unexpected.join("\n")}`);

  // Every declared divergence must actually happen, so the allowance can never
  // silently mask a regression.
  for (const [label, fields] of Object.entries(EXPECTED_DIVERGENCES)) {
    for (const key of Object.keys(fields)) {
      assert.ok(declaredSeen.has(`${label}:${key}`), `declared divergence did not occur: ${label}:${key}`);
    }
  }
});

test("the hardened cases are genuinely contained", () => {
  const fixture = JSON.parse(fs.readFileSync(GOLDENS, "utf8"));
  const inputFor = (label) => fixture.entries.find((e) => e.label === label).input;

  const pat = classifyLocally(inputFor("github pat"));
  assert.equal(pat.scores.is_private, 0.99, "fine-grained GitHub PAT must be detected");
  assert.equal(pat.route, "local", "a detected credential must never route to the cloud");

  const beyond = classifyLocally(inputFor("secret beyond the 2000-char window"));
  assert.equal(beyond.scores.is_private, 0.99, "a credential outside the complexity window must still be found");
  assert.equal(beyond.route, "local");
  assert.equal(beyond.scores.complexity, 2, "complexity scoring must stay windowed");
});

// ---------------------------------------------------------------------------
// Pattern health
// ---------------------------------------------------------------------------
test("secret patterns are present and non-stateful", () => {
  assert.equal(SECRET_PATTERNS.length, 7, "expected the consolidated pattern set");
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.global, false, `pattern ${pattern} must not use the g flag`);
  }
});

test("repeated classification is stable (no regex lastIndex leakage)", () => {
  const text = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"';
  assert.deepEqual(Array.from({ length: 6 }, () => containsSensitiveCredentials(text)), Array(6).fill(true));
  assert.deepEqual(
    Array.from({ length: 6 }, () => containsSensitiveCredentials("just a normal sentence")),
    Array(6).fill(false)
  );
});

test("credential families are all recognised", () => {
  const samples = {
    "private key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    "fine-grained PAT": "github_pat_" + "a".repeat(22) + "_" + "b".repeat(59),
    "classic PAT": "ghp_" + "a".repeat(36),
    "openai key": "sk-" + "a".repeat(32),
    "aws key": "AKIAIOSFODNN7EXAMPLE",
    "slack token": "xoxb-1234567890-abcdefghij",
    password: 'password: "hunter2hunter2"',
  };
  const missed = Object.entries(samples)
    .filter(([, value]) => !containsSensitiveCredentials(value))
    .map(([name]) => name);
  assert.deepEqual(missed, [], `undetected credential families: ${missed.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Input robustness and thresholds
// ---------------------------------------------------------------------------
test("empty and malformed input never throws", () => {
  for (const input of ["", "   ", "\n\n", undefined, null]) {
    const decision = classifyLocally(input);
    assert.equal(decision.route, "local");
    assert.equal(decision.scores.complexity, 0);
    assert.equal(typeof decision.latencyMs, "number");
  }
  assert.equal(containsSensitiveCredentials(undefined), false);
});

test("complexity thresholds match the documented boundaries", () => {
  assert.equal(evaluateHeuristics("y".repeat(400)).complexity, 0, "400 is not > 400");
  assert.equal(evaluateHeuristics("y".repeat(401)).complexity, 1);
  assert.equal(evaluateHeuristics("y".repeat(1200)).complexity, 1, "1200 is not > 1200");
  assert.equal(evaluateHeuristics("y".repeat(1201)).complexity, 2);
  assert.equal(evaluateHeuristics("y".repeat(3000)).complexity, 2, "3000 is not > 3000");
  assert.equal(evaluateHeuristics("y".repeat(3001)).complexity, 3);
  // lines = count('\n') + 1, so N newlines means N+1 lines.
  assert.equal(evaluateHeuristics("y\n".repeat(39)).complexity, 0, "40 lines, short text");
  assert.equal(evaluateHeuristics("y\n".repeat(40)).complexity, 2, "41 lines");
  assert.equal(evaluateHeuristics("y\n".repeat(99)).complexity, 2, "100 lines is not > 100");
  assert.equal(evaluateHeuristics("y\n".repeat(100)).complexity, 3, "101 lines");
});

test("complex word counting is substring based and case-insensitive", () => {
  assert.equal(evaluateHeuristics("please REFACTOR this").complexity, 2);
  assert.equal(evaluateHeuristics("ASYNCHRONOUS io").complexity, 2, "'async' matches 'asynchronous'");
  assert.equal(evaluateHeuristics("refactor the async architecture").complexity, 3);
  assert.equal(evaluateHeuristics("a plain sentence about cats").complexity, 0);
});

test("complexity stays windowed while secrets are not", () => {
  assert.equal(evaluateHeuristics("x".repeat(3001)).complexity, 3, "direct call sees full length");
  assert.equal(classifyLocally("x".repeat(3001)).scores.complexity, 2, "window caps length at 2000");
  assert.equal(classifyLocally("x".repeat(3001), { windowChars: 5000 }).scores.complexity, 3);

  // A credential far BEHIND the window (start of a long prompt) is still detected...
  const far = 'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789" ' + "filler ".repeat(600);
  assert.equal(classifyLocally(far).scores.is_private, 0.99);

  // ...unless the caller explicitly opts out of the full-text scan.
  const windowed = classifyLocally(far, { scanFullTextForSecrets: false });
  assert.equal(windowed.scores.is_private, 0.05, "opt-out must restore the old windowed behaviour");
});

test("privacy gate outranks the complexity gate", () => {
  const text =
    'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789" ' + "refactor the async architecture ".repeat(50);
  const decision = classifyLocally(text);
  assert.equal(decision.scores.is_private, 0.99);
  assert.ok(decision.scores.complexity >= 2, "the case should be genuinely complex");
  assert.equal(decision.route, "local", "privacy must win");
  assert.match(decision.gate, /Privacy Protection/);
});

test("latency is measured and plausible", () => {
  const decision = classifyLocally("a short prompt");
  assert.equal(typeof decision.latencyMs, "number");
  assert.ok(decision.latencyMs >= 0, "latency must not be negative");
  assert.ok(decision.latencyMs < 1000, "a pure heuristic must not take a second");
});
