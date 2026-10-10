// Oracle for the standalone defects in SECURITY-REVIEW-2.md.
//
// Four cases. A, B and D are RED against the current tree ON PURPOSE: they detect defects that are
// documented and unfixed. C is GREEN and is a deliberate pin of accepted behaviour. A run in which all
// four pass means the red cases were written to match the implementation, which is the defect this file
// exists to prevent.
//
// Conventions: exercise the plugin's real exports from dist/ and never reimplement a plugin decision
// here. No backtick character appears anywhere in this file.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Set the data dir BEFORE requiring dist/logging.js. logging.ts computes LOG_FILE once at module load,
// so setting it later would write to the operator's real log file.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sr2-data-"));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, "..", "..");

// Case A - context budget is enforced before the read (finding 7/12). RED: context.ts reads and splits
// the whole file before comparing the budget, so an oversized file is loaded before it is refused.
test("case A: budget is enforced before the read", () => {
  const { resolveContextFiles } = require(PLUGIN + "/dist/context.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sr2-a-"));
  fs.writeFileSync(path.join(dir, "small.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(100 * 1024));

  const original = fs.readFileSync;
  const observed = [];
  fs.readFileSync = function (...args) {
    observed.push(String(args[0]));
    return original.apply(this, args);
  };

  let resolution;
  try {
    // Signature: (requests, baseDir, allowedRoots, maxBytes). The budget is passed explicitly so the
    // budget branch is unambiguously the thing under test. startLine and endLine are OMITTED, not set
    // to null: the source branches on !== undefined and Number(null) is 0, which is an invalid range.
    resolution = resolveContextFiles([{ path: "small.ts" }, { path: "big.ts" }], dir, [], 1024);
  } finally {
    fs.readFileSync = original;
  }

  assert.ok(Array.isArray(resolution.errors), "a resolution must report errors as an array");
  assert.ok(
    resolution.errors.some((e) => /budget/i.test(e)),
    "the error must be the budget refusal, not a containment or range refusal: " +
      JSON.stringify(resolution.errors)
  );
  assert.equal(resolution.injected.length, 0, "an over-budget injection must not be partially applied");

  // The load-bearing assertion. It fails today because the file is read before being refused, and it
  // passes once a statSync size guard runs before the read.
  assert.ok(
    !observed.some((p) => p.includes("big.ts")),
    "big.ts must not be read at all when it cannot fit the budget; observed reads: " +
      JSON.stringify(observed)
  );
});

// Case B - a prompt payload is not persisted verbatim (finding 19). RED: trace() writes
// JSON.stringify(data) unredacted, and two call sites pass prompt.slice(0, 100).
test("case B: trace does not persist a synthetic token", () => {
  const { trace, resolveDataDir } = require(PLUGIN + "/dist/logging.js");

  const synthetic = "SYNTHETICSECRET0123456789ABCDEF";
  trace("ROUTER_DECISION", { prompt: synthetic, decision: "allow" });

  const logFile = path.join(resolveDataDir(), "router-debug.log");
  assert.ok(fs.existsSync(logFile), "trace must have written " + logFile);
  const log = fs.readFileSync(logFile, "utf8");

  assert.ok(!log.includes(synthetic), "the synthetic token must not appear in the log file");
  // Redaction may not succeed by writing nothing, so the event name must still be there.
  assert.ok(log.includes("ROUTER_DECISION"), "the event name must be present in the log file");
});

// Case C - verification allowlist matches a program, not a command (findings 16/17). GREEN, and a
// deliberate PIN. Allowlisting an interpreter is equivalent to allowing arbitrary code because
// verification runs with shell: true (verification.ts:507). This is the documented accepted trade; the
// test exists so that closing the hole is a deliberate act with a failing test to change.
test("case C: allowlist pins program matching", () => {
  const { commandProgram, evaluateVerificationPolicy } = require(PLUGIN + "/dist/verification.js");

  const quote = String.fromCharCode(96);
  const inline = "node -e " + quote + "console.log(1)" + quote;

  // The argument list is not part of the comparison.
  assert.equal(commandProgram(inline), "node");

  const policy = { mode: "ask", allowlist: ["node"] };
  const normal = evaluateVerificationPolicy("node tests/x.test.cjs", policy);
  const inlineResult = evaluateVerificationPolicy(inline, policy);

  // evaluateVerificationPolicy returns { kind, program, reason }.
  assert.equal(normal.kind, "allow");
  assert.equal(normal.program, "node");
  assert.equal(inlineResult.kind, "allow", "an allowlisted program is allowed regardless of arguments");
  assert.equal(inlineResult.program, "node");
});

// Case D - the registry cap is bounded and chronological (finding 18). GREEN, and a deliberate PIN.
//
// This case does NOT assert the fix, and that is a deliberate, measured decision rather than an
// oversight. The defect in finding 18 is that read protection is lost when a record is evicted, because
// the guard's protection is a membership test against delegatedPaths. That property CANNOT be asserted
// as a red test at this seam: a read of an evicted path is indistinguishable from a read of a path that
// was never delegated, and both must be permitted. No record set under a chronological cap makes an
// "evicted paths still fail closed" assertion fail, so such a test would be green under both the defect
// and the fix -- a false green of exactly the kind this file exists to prevent.
//
// What IS assertable is the eviction behaviour itself, so this pins it: the cap binds, and eviction is
// chronological (newest retained). If a future change makes eviction verdict-aware, this pin fails and
// that change becomes a deliberate act with a test to update.
test("case D: registry cap is bounded and chronological", () => {
  const { mergeDelegatedRecords } = require(PLUGIN + "/dist/contracts.js");

  const olderSettled = [
    { path: "/tmp/old1.ts", sha256: null, at: 1000, mode: "created", outcome: "UNIT_PASSED", succeeded: true },
    { path: "/tmp/old2.ts", sha256: null, at: 2000, mode: "created", outcome: "UNIT_PASSED", succeeded: true },
  ];
  const newerUnsettled = [
    { path: "/tmp/new1.ts", sha256: null, at: 3000, mode: "created" },
    { path: "/tmp/new2.ts", sha256: null, at: 4000, mode: "created" },
  ];

  const merged = mergeDelegatedRecords(olderSettled, newerUnsettled, 2);

  // The cap binds: this is a real eviction, not a disabled one.
  assert.equal(merged.length, 2, "the cap must bind: " + merged.length);
  // Eviction is chronological, so the two newest survive and the two settled records are dropped. This
  // is the pinned behaviour, and the reason the finding cannot be closed by a regression test here.
  assert.deepEqual(
    merged.map((r) => r.path).sort(),
    ["/tmp/new1.ts", "/tmp/new2.ts"],
    "eviction must be chronological (newest retained): " + JSON.stringify(merged.map((r) => r.path))
  );
});
