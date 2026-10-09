// Oracle: a contract that cannot agree with itself must not settle a file.
//
// The defect this pins is the most dangerous one this plugin can produce, and it is silent. A verdict of
// UNIT_PASSED is what makes a delegated file SETTLED -- readable, attributable, and citable as verified
// work. A non-deterministic oracle -- a property test, a concurrency harness, a race -- can pass a
// broken implementation on the run where the defect simply did not trigger. Under the three-state
// taxonomy that was indistinguishable from a contract that genuinely passed, so a race condition could
// be promoted into the codebase wearing a passing verdict.
//
// UNIT_FLAKY is a statement about the ORACLE, not the code: repeated runs disagreed, so nothing has been
// established about the content either way. It is checked before the unit's own result, because
// reporting either UNIT_PASSED or UNIT_FAILED would pick one arbitrary run and present it as the verdict.
//
// The counter file is alternated by RUN COUNT rather than by generating a random result, so the oracle
// is genuinely non-deterministic from the plugin's point of view while the test itself stays reliable.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// An explicit data directory, so nothing here touches the operator's real registry.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-flaky-data-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";
const REGISTRY = path.join(DATA_DIR, "delegated-registry.json");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-flaky-"));
const emitted = (name) => "```ts file=\"" + name + "\"\nexport const made = 1\n```\n";
const ALLOW = { mode: "allow", allowlist: [], allowInProcessFallback: false, timeoutMs: 30000 };

/** A command that passes or fails depending on how many times it has been run. */
function alternatingOracle() {
  const file = path.join(tmp(), "counter.json");
  fs.writeFileSync(file, "0");
  const command =
    "node -e \"const f=process.argv[1];const fs=require('fs');" +
    "const n=Number(fs.readFileSync(f,'utf8'));fs.writeFileSync(f,String(n+1));" +
    "process.exit(n%2===0?0:1)\" \"" + file + "\"";
  return { command, file, reset: () => fs.writeFileSync(file, "0") };
}

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
    return await delegateWorker(
      { endpoint: "http://127.0.0.1:" + port + "/v1", verificationPolicy: ALLOW, ...params },
      undefined
    );
  } finally {
    server.close();
  }
}

function registryRecord(relativeName) {
  const parsed = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const wanted = relativeName.replace(/\\/g, "/");
  return parsed.records.filter((r) => String(r.path).replace(/\\/g, "/").endsWith(wanted)).pop();
}

test("a contract that disagrees with itself reports FLAKY and never PASSED", async () => {
  const oracle = alternatingOracle();
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("flaky.ts"), {
    taskName: "flaky-oracle",
    instruction: "Write flaky.ts.",
    targetFiles: ["flaky.ts"],
    workspaceDir: dir,
    runVerification: oracle.command,
    verificationRepeats: 4,
  });

  assert.equal(verdict.status, "FLAKY", "disagreement is its own status, not a pass or a failure");
  assert.equal(verdict.success, false, "and it is never a success");

  const record = registryRecord("flaky.ts");
  assert.equal(record.outcome, "UNIT_FLAKY", "the record carries the flaky verdict");
  assert.equal(record.succeeded, false, "and must not claim success");
  assert.notEqual(record.outcome, "UNIT_PASSED", "a flaky contract may never settle a file");
});

test("a flaky verdict does not settle the file, so the read guard refuses it", async () => {
  const { evaluateSettledFile } = require(PLUGIN + "/dist/guard.js");
  const oracle = alternatingOracle();
  const dir = tmp();
  await runAgainstWorker(emitted("flakysettle.ts"), {
    taskName: "flaky-settle",
    instruction: "Write flakysettle.ts.",
    targetFiles: ["flakysettle.ts"],
    workspaceDir: dir,
    runVerification: oracle.command,
    verificationRepeats: 4,
  });

  const record = registryRecord("flakysettle.ts");
  const verdict = evaluateSettledFile(record, record.sha256);
  assert.equal(verdict.allowed, false, "unsettled work is not readable back as settled");
  assert.match(
    String(verdict.reason),
    /disagreed with itself/,
    "and the reason blames the contract rather than claiming the code failed"
  );
});

test("a deterministic contract that passes is unaffected by repeats", async () => {
  // The regression guard for the default path. Adding a flakiness check must not turn an ordinary
  // single-run contract into anything other than what it was.
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("steady.ts"), {
    taskName: "steady-oracle",
    instruction: "Write steady.ts.",
    targetFiles: ["steady.ts"],
    workspaceDir: dir,
    runVerification: "node -e \"process.exit(0)\"",
    verificationRepeats: 3,
  });

  assert.equal(verdict.status, "SUCCESS", "three agreeing runs are a pass");
  assert.equal(registryRecord("steady.ts").outcome, "UNIT_PASSED", "and the file is settled");
});

test("repeats default to one, so an unmodified caller behaves exactly as before", async () => {
  // Imported from the module that defines them. `MAX_VERIFICATION_REPEATS` is a runtime value, and the
  // re-export block on `dist/index.js` that lists it is a TYPE export -- so reading it from the package
  // entry point yields undefined. The first version of this test did that and failed on its own harness
  // rather than on the behaviour, which is the same class of mistake as asserting a counter nobody set.
  const { resolveVerificationRepeats, MAX_VERIFICATION_REPEATS } = require(PLUGIN + "/dist/delegation.js");
  assert.equal(MAX_VERIFICATION_REPEATS, 20, "the cap is a real number, read from where it is defined");
  assert.equal(resolveVerificationRepeats(undefined), 1, "absent means the pre-existing behaviour");
  assert.equal(resolveVerificationRepeats(0), 1, "zero runs is nonsense and falls back to one");
  assert.equal(resolveVerificationRepeats(-3), 1, "so is a negative count");
  assert.equal(resolveVerificationRepeats(2.5), 1, "so is a fractional one");
  assert.equal(resolveVerificationRepeats("4"), 1, "and so is a string");
  assert.equal(
    resolveVerificationRepeats(1e9),
    MAX_VERIFICATION_REPEATS,
    "an unbounded count is a denial-of-service lever through a tool argument, so it is capped"
  );
});
