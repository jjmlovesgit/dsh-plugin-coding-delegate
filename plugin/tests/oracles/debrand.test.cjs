// Contract oracle: author-specific hardware branding must not reach a model, a user, or the package.
//
// This file is the contract, not the implementation. It was written before the change it judges and
// it is not the worker's to edit: a worker that authors the test that scores it is marking its own
// homework, and a contract the executor can rewrite is not a contract.
//
// The publisher's own GPU model was baked into the tool description every user's cloud model reads,
// into the classifier rationale, into the startup benchmark banner, and into the guard's guidance.
// None of that belongs in a plugin that anyone can point at any card.
//
// Scope note: this oracle covers src and dist. Tests and frozen fixtures are excluded on purpose --
// `tests/fixtures/classifier-goldens.json` preserves the original strings as provenance for a
// reference corpus captured from a system that no longer exists, and rewriting provenance to satisfy
// a lint is how a record stops being a record.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");

// `RTX` catches the vendor prefix; the bare model numbers catch prose that dropped it.
const HARDWARE = /\bRTX\b|\b[2345]090\b/i;

// Declared deferral, in the same spirit as local-classifier.test.cjs's EXPECTED_DIVERGENCES: the
// classifier's routing tag is a value inside the frozen golden corpus (`expected.target` is compared
// at local-classifier.test.cjs:41), so renaming it would falsify that fixture. It is an internal
// identifier that reaches no model and no user, so it is tolerated here -- and the assertion below
// requires the allowance to actually be exercised, so it can never quietly widen.
const ALLOWED_TOKENS = ["LOCAL_5090"];

const seenAllowance = new Set();

function brandingIn(text) {
  let stripped = text;
  for (const token of ALLOWED_TOKENS) {
    if (stripped.includes(token)) {
      seenAllowance.add(token);
      stripped = stripped.split(token).join("");
    }
  }
  return HARDWARE.test(stripped);
}

function scanDir(dir) {
  const offenders = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|js)$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (brandingIn(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
      });
  }
  return offenders;
}

test("the shipped source names no specific GPU", () => {
  const offenders = scanDir(path.join(PLUGIN, "src"));
  assert.deepEqual(offenders, [], `hardware branding in src:\n${offenders.join("\n")}`);
});

test("the built output names no specific GPU", () => {
  const offenders = scanDir(path.join(PLUGIN, "dist"));
  assert.deepEqual(offenders, [], `hardware branding in dist:\n${offenders.join("\n")}`);
});

test("the one tolerated identifier is still present, so the allowance stays honest", () => {
  // If the tag is ever renamed this fails and the allowance is retired rather than left to rot.
  assert.deepEqual([...seenAllowance], ALLOWED_TOKENS);
});

test("the tool description a model reads names no hardware and states the worker's blindness", () => {
  const { DELEGATE_WORKER_OPENAI_SCHEMA } = require(path.join(PLUGIN, "dist", "index.js"));
  const description = DELEGATE_WORKER_OPENAI_SCHEMA.function.description;
  assert.equal(brandingIn(description), false, `tool description still branded: ${description}`);
  // The worker never receives file contents, so the schema must say so instead of letting a caller
  // assume the worker can read the repository and discover what it needs.
  assert.match(description, /no repository read/i);
});

test("the benchmark banner is attributed and admits that throughput is hardware-specific", () => {
  const { WORKER_BENCHMARK_SOURCE, WORKER_BENCHMARKS } = require(
    path.join(PLUGIN, "dist", "profiles.js")
  );
  assert.equal(brandingIn(WORKER_BENCHMARK_SOURCE), false);
  assert.match(WORKER_BENCHMARK_SOURCE, /will differ/i);
  assert.ok(Array.isArray(WORKER_BENCHMARKS) && WORKER_BENCHMARKS.length > 0);
});

test("no classifier rationale or gate names hardware, on any route", () => {
  const { classifyLocally } = require(path.join(PLUGIN, "dist", "local-classifier.js"));
  const inputs = [
    "My AWS key is AKIAIOSFODNN7EXAMPLE",
    "password: hunter2",
    "Write a Raft implementation with leader election and log compaction",
    "rename a local variable",
  ];
  for (const input of inputs) {
    const decision = classifyLocally(input);
    assert.equal(brandingIn(decision.rationale), false, `rationale branded: ${decision.rationale}`);
    assert.equal(brandingIn(decision.gate), false, `gate branded: ${decision.gate}`);
  }
});

test("the guard points at a delegation the worker can actually perform", () => {
  const built = fs.readFileSync(path.join(PLUGIN, "dist", "index.js"), "utf8");
  // The old text told the architect to delegate a blocked write to the worker. The worker has no
  // repository read, so for an existing file that advice was impossible to follow.
  assert.match(built, /cannot modify an existing file/i);
  assert.equal(/RTX/.test(built), false);
});
