// Regression oracles for the external security review (report.md, revision 7c5d635).
//
// Each test corresponds to one reported finding and fails against the pre-remediation
// build:
//   F1 delegated verification command -> host shell          (CWE-78)
//   F2 delegated write escapes the workspace                 (CWE-22)
//   F3 verification label leaks local output to the cloud    (CWE-201)
//   F4 cloud shell write bypasses the source guard           (CWE-863)
//   F5 earlier-conversation secrets bypass the DLP gate      (CWE-201)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin resolves its log/data dir from DSH_HOME at require time, so point it at a
// scratch directory before loading the module.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const {
  apply,
  extractAndEmitFiles,
  evaluateEmissionPath,
  isPathWithin,
  redactVerificationOutput,
  parseTestOutput,
  hasCommandWriteSignal,
  evaluateCodeWriteGuard,
  evaluateVerificationPolicy,
  commandProgram,
  DEFAULT_VERIFICATION_POLICY,
  runSandboxVerification,
} = require(PLUGIN + "/dist/index.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "secfix-"));
const shell = (command) => ({ name: "pwsh", arguments: { command } });
const SECRET = 'password: "hunter2hunter2"';

// ---------------------------------------------------------------------------
// F1 — a model-supplied verification command must not run unattended
// ---------------------------------------------------------------------------
test("F1: verification defaults to requiring approval, not silent execution", () => {
  assert.equal(DEFAULT_VERIFICATION_POLICY.mode, "ask");
  assert.equal(DEFAULT_VERIFICATION_POLICY.allowInProcessFallback, false);

  const decision = evaluateVerificationPolicy("node tests/x.test.cjs");
  assert.equal(decision.kind, "ask", "an unapproved command must not be permitted");
  assert.match(decision.reason, /full authority/i);
});

test("F1: an operator can still permit verification explicitly", () => {
  assert.equal(
    evaluateVerificationPolicy("node x.test.cjs", { mode: "allow", allowlist: [], allowInProcessFallback: false }).kind,
    "allow"
  );
  assert.equal(
    evaluateVerificationPolicy("node x.test.cjs", { mode: "deny", allowlist: [], allowInProcessFallback: false }).kind,
    "deny"
  );
  // The allowlist matches the program only, which is why it is documented as weak.
  assert.equal(
    evaluateVerificationPolicy("node -e \"whatever\"", { mode: "ask", allowlist: ["node"], allowInProcessFallback: false }).kind,
    "allow"
  );
  assert.equal(
    evaluateVerificationPolicy("node x.test.cjs", { mode: "ask", allowlist: ["npm"], allowInProcessFallback: false }).kind,
    "ask"
  );
});

test("F1: the allowlist compares programs, not paths", () => {
  assert.equal(commandProgram("node x.js"), "node");
  assert.equal(commandProgram('"C:\\Program Files\\nodejs\\node.exe" x.js'), "node");
  assert.equal(commandProgram("  npm   run test"), "npm");
  assert.equal(evaluateVerificationPolicy("").kind, "deny");
});

test("F1: verification runs as a subprocess in confined mode, with no in-process fallback", () => {
  // DSH's confined sandbox modes refuse a piped spawn, which is why the plugin now captures
  // through file descriptors. Before that, the only path that worked on a confined host was
  // the in-process fallback -- so this asserts the ordinary subprocess path needs no opt-in,
  // and that most operators therefore need no container to have working verification.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-subprocess-"));
  fs.writeFileSync(path.join(dir, "pass.test.cjs"), 'console.log("ok 1 - fine");\n', "utf8");

  const result = runSandboxVerification("node pass.test.cjs", dir);

  assert.equal(
    result.failed,
    0,
    `verification must pass without a fallback: ${result.errorSummary || result.output}`
  );
  assert.equal(result.passed, 1);
});

test("F1: a failing subprocess command is still reported as failed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-subprocess-fail-"));
  fs.writeFileSync(path.join(dir, "fail.test.cjs"), 'console.log("not ok 1 - broken");\nprocess.exitCode = 1;\n', "utf8");

  const result = runSandboxVerification("node fail.test.cjs", dir);

  assert.ok(result.failed >= 1, `expected a failure, got passed=${result.passed}`);
});

// ---------------------------------------------------------------------------
// F2 — a delegated write must stay inside the workspace
// ---------------------------------------------------------------------------
test("F2: containment rejects traversal and absolute escapes", () => {
  assert.equal(evaluateEmissionPath(path.join(TMP, "src", "a.ts"), TMP).allowed, true);
  assert.equal(evaluateEmissionPath(path.join(TMP, "..", "escape.ts"), TMP).allowed, false);
  assert.equal(evaluateEmissionPath(path.join(TMP, "a", "..", "..", "escape.ts"), TMP).allowed, false);

  const elsewhere = path.join(path.dirname(TMP), "outside-" + path.basename(TMP) + ".ts");
  assert.equal(evaluateEmissionPath(elsewhere, TMP).allowed, false);

  // An explicit operator allowlist is the only way out.
  assert.equal(evaluateEmissionPath(elsewhere, TMP, [path.dirname(TMP)]).allowed, true);
});

