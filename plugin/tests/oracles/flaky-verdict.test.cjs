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

test("repeats default to three, so an undeclared oracle is still protected", async () => {
  // Imported from the module that defines them. `MAX_VERIFICATION_REPEATS` is a runtime value, and the
  // re-export block on `dist/index.js` that lists it is a TYPE export -- so reading it from the package
  // entry point yields undefined. The first version of this test did that and failed on its own harness
  // rather than on the behaviour, which is the same class of mistake as asserting a counter nobody set.
  const {
    resolveVerificationRepeats,
    DEFAULT_VERIFICATION_REPEATS,
    MAX_VERIFICATION_REPEATS,
  } = require(PLUGIN + "/dist/delegation.js");

  // The default is the whole point of this state: a caller who does not KNOW their oracle is flaky must
  // still be protected, so the guardrail cannot be opt-in.
  assert.equal(DEFAULT_VERIFICATION_REPEATS, 3, "three passes is the integrity default");
  assert.equal(MAX_VERIFICATION_REPEATS, 20, "the cap is a real number, read from where it is defined");
  assert.equal(resolveVerificationRepeats(undefined), 3, "absent means three, not one");
  assert.equal(resolveVerificationRepeats(null), 3, "and so does null");

  // A nonsense value falls back to the safe default rather than to a single run: a caller who passed
  // garbage has not asked to skip the flakiness check, and silently downgrading to 1 would be the worst
  // of both -- no validation, and no protection.
  assert.equal(resolveVerificationRepeats(0), 3, "zero runs falls back to the default");
  assert.equal(resolveVerificationRepeats(-3), 3, "so does a negative count");
  assert.equal(resolveVerificationRepeats(2.5), 3, "so does a fractional one");
  assert.equal(resolveVerificationRepeats("4"), 3, "and so does a string");

  // The explicit opt-out, which is the only way to get a single run.
  assert.equal(resolveVerificationRepeats(1), 1, "one is available, and only by asking");
  assert.equal(
    resolveVerificationRepeats(1e9),
    MAX_VERIFICATION_REPEATS,
    "an unbounded count is a denial-of-service lever through a tool argument, so it is capped"
  );
});

/**
 * An oracle that follows a scripted sequence of pass/fail outcomes, one per run.
 *
 * This is what makes the short-circuit rules testable rather than merely asserted: the state transition
 * table is about which run disagrees with the first, and a scripted sequence pins each row exactly.
 */
function scriptedOracle(sequence) {
  const file = path.join(tmp(), "script.json");
  fs.writeFileSync(file, JSON.stringify({ sequence, at: 0 }));
  const command =
    "node -e \"const f=process.argv[1];const fs=require('fs');" +
    "const s=JSON.parse(fs.readFileSync(f,'utf8'));" +
    "const outcome=s.sequence[Math.min(s.at,s.sequence.length-1)];s.at++;fs.writeFileSync(f,JSON.stringify(s));" +
    "process.exit(outcome?0:1)\" \"" + file + "\"";
  return {
    command,
    file,
    /** How many times the command actually executed. */
    runsTaken: () => JSON.parse(fs.readFileSync(file, "utf8")).at,
  };
}

async function verdictFor(sequence, repeats, name) {
  const oracle = scriptedOracle(sequence);
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted(name + ".ts"), {
    taskName: name,
    instruction: "Write " + name + ".ts.",
    targetFiles: [name + ".ts"],
    workspaceDir: dir,
    runVerification: oracle.command,
    verificationRepeats: repeats,
  });
  return { verdict, runs: oracle.runsTaken() };
}

test("state table: PASS PASS PASS is a consensus pass and spends the full budget", async () => {
  const { verdict, runs } = await verdictFor([true, true, true], 3, "allpass");
  assert.equal(verdict.status, "SUCCESS");
  assert.equal(runs, 3, "consensus cannot be claimed early, so all three runs happen");
});

test("state table: FAIL FAIL FAIL is a deterministic failure and spends the full budget", async () => {
  // The row the first implementation got wrong. Exiting after two agreeing failures would let a race
  // that lost twice in a row be reported as a deterministic regression -- masking the non-determinism
  // instead of exposing it. `FAIL` means "failed every time we looked".
  const { verdict, runs } = await verdictFor([false, false, false], 3, "allfail");
  assert.equal(verdict.status, "VERIFICATION_FAILED");
  assert.equal(runs, 3, "an agreed failure still has to prove it agrees across the whole budget");
});

test("state table: PASS FAIL stops at two runs and reports FLAKY", async () => {
  const { verdict, runs } = await verdictFor([true, false, true], 3, "passfail");
  assert.equal(verdict.status, "FLAKY");
  assert.equal(runs, 2, "disagreement is proven in two runs and cannot change");
});

test("state table: FAIL PASS stops at two runs and reports FLAKY", async () => {
  // The mirror case, and the one the mentor's correction names: a race that lost on iteration 1 must not
  // be filed as a deterministic failure when run 2 shows it passing.
  const { verdict, runs } = await verdictFor([false, true, false], 3, "failpass");
  assert.equal(verdict.status, "FLAKY");
  assert.equal(runs, 2, "disagreement in the other direction is proven just as early");
});

test("state table: a late flip is caught, because consensus is not assumed early", async () => {
  const { verdict, runs } = await verdictFor([true, true, false], 3, "lateflip");
  assert.equal(verdict.status, "FLAKY", "agreeing twice is not agreement");
  assert.equal(runs, 3, "and the flip is only found by spending the third run");
});

test("a single-run contract cannot detect flakiness, which is why 1 is not the default", async () => {
  // Pins the reason for the default rather than only the value. With repeats 1 the same alternating
  // oracle that reports FLAKY above is read as a pass on its first run -- the silent false green this
  // whole state exists to prevent. Anyone tempted to make 1 the default again should have to delete
  // this test, and read it first.
  const oracle = alternatingOracle();
  oracle.reset();
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("optout.ts"), {
    taskName: "repeats-optout",
    instruction: "Write optout.ts.",
    targetFiles: ["optout.ts"],
    workspaceDir: dir,
    runVerification: oracle.command,
    verificationRepeats: 1,
  });

  assert.equal(
    verdict.status,
    "SUCCESS",
    "one run of a flaky oracle passes: this is the failure mode the 3-pass default closes"
  );
});
