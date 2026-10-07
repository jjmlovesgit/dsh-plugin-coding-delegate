// Oracle for verification-output redaction.
// The property under test: structure reaches the architect, source never does.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const {
  parseTestOutput,
  redactVerificationOutput,
  describeFailures,
  runSandboxVerification,
} = require(PLUGIN + "/dist/index.js");

// Distinctive strings that must NEVER survive redaction.
const CANARY_FN = "computeQuarterlyTotal";
const CANARY_CONST = "const secretSauce = 'do-not-leak'";
const CANARY_DIFF = '+ const leakedLine = 42;';

const TAP_WITH_SOURCE = [
  "TAP version 13",
  "ok 1 - renders the card",
  "ok 2 - mounts the plugin",
  "not ok 3 - totals are correct",
  "  ---",
  "  duration_ms: 12.3",
  "  type: 'test'",
  "  location: 'C:\\\\repo\\\\tests\\\\totals.test.ts:88:5'",
  "  failureType: 'testCodeFailure'",
  "  error: 'totals must match the ledger'",
  "  code: 'ERR_ASSERTION'",
  "  expected: 1284.5",
  "  actual: 1283.5",
  "  operator: 'strictEqual'",
  "  stack: |-",
  "    AssertionError [ERR_ASSERTION]: totals must match the ledger",
  `    at ${CANARY_FN} (file:///C:/repo/src/totals.ts:41:12)`,
  `    ${CANARY_CONST}`,
  `  ${CANARY_DIFF}`,
  "  ...",
  "1..3",
  "# tests 3",
  "# pass 2",
  "# fail 1",
].join("\n");

test("TAP failures are reduced to name, location, code and prose", () => {
  const failures = redactVerificationOutput(TAP_WITH_SOURCE);
  assert.equal(failures.length, 1);
  const f = failures[0];
  assert.equal(f.kind, "assertion");
  assert.match(f.name, /3\. totals are correct/);
  assert.match(f.location, /totals\.test\.ts:88:5/);
  assert.equal(f.code, "ERR_ASSERTION");
  assert.equal(f.message, "totals must match the ledger");
});

test("no source survives redaction", () => {
  const failures = redactVerificationOutput(TAP_WITH_SOURCE);
  const rendered = describeFailures(failures).join("\n");
  for (const canary of [CANARY_FN, CANARY_CONST, CANARY_DIFF, "secretSauce", "leakedLine", "expected:", "actual:", "stack:"]) {
    assert.ok(!rendered.includes(canary), `leaked: ${canary}`);
  }
});

test("a code-shaped assertion message is dropped, not forwarded", () => {
  const raw = [
    "not ok 1 - compares objects",
    "  location: 'tests/obj.test.ts:10:3'",
    "  error: 'expected { a: 1 } to equal { a: 2 }'",
    "  ...",
  ].join("\n");
  const [f] = redactVerificationOutput(raw);
  assert.equal(f.message, undefined, "code-shaped message must be dropped");
  assert.match(f.location, /obj\.test\.ts:10:3/, "the location still identifies it");
});

test("compile errors become file:line + code + short message", () => {
  const raw = [
    "src/local-classifier.ts(1,1): error TS1434: Unexpected keyword or identifier.",
    "src/local-classifier.ts(7,2): error TS1161: Unterminated regular expression literal.",
  ].join("\n");
  const failures = redactVerificationOutput(raw);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].kind, "compile");
  assert.equal(failures[0].location, "src/local-classifier.ts:1:1");
  assert.equal(failures[0].code, "TS1434");
  assert.match(failures[0].message, /Unexpected keyword/);
});

test("counts are preserved and the summary is structured", () => {
  const result = parseTestOutput(TAP_WITH_SOURCE, 1);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.redacted, true);
  assert.match(result.output, /^1 failed, 2 passed \(exit 1\)/);
  assert.match(result.output, /\[assertion\]/);
  for (const canary of [CANARY_FN, CANARY_CONST, "stack:", "actual:"]) {
    assert.ok(!result.output.includes(canary), `summary leaked: ${canary}`);
  }
});