test("F2: a sibling directory sharing a name prefix is not 'inside'", () => {
  assert.equal(isPathWithin("C:\\a\\b", "C:\\a\\bb\\c.ts"), false);
  assert.equal(isPathWithin("C:\\a\\b", "C:\\a\\b\\c.ts"), true);
  assert.equal(isPathWithin("C:\\a\\b", "C:\\a\\b"), true);
});

test("F2: a traversal path in worker output is refused, not written", () => {
  const base = path.join(TMP, "workspace");
  fs.mkdirSync(base, { recursive: true });
  const escapeTarget = path.join(TMP, "escaped-by-worker.ts");
  if (fs.existsSync(escapeTarget)) fs.rmSync(escapeTarget);

  const content = ['```typescript file="' + path.join("..", "escaped-by-worker.ts") + '"', "export const x = 1", "```"].join("\n");
  const result = extractAndEmitFiles(content, undefined, base);

  assert.equal(result.filesWritten.length, 0, "no file may be written outside the workspace");
  assert.equal(fs.existsSync(escapeTarget), false, "the escape target must not exist");
  assert.ok(result.errors.length > 0, "the refusal must be reported, not silent");
  assert.match(result.errors.join(" "), /outside the session workspace/i);
});

test("F2: an absolute path outside the workspace is refused", () => {
  const base = path.join(TMP, "workspace2");
  fs.mkdirSync(base, { recursive: true });
  const outside = path.join(TMP, "absolute-escape.ts");
  if (fs.existsSync(outside)) fs.rmSync(outside);

  const content = ['```typescript file="' + outside + '"', "export const y = 2", "```"].join("\n");
  const result = extractAndEmitFiles(content, undefined, base);

  assert.equal(fs.existsSync(outside), false, "an absolute path must not escape containment");
  assert.ok(result.errors.length > 0);
});

test("F2: legitimate in-workspace writes still work", () => {
  const base = path.join(TMP, "workspace3");
  fs.mkdirSync(base, { recursive: true });
  const content = ['```typescript file="src/inside.ts"', "export const ok = true", "```"].join("\n");
  const result = extractAndEmitFiles(content, undefined, base);

  assert.equal(result.errors.length, 0, `unexpected refusal: ${result.errors.join("; ")}`);
  assert.equal(result.filesWritten.length, 1);
  assert.equal(fs.existsSync(path.join(base, "src", "inside.ts")), true);
});

test("F2: a symlink inside the workspace cannot be used to escape it", () => {
  const base = path.join(TMP, "workspace4");
  const outsideDir = path.join(TMP, "outside-dir");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const link = path.join(base, "link.ts");
  try {
    fs.symlinkSync(outsideDir, link, "junction");
  } catch {
    return; // creating a link needs privileges on some hosts; skip rather than fail
  }
  const target = path.join(link, "via-symlink.ts");
  const verdict = evaluateEmissionPath(target, base);
  assert.equal(verdict.allowed, false, "a symlink must not defeat containment");
});

// ---------------------------------------------------------------------------
// F3 — retained failure fields must not carry secrets to the cloud
// ---------------------------------------------------------------------------
test("F3: a secret in a TAP failure label does not reach the receipt", () => {
  const tap = ["TAP version 13", "ok 1 - fine", `not ok 2 - auth broke for ${SECRET}`, "  location: 'tests/auth.test.ts:12:3'", "  code: 'ERR_ASSERTION'"].join("\n");

  const failures = redactVerificationOutput(tap);
  const serialized = JSON.stringify(failures);

  assert.ok(!serialized.includes("hunter2hunter2"), `secret survived redaction: ${serialized}`);
  assert.ok(serialized.includes("redacted"), "the offending field must be replaced by a marker");
});

test("F3: parseTestOutput keeps the secret out of every returned field", () => {
  const tap = ["TAP version 13", `not ok 1 - leaked ${SECRET}`, "  code: 'ERR_ASSERTION'", "1..1"].join("\n");
  const result = parseTestOutput(tap, 1, { redact: true });

  const everything = JSON.stringify(result);
  assert.ok(!everything.includes("hunter2hunter2"), `secret leaked through the receipt: ${everything}`);
  assert.equal(result.failed, 1);
  assert.equal(result.redacted, true);
});

test("F3: ordinary failure names still travel (no over-redaction)", () => {
  const tap = ["TAP version 13", "not ok 3 - totals are correct", "  location: 'tests/totals.test.ts:88:5'", "  code: 'ERR_ASSERTION'"].join("\n");
  const failures = redactVerificationOutput(tap);

  assert.equal(failures.length, 1);
  assert.match(String(failures[0].name), /totals are correct/);
  assert.equal(failures[0].location, "tests/totals.test.ts:88:5");
  assert.equal(failures[0].code, "ERR_ASSERTION");
});

