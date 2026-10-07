// Oracle for the two silent-green defects.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseTestOutput,
  runSandboxVerification,
  runInProcessFallback,
  extractAndEmitFiles,
} = require(require("node:path").resolve(__dirname, "..", "..", "dist", "index.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lr-emitcheck-"));

// The sandbox-verification tests run commands with `cwd: TMP`, so it must exist
// first — otherwise spawn fails with ENOENT and the "failure" test passes for the
// wrong reason.
fs.mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------------------
// Defect C — a failing command must never report success
// ---------------------------------------------------------------------------
test("C: tsc-style errors with a non-zero exit are reported as FAILED", () => {
  // This is the exact output that previously scored passed=1, failed=0.
  const tscOutput = [
    "src/local-classifier.ts(1,1): error TS1434: Unexpected keyword or identifier.",
    "src/local-classifier.ts(1,77): error TS1002: Unterminated string literal.",
    "src/local-classifier.ts(7,2): error TS1161: Unterminated regular expression literal.",
  ].join("\r\n");

  const result = parseTestOutput(tscOutput, 1);
  assert.ok(result.failed >= 1, `expected a failure, got passed=${result.passed} failed=${result.failed}`);
  assert.equal(result.passed, 0);
  assert.ok(result.errorSummary, "a failure summary is required");
});

test("C: tsc-style errors are ALSO caught without an exit code", () => {
  const result = parseTestOutput("src/a.ts(1,1): error TS1434: Unexpected keyword.", undefined);
  assert.ok(result.failed >= 1, "lowercase 'error' must be treated as a failure marker");
});

test("C: a silent non-zero exit is a failure", () => {
  const result = parseTestOutput("", 2);
  assert.equal(result.failed, 1);
  assert.equal(result.passed, 0);
});

test("C: a silent clean exit is not a failure", () => {
  const result = parseTestOutput("", 0);
  assert.equal(result.failed, 0);
});

test("C: genuine success output still passes", () => {
  assert.equal(parseTestOutput("all checks passed", 0).passed, 1);
  assert.equal(parseTestOutput("ok 1 - thing\nok 2 - other\n", 0).passed, 2);
  assert.equal(parseTestOutput("not ok 1 - broken\n", 1).failed, 1);
});

test("C: check and cross marks are parsed as passes and failures", () => {
  // The check/cross regex previously held double-encoded mojibake, so it matched the
  // corrupted string rather than real marks, and this branch never fired. Escapes keep
  // this test file ASCII-clean and unambiguous.
  const CHECK = "\u2713";
  const HEAVY_CHECK = "\u2714";
  const CROSS = "\u2715";
  const HEAVY_CROSS = "\u2716";

  assert.equal(parseTestOutput(`${CHECK} renders the card`, 0).passed, 1);
  assert.equal(parseTestOutput(`${HEAVY_CHECK} mounts the plugin`, 0).passed, 1);
  assert.ok(parseTestOutput(`${CROSS} fails to mount`, 1).failed >= 1);
  assert.ok(parseTestOutput(`${HEAVY_CROSS} breaks on boot`, 1).failed >= 1);

  // A mark must not count as a pass when the same line also reports a failure.
  assert.equal(parseTestOutput(`${CHECK} passed but FAILED overall`, 1).passed, 0);
});

test("C: runSandboxVerification reports a failing command as failed", () => {
  const result = runSandboxVerification('node -e "process.exit(3)"', TMP);
  assert.ok(result.failed >= 1, `expected failure, got passed=${result.passed} failed=${result.failed}`);
});

test("C: a passing verification command is not reported as failed", () => {
  // Driven through a real module so the assertion holds on both a normal host
  // (execSync runs it) and a sandboxed host (EPERM -> in-process fallback).
  // NOTE: a bare `node -e "..."` cannot be verified on a sandboxed host, so it
  // correctly fails closed there; asserting it "passes" would be host-dependent.
  fs.writeFileSync(path.join(TMP, "pass.test.cjs"), 'console.log("ok 1 - fine");\n', "utf8");
  const result = runSandboxVerification("node pass.test.cjs", TMP, {
    allowInProcessFallback: true,
  });
  assert.equal(result.failed, 0, `unexpected failure: ${result.errorSummary}`);
});

test("C: a sandbox EPERM fails closed unless the in-process fallback is enabled", () => {
  // The fallback re-runs model-influenced code inside the SERVER process. Answering a
  // sandbox denial by removing the sandbox inverts the control, so the default refuses.
  fs.writeFileSync(path.join(TMP, "pass-default.test.cjs"), 'console.log("ok 1 - fine");\n', "utf8");
  const result = runSandboxVerification("node pass-default.test.cjs", TMP);
  if (result.failed === 0) return; // an unsandboxed host can spawn; no fallback involved
  assert.match(
    String(result.errorSummary || result.output),
    /in-process fallback is disabled|EPERM/i
  );
});

