// Contract oracle: a failed unit's failure locations become the next attempt's context.
//
// Written before the implementation; it fails until the unit exists.
//
// The ordinary cause of a unit that "failed for no visible reason" is that the worker was not shown the
// code it had to change. The architect declares contextFiles from its own reading, and when that reading
// is too narrow the worker guesses -- and the verdict comes back as a failure with a location in it.
//
// That location is already produced. `RedactedFailure.location` carries `file:line` or `file:line:col`,
// and `delegateWorker` already returns it to the architect. It is then discarded.
//
// Recovering it is unusually cheap here, and this is the point: the plugin reads the file and puts it in
// the WORKER's prompt, while the architect receives metadata only. So the loop can widen the worker's view
// on a retry WITHOUT widening the architect's window -- this plugin's own thesis, applied to its own
// failure path. `resolveContextFiles` already caps bytes and validates ranges, so the bounds exist.
//
// Two properties the implementation must keep, and both are asserted below:
//
//   1. It is best-effort. Auto-injected context must NEVER turn a delegation that would have run into a
//      refusal -- an automatic convenience that can fail a unit is worse than no convenience.
//   2. It is once. The locations are consumed by the next attempt and cleared, so an old failure cannot
//      silently influence every later unit in the session.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Delegation persists through rememberDelegated, so redirect the data directory before loading DIST.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-retry-data-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-retry-"));
const write = (dir, name, body) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const emitted = (name) => '```ts file="' + name + '"\nexport const made = 1\n```\n';

// A verification command runs through the approval seam, and the default policy is 'ask' with no approver
// in an oracle, so a call that supplies a command without a policy is refused rather than run. Every test
// here that expects a command to actually execute has to say so explicitly.
const ALLOW = {
  mode: "allow",
  allowlist: [],
  allowInProcessFallback: false,
  timeoutMs: 30000,
};

async function runAgainstWorker(content, params) {
  const { delegateWorker } = require(DIST);
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await delegateWorker({
      ...params,
      endpoint: "http://127.0.0.1:" + port + "/v1",
      timeoutMs: 15000,
    });
  } finally {
    server.close();
  }
}

/** A runner that prints one TAP failure carrying a location, so the redactor keeps it. */
function failingScript(dir, location) {
  return write(
    dir,
    "fail.js",
    [
      "console.log('not ok 1 - the unit broke');",
      "console.log('  ---');",
      "console.log('  location: " + location + "');",
      "console.log('  code: ERR_ASSERTION');",
      "console.log('  error: expected 1 to equal 2');",
      "console.log('  ...');",
    ].join("\n")
  );
}

// ---------------------------------------------------------------- reading a location

test("a file:line:col location is parsed, and so is a bare file:line", () => {
  const { parseFailureLocations } = require(DIST);
  assert.deepEqual(parseFailureLocations([{ location: "src/thing.ts:12:5" }]), [
    { path: "src/thing.ts", line: 12 },
  ]);
  assert.deepEqual(parseFailureLocations([{ location: "test/a.test.js:7" }]), [
    { path: "test/a.test.js", line: 7 },
  ]);
});

test("a Windows drive letter is not mistaken for a line number", () => {
  const { parseFailureLocations } = require(DIST);
  // `C:\src\a.ts:12:5` has three colons in it. Reading the FIRST one gives a "line" of `\src\a.ts`.
  assert.deepEqual(parseFailureLocations([{ location: "C:\\src\\a.ts:12:5" }]), [
    { path: "C:\\src\\a.ts", line: 12 },
  ]);
});

test("failures without a usable location are ignored, not guessed at", () => {
  const { parseFailureLocations } = require(DIST);
  const failures = [
    { kind: "compile", code: "TS1005" },
    { kind: "assertion", message: "no location here" },
    { kind: "assertion", location: "not a location" },
    { kind: "assertion", location: ":12" },
    null,
    undefined,
    {},
  ];
  assert.deepEqual(parseFailureLocations(failures), []);
});