test("the escape hatch returns raw output", () => {
  const result = parseTestOutput(TAP_WITH_SOURCE, 1, { redact: false });
  assert.equal(result.redacted, false);
  assert.ok(result.output.includes(CANARY_CONST), "raw mode should keep everything");
});

test("a failure with no extractable structure says so instead of guessing", () => {
  const result = parseTestOutput("something exploded in a way we cannot parse", 1);
  assert.equal(result.failed, 1);
  assert.match(result.output, /no structured failure could be extracted/);
});

test("raw output is persisted locally and referenced by path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-"));
  const rawLog = path.join(dir, "last-verification.log");
  const result = parseTestOutput(TAP_WITH_SOURCE, 1, { rawOutputPath: rawLog });

  // parseTestOutput itself does not write; runSandboxVerification does. Assert the
  // contract it relies on: the path is carried through so the caller can point at it.
  assert.equal(result.rawOutputPath, rawLog);
  assert.match(result.output, /raw output:/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("end to end: a failing command returns structure and keeps the raw text local", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-e2e-"));
  const script = path.join(dir, "suite.test.cjs");

  // Build the fixture with JSON.stringify so quoting can never produce a syntax error
  // (an earlier hand-escaped version did exactly that, and the "raw" log held the
  // SyntaxError rather than the TAP output being tested).
  const say = (s) => `console.log(${JSON.stringify(s)});`;
  fs.writeFileSync(
    script,
    [
      say("ok 1 - fine"),
      say("not ok 2 - totals are correct"),
      say("  location: 'tests/totals.test.ts:88:5'"),
      say("  error: 'totals must match the ledger'"),
      say("  code: 'ERR_ASSERTION'"),
      say(`    at ${CANARY_FN} (src/totals.ts:41:12)`),
      say(`    ${CANARY_CONST}`),
      say(`  ${CANARY_DIFF}`),
      "process.exitCode = 1;",
    ].join("\n"),
    "utf8"
  );

  const rawLog = path.join(dir, "last-verification.log");
  // The in-process fallback is opt-in now (it runs worker-authored code inside the server
  // process), so a sandboxed host needs it enabled to exercise redaction end to end.
  const result = runSandboxVerification(`node ${script}`, dir, {
    rawLogPath: rawLog,
    allowInProcessFallback: true,
  });

  assert.equal(result.failed, 1);
  assert.equal(result.redacted, true);
  assert.ok(!result.output.includes(CANARY_FN), "redacted summary must not carry the function name");
  assert.ok(!result.output.includes("secretSauce"), "redacted summary must not carry source");
  assert.ok(!result.output.includes("leakedLine"), "redacted summary must not carry a diff line");

  assert.ok(fs.existsSync(rawLog), "the raw log must exist locally");
  const raw = fs.readFileSync(rawLog, "utf8");
  assert.ok(raw.includes("totals must match the ledger"), "raw keeps full detail for the worker");
  assert.ok(raw.includes(CANARY_FN), "raw keeps the stack for the worker");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("test code calling process.exit cannot kill the host process", () => {
  // The in-process fallback requires the module into the SERVER process, so a
  // process.exit() in worker-authored test code used to take the harness down.
  // Reaching the end of this test is itself the assertion that the host survived.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-exit-"));
  const script = path.join(dir, "exits.test.cjs");
  fs.writeFileSync(script, 'console.log("ok 1 - before");\nprocess.exit(7);\n', "utf8");

  const rawLog = path.join(dir, "raw.log");
  const result = runSandboxVerification(`node ${script}`, dir, {
    redact: false,
    rawLogPath: rawLog,
    allowInProcessFallback: true,
  });

  const captured = String(result.output) + (fs.existsSync(rawLog) ? fs.readFileSync(rawLog, "utf8") : "");
  const usedFallback = /refusing to terminate the host process|In-Process Test Failure/.test(captured);

  assert.ok(result.passed + result.failed > 0, "a result must be produced either way");
  if (usedFallback) {
    assert.match(captured, /refusing to terminate the host process/, "the exit must be blocked, not obeyed");
  } else {
    // Unsandboxed host: the child process exited and its status is authoritative.
    assert.equal(result.failed >= 1, true, "a non-zero child exit is a failure");
  }

  fs.rmSync(dir, { recursive: true, force: true });
});