test("F3: retained fields are length-bounded", () => {
  const long = "x".repeat(400);
  const failures = redactVerificationOutput(["not ok 1 - " + long].join("\n"));
  assert.equal(failures.length, 1);
  assert.ok(String(failures[0].name).length < 400, "an unbounded label must be truncated");
  assert.match(String(failures[0].name), /\[truncated\]/);
});

// ---------------------------------------------------------------------------
// F4 — shell writes the old patterns missed must be caught
// ---------------------------------------------------------------------------
test("F4: inline program text and file verbs count as write signals", () => {
  assert.equal(hasCommandWriteSignal('python -c "open(\'src/x.ts\',\'w\')"'), true);
  assert.equal(hasCommandWriteSignal('node -e "require(\'fs\').writeFileSync(\'src/a.ts\',\'\')"'), true);
  assert.equal(hasCommandWriteSignal("cp a.ts b.ts"), true);
  assert.equal(hasCommandWriteSignal("git checkout src/index.ts"), true);
  assert.equal(hasCommandWriteSignal("echo hi > src/x.ts"), true);
});

test("F4: read-only commands stay silent (no false positives)", () => {
  assert.equal(hasCommandWriteSignal("git diff src/index.ts"), false);
  assert.equal(hasCommandWriteSignal("grep -n foo src/index.ts"), false);
  assert.equal(hasCommandWriteSignal("node tests/x.test.cjs"), false);
  assert.equal(hasCommandWriteSignal("echo done 2>&1"), false);
});

test("F4: the bypasses found in review now ask for approval", () => {
  const bypasses = [
    'python -c "open(\'src/x.ts\',\'w\').write(\'\')"',
    'node -e "require(\'fs\').writeFileSync(\'src/a.ts\',\'\')"',
    "cp a.ts b.ts",
    "git checkout src/index.ts",
    "sed -i s/a/b/ src/x.ts",
    "Move-Item src/a.ts src/b.ts",
  ];
  for (const command of bypasses) {
    const verdict = evaluateCodeWriteGuard(shell(command));
    assert.ok(verdict, `bypass was allowed silently: ${command}`);
    assert.equal(verdict.kind, "ask");
  }
});

test("F4: read-only shell commands are still allowed", () => {
  for (const command of ["git diff src/index.ts", "grep -n foo src/index.ts", "node tests/x.test.cjs", "git status"]) {
    assert.equal(evaluateCodeWriteGuard(shell(command)), null, `false positive on: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// F5 — the DLP gate must see earlier conversation, not just the newest message
// ---------------------------------------------------------------------------
function mount(options) {
  const handlers = new Map();
  const ctx = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    get: () => undefined,
    tools: undefined,
  };
  apply(ctx, options);
  return handlers;
}

const BASE_OPTIONS = {
  localCodeGuard: false,
  enforceDLP: true,
  dlpAction: "local",
  localProvider: "lm-studio",
  cloudProvider: "deepseek-official",
  localModel: "qwen/qwen3.8-27b",
  cloudModel: "deepseek-chat",
};

test("F5: a credential from an earlier turn keeps the gate closed", async () => {
  const handlers = mount(BASE_OPTIONS);
  const preStep = handlers.get("agent/pre-step")[0];
  const request = handlers.get("agent/request")[0];
  const agent = { id: "session-with-earlier-secret" };

  // Turn 1 carries the credential.
  await preStep(
    { turn: 1, agent, messages: [{ role: "user", content: `here is my key ${SECRET}` }] },
    async () => ({ kind: "enter" })
  );

  // Turn 2 is clean. Before the fix only this message was scanned, so the request was
  // pinned to the cloud while the host re-sent the whole conversation.
  const config = await request(
    { turn: 2, agent },
    async () => ({ provider: "deepseek-official", model: "deepseek-chat", tools: [] })
  );

  assert.equal(config.provider, "lm-studio", "an earlier credential must keep the request local");
});

test("F5: a clean session is still routed to the cloud", async () => {
  const handlers = mount(BASE_OPTIONS);
  const preStep = handlers.get("agent/pre-step")[0];
  const request = handlers.get("agent/request")[0];
  const agent = { id: "session-without-secrets" };

  await preStep(
    { turn: 1, agent, messages: [{ role: "user", content: "please refactor the table controller" }] },
    async () => ({ kind: "enter" })
  );

  const config = await request(
    { turn: 2, agent },
    async () => ({ provider: "deepseek-official", model: "deepseek-chat", tools: [] })
  );

  assert.equal(config.provider, "deepseek-official", "the gate must not pin clean sessions local");
});

test("F5: the block message describes what is actually scanned", async () => {
  const handlers = mount({ ...BASE_OPTIONS, dlpAction: "block" });
  const preStep = handlers.get("agent/pre-step")[0];
  const request = handlers.get("agent/request")[0];
  const agent = { id: "session-blocked" };

  await preStep(
    { turn: 1, agent, messages: [{ role: "user", content: `key ${SECRET}` }] },
    async () => ({ kind: "enter" })
  );

  await assert.rejects(
    () => request({ turn: 2, agent }, async () => ({ provider: "deepseek-official", model: "deepseek-chat", tools: [] })),
    /DLP firewall blocked/
  );
});
