// Contract oracle: a unit that passes its own contract but breaks the project is not a success.
//
// Written before the implementation; it fails until the unit exists.
//
// Why this is the missing half of the loop. Every mechanism the plugin has is PER UNIT: contractFiles
// hashes the tests judging one unit, runVerification runs the command the architect supplied for that
// unit, and UNVERIFIED is about one unit's evidence. Nothing ever asks whether the tree still works.
//
// The failure it exists to catch, concretely:
//
//   unit 1 widens formatDate(d) to formatDate(d, tz). Its contract passes -- it tests the function.
//   unit 2, written from the design rather than the tree, still calls formatDate(d). Its contract
//   passes too -- it tests the call site it wrote.
//
//   Both green. The project does not build.
//
// So a second, operator-declared command runs after the unit's own: the project's check. If it fails,
// the unit is not a success, and the verdict says so with its own status, because "your unit passed, the
// project did not" is a different instruction to the architect than "your unit failed".
//
// The command is operator configuration rather than model input -- it goes in the profile patch, exactly
// as it would in CI -- which is why it is not approval-gated and why it is deliberately absent from the
// tool schema. See docs/cross-unit-coherence.md.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// Delegation persists through rememberDelegated, so redirect the data directory before loading DIST.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-coherence-data-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-coherence-"));
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

/** Serve one canned worker reply, so the test drives the real delegation path. */
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

const emitted = (name) => '```ts file="' + name + '"\nexport const made = 1\n```\n';

// ---------------------------------------------------------------- the status vocabulary

test("a unit whose contract passes but whose project check fails is INCOHERENT, not a success", () => {
  const { resolveDelegateStatus } = require(DIST);
  assert.equal(
    resolveDelegateStatus({
      unverified: false,
      contractViolations: [],
      isSuccess: true,
      coherenceFailed: true,
    }),
    "INCOHERENT"
  );
});

test("a unit that failed its own contract stays VERIFICATION_FAILED even if the project failed too", () => {
  const { resolveDelegateStatus } = require(DIST);
  // The unit is the actionable signal: fix it first. Reporting INCOHERENT here would point the architect
  // at the project when the fault is one unit.
  assert.equal(
    resolveDelegateStatus({
      unverified: false,
      contractViolations: [],
      isSuccess: false,
      coherenceFailed: true,
    }),
    "VERIFICATION_FAILED"
  );
});

test("both passing is still SUCCESS", () => {
  const { resolveDelegateStatus } = require(DIST);
  assert.equal(
    resolveDelegateStatus({
      unverified: false,
      contractViolations: [],
      isSuccess: true,
      coherenceFailed: false,
    }),
    "SUCCESS"
  );
});

test("incoherence does not outrank tampering or an unapproved gate", () => {
  const { resolveDelegateStatus } = require(DIST);
  assert.equal(
    resolveDelegateStatus({
      unverified: false,
      contractViolations: ["'x' was modified while the unit ran"],
      isSuccess: true,
      coherenceFailed: true,
    }),
    "CONTRACT_MODIFIED"
  );
  assert.equal(
    resolveDelegateStatus({
      verificationGate: "approval was not granted",
      unverified: false,
      contractViolations: [],
      isSuccess: true,
      coherenceFailed: true,
    }),
    "VERIFICATION_NOT_APPROVED"
  );
  assert.equal(
    resolveDelegateStatus({
      unverified: true,
      contractViolations: [],
      isSuccess: true,
      coherenceFailed: true,
    }),
    "INCOHERENT",
    "an unverified unit is still judged by the project check that did run"
  );
});

test("with no coherence check configured, the status vocabulary is unchanged", () => {
  const { resolveDelegateStatus } = require(DIST);
  // Characterisation control: a caller that never mentions coherence sees exactly the old behaviour.
  for (const input of [
    { unverified: false, contractViolations: [], isSuccess: true },
    { unverified: false, contractViolations: [], isSuccess: false },
    { unverified: true, contractViolations: [], isSuccess: true },
    { unverified: false, contractViolations: [], isSuccess: true, coherenceFailed: false },
  ]) {
    const status = resolveDelegateStatus(input);
    assert.notEqual(status, "INCOHERENT", JSON.stringify(input));
  }
});

// ---------------------------------------------------------------- the policy carries it

test("the coherence command is operator configuration, carried by the policy", () => {
  const { resolveVerificationPolicy } = require(DIST);
  assert.equal(resolveVerificationPolicy({}).coherenceVerification, undefined);
  assert.equal(
    resolveVerificationPolicy({ coherenceVerification: "npm test" }).coherenceVerification,
    "npm test"
  );
});

test("a blank or non-string coherence command is treated as absent, not as an empty command", () => {
  const { resolveVerificationPolicy } = require(DIST);
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    assert.equal(
      resolveVerificationPolicy({ coherenceVerification: bad }).coherenceVerification,
      undefined,
      "coherenceVerification: " + JSON.stringify(bad) + " must not become a command"
    );
  }
});

// ---------------------------------------------------------------- end to end

test("the project check runs and its failure voids an otherwise passing unit", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("fresh.ts"), {
    taskName: "coherence-fail",
    instruction: "Write fresh.ts.",
    workspaceDir: dir,
    runVerification: PASS,
    redactVerification: false,
    verificationPolicy: {
      mode: "allow",
      allowlist: [],
      allowInProcessFallback: false,
      timeoutMs: 30000,
      coherenceVerification: FAIL,
    },
  });
  assert.equal(verdict.testResults.failed, 0, "the unit's own contract passed");
  assert.equal(verdict.success, false, "and the unit is still not a success");
  assert.equal(verdict.status, "INCOHERENT");
  assert.equal(fs.existsSync(path.join(dir, "fresh.ts")), true, "the files are still written");
  assert.match(verdict.summary, /coheren/i, "the summary must name the project check, not just fail");
});

test("the project check passing leaves a passing unit alone", async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted("fresh2.ts"), {
    taskName: "coherence-pass",
    instruction: "Write fresh2.ts.",
    workspaceDir: dir,
    runVerification: PASS,
    redactVerification: false,
    verificationPolicy: {
      mode: "allow",
      allowlist: [],
      allowInProcessFallback: false,
      timeoutMs: 30000,
      coherenceVerification: PASS,
    },
  });
  assert.equal(verdict.success, true, JSON.stringify(verdict.summary));
  assert.equal(verdict.status, "SUCCESS");
});

test("a unit that wrote no files does not pay for a project check", async () => {
  const dir = tmp();
  // The coherence command is FAIL. If it ran, this verdict could not be a success. A delegation that
  // changed nothing cannot have broken coherence, so the check is skipped -- and the control is that a
  // failing command would otherwise have been noticed.
  const verdict = await runAgainstWorker("Here is the answer, in prose, with no code.", {
    taskName: "coherence-skipped",
    instruction: "Answer a question.",
    workspaceDir: dir,
    runVerification: PASS,
    redactVerification: false,
    verificationPolicy: {
      mode: "allow",
      allowlist: [],
      allowInProcessFallback: false,
      timeoutMs: 30000,
      coherenceVerification: FAIL,
    },
  });
  assert.equal(verdict.filesWritten.length, 0, "nothing was written");
  assert.equal(verdict.status, "SUCCESS", "a delegation that wrote nothing is not judged by the tree");
  assert.equal(verdict.coherenceResults, undefined, "and the check must not have run");
});