test("C: a failing verification module is reported as failed", () => {
  fs.writeFileSync(
    path.join(TMP, "fail.test.cjs"),
    'console.log("ok 1 - first"); throw new Error("boom");\n',
    "utf8"
  );
  const result = runSandboxVerification("node fail.test.cjs", TMP);
  assert.ok(result.failed >= 1, `expected a failure, got passed=${result.passed}`);
});

// ---------------------------------------------------------------------------
// Defect D — the in-process fallback's target detection
// ---------------------------------------------------------------------------
test("D: flags are not mistaken for file paths", () => {
  const version = runInProcessFallback("node --version", TMP);
  assert.doesNotMatch(version, /Target test file/, "a flag must never be treated as a file");
  const evalCmd = runInProcessFallback('node -e "console.log(1)"', TMP);
  assert.doesNotMatch(evalCmd, /Target test file/);
});

test("D: an unidentifiable command fails closed instead of claiming success", () => {
  for (const cmd of ["node --version", 'node -e "console.log(1)"', "git status"]) {
    const out = runInProcessFallback(cmd, TMP);
    assert.match(out, /^not ok/m, `must fail closed for: ${cmd}`);
    assert.match(out, /could not identify a target module/);
  }
});

test("D: a real test module is still executed in-process", () => {
  fs.writeFileSync(
    path.join(TMP, "ok.test.cjs"),
    'console.log("ok 1 - fine"); console.log("ok 2 - also fine");\n',
    "utf8"
  );
  const passed = runInProcessFallback("node ok.test.cjs", TMP);
  assert.match(passed, /^ok 1/m, `expected a pass, got: ${passed.slice(0, 120)}`);

  fs.writeFileSync(
    path.join(TMP, "bad.test.cjs"),
    'console.log("ok 1 - first"); throw new Error("boom");\n',
    "utf8"
  );
  const failed = runInProcessFallback("node bad.test.cjs", TMP);
  assert.match(failed, /not ok/, "a throwing module must be reported as failing");
});

// ---------------------------------------------------------------------------
// Defect B — never clobber a real file with non-code output
// ---------------------------------------------------------------------------
function seedBigFile(name, bytes) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, name);
  fs.writeFileSync(p, "// real module\n" + "export const x = 1\n".repeat(bytes / 19), "utf8");
  return { path: p, size: fs.statSync(p).size };
}

test("B: a tool-call transcript is refused instead of written", () => {
  const { path: target, size } = seedBigFile("guarded.ts", 3000);
  const transcript = [
    "I'll start by reading the existing file to understand its current structure.",
    "",
    "<tool_call>",
    "<function=Read>",
    "<parameter=file_path>",
    "src/guarded.ts",
    "</parameter>",
    "</function>",
    "</tool_call>",
  ].join("\n");

  const result = extractAndEmitFiles(transcript, ["guarded.ts"], TMP);
  assert.equal(result.filesWritten.length, 0, "nothing should be written");
  assert.ok(result.errors.length >= 1, "the refusal must be reported as an error");
  assert.match(result.errors[0], /does not look like source code/);
  assert.equal(fs.statSync(target).size, size, "the existing file must be untouched");
});

test("B: a drastic shrink over an existing file is refused", () => {
  const { path: target, size } = seedBigFile("shrunk.ts", 3000);
  // A well-formed fenced block, but tiny compared to what is already there.
  const tiny = '```ts file="shrunk.ts"\nexport const x = 1\n```';

  const result = extractAndEmitFiles(tiny, ["shrunk.ts"], TMP);
  assert.equal(result.filesWritten.length, 0);
  assert.ok(result.errors.length >= 1);
  assert.match(result.errors[0], /more than 50% smaller/);
  assert.equal(fs.statSync(target).size, size, "the existing file must be untouched");
});

test("B: legitimate writes still work", () => {
  const fresh = path.join(TMP, "fresh-module.ts");
  fs.rmSync(fresh, { force: true });
  const result = extractAndEmitFiles(
    '```ts file="fresh-module.ts"\nexport const greeting = (n: string) => `hi ${n}`\n```',
    ["fresh-module.ts"],
    TMP
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.filesWritten.length, 1);
  assert.ok(fs.readFileSync(fresh, "utf8").includes("greeting"));
});

test("B: growing an existing file is allowed", () => {
  const p = path.join(TMP, "growing.ts");
  fs.writeFileSync(p, "export const a = 1\n", "utf8");
  const bigger = '```ts file="growing.ts"\nexport const a = 1\nexport const b = 2\nexport const c = 3\n```';
  const result = extractAndEmitFiles(bigger, ["growing.ts"], TMP);
  assert.equal(result.errors.length, 0);
  assert.ok(fs.readFileSync(p, "utf8").includes("export const c = 3"));
});