test("lines are deduplicated per file and widened into one window each", () => {
  const { retryContextRequests } = require(DIST);
  const requests = retryContextRequests(
    [
      { path: "src/a.ts", line: 100 },
      { path: "src/a.ts", line: 120 },
      { path: "src/b.ts", line: 5 },
    ],
    10
  );
  assert.equal(requests.length, 2, "one request per file, not per failure");
  const a = requests.find((r) => r.path === "src/a.ts");
  assert.equal(a.startLine, 90, "the window covers the earliest failure in the file");
  assert.equal(a.endLine, 130, "and the latest");
  const b = requests.find((r) => r.path === "src/b.ts");
  assert.equal(b.startLine, 1, "a window cannot start before line 1");
  assert.equal(b.endLine, 15);
});

// ---------------------------------------------------------------- end to end

test("a failed unit's location is injected into the next attempt, once", async () => {
  const dir = tmp();
  write(dir, "src/thing.ts", Array.from({ length: 60 }, (_, i) => "// line " + (i + 1)).join("\n"));
  failingScript(dir, "src/thing.ts:30:5");

  const first = await runAgainstWorker(emitted("out1.ts"), {
    taskName: "unit-one",
    instruction: "Change src/thing.ts.",
    targetFiles: ["out1.ts"],
    workspaceDir: dir,
    runVerification: "node fail.js",
    redactVerification: true,
    verificationPolicy: ALLOW,
  });
  assert.equal(first.status, "VERIFICATION_FAILED", "the first attempt fails");
  assert.ok(
    (first.testResults.failures || []).some((f) => f.location),
    "and the failure carries a location"
  );

  const second = await runAgainstWorker(emitted("out2.ts"), {
    taskName: "unit-one-retry",
    instruction: "Change src/thing.ts, again.",
    targetFiles: ["out2.ts"],
    workspaceDir: dir,
  });
  const injected = second.contextInjected || [];
  assert.equal(injected.length, 1, "the retry is shown the file the failure named");
  assert.match(injected[0].path, /thing\.ts$/);
  assert.ok(injected[0].lineRange, "as a window, not the whole file");

  const third = await runAgainstWorker(emitted("out3.ts"), {
    taskName: "unit-two",
    instruction: "Something unrelated.",
    targetFiles: ["out3.ts"],
    workspaceDir: dir,
  });
  assert.equal((third.contextInjected || []).length, 0, "and it is consumed, not carried forward");
});

test("a unit that passed leaves nothing to inject", async () => {
  const dir = tmp();
  write(dir, "src/other.ts", "export const x = 1\n");

  const first = await runAgainstWorker(emitted("ok1.ts"), {
    taskName: "passing",
    instruction: "Write ok1.ts.",
    targetFiles: ["ok1.ts"],
    workspaceDir: dir,
    runVerification: 'node -e "process.exit(0)"',
    redactVerification: true,
    verificationPolicy: ALLOW,
  });
  assert.equal(first.success, true);

  const second = await runAgainstWorker(emitted("ok2.ts"), {
    taskName: "next",
    instruction: "Write ok2.ts.",
    targetFiles: ["ok2.ts"],
    workspaceDir: dir,
  });
  assert.equal((second.contextInjected || []).length, 0, "a success must not seed a retry");
});

test("automatic context never turns a workable delegation into a refusal", async () => {
  const dir = tmp();
  // The failure names a file that does not exist. Injecting it would make resolveContextFiles refuse the
  // whole injection, and the unit would die for a reason the architect never asked for.
  failingScript(dir, "src/gone.ts:4:1");
  await runAgainstWorker(emitted("r1.ts"), {
    taskName: "seed",
    instruction: "First.",
    targetFiles: ["r1.ts"],
    workspaceDir: dir,
    runVerification: "node fail.js",
    redactVerification: true,
    verificationPolicy: ALLOW,
  });

  const second = await runAgainstWorker(emitted("r2.ts"), {
    taskName: "retry",
    instruction: "Second.",
    targetFiles: ["r2.ts"],
    workspaceDir: dir,
  });
  assert.notEqual(second.status, "CONTEXT_REFUSED", "an unrunnable auto-injection must be dropped");
  // No verification was requested, so the honest status is UNVERIFIED -- the same one an unseeded call
  // gets. What matters is that the dropped injection left no trace: the work ran and the file landed.
  assert.equal(second.status, "UNVERIFIED", "and the unit proceeds exactly as it would have without it");
  assert.deepEqual(second.filesWritten, [path.join(dir, "r2.ts")], "the work still ran and was written");
});
