// Oracle for the second half of the contract guard: `check-contract.cjs --spec`.
//
// The guard's null-implementation run catches a contract that cannot judge -- one that is vacuous or
// that malfunctions on its own account. It cannot catch a contract that judges the WRONG THING, and that
// is the defect the contract-first experiment actually shipped: a contract that was well-formed and
// discriminating while asserting `has(expired) === true` on one line and `has(expired) === false` on
// another, so no implementation could satisfy it. Three rounds of the loop were spent failing to satisfy
// it, and the guard called the file sound every time.
//
// The fix is the null trick run backwards. Null proves the module cannot be blamed; a SPECIFICATION
// CONFORMANCE SUITE proves the module CAN be trusted, and then a contract that still rejects it is the
// thing at fault. So `--spec <file>` runs an architect-owned suite expressing the specification's own
// requirements, and reports the disagreement that means "stop delegating fixes and look at the contract".
//
// The limit is real and is asserted below rather than only documented: this is only as strong as the
// suite. An incomplete suite makes the module look conformant when it is not, and the verdict then
// over-fires. It is reported as a disagreement between two artifacts, not as a verdict on the contract,
// which is why the message names the failing contract tests and leaves the resolution open.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-contract.cjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-contract-spec-"));

// A module that satisfies the specification, and one that does not. Both are trivial on purpose:
// the point is the relationship between three artifacts, not the arithmetic.
const CONFORMING = "function add(a, b) { return a + b }\nmodule.exports = { add }\n";
const VIOLATING = "function add(a, b) { return a - b }\nmodule.exports = { add }\n";

// The specification expressed as checks the architect owns. Discriminating by construction: the null
// implementation returns a callable proxy, so `add(2, 3)` is not 5 and both tests fail by assertion.
const SPEC_SUITE = [
  "'use strict'",
  "const { test } = require('node:test')",
  "const assert = require('node:assert/strict')",
  "const { add } = require('../module.js')",
  "test('adds two numbers', () => { assert.equal(add(2, 3), 5) })",
  "test('adds zero', () => { assert.equal(add(0, 0), 0) })",
  "",
].join("\n");

// The same two requirements, with the same expectations -- a contract faithful to that specification.
const FAITHFUL_CONTRACT = [
  "'use strict'",
  "const { test } = require('node:test')",
  "const assert = require('node:assert/strict')",
  "const { add } = require('../module.js')",
  "test('adds two numbers', () => { assert.equal(add(2, 3), 5) })",
  "test('adds zero', () => { assert.equal(add(0, 0), 0) })",
  "",
].join("\n");

// Well-formed, discriminating against null, and demanding a behaviour the specification never states.
// This is the shape of the experiment's real defect: it passes every check the guard had.
const OVER_SPECIFIED_CONTRACT = [
  "'use strict'",
  "const { test } = require('node:test')",
  "const assert = require('node:assert/strict')",
  "const { add } = require('../module.js')",
  "test('adds two numbers', () => { assert.equal(add(2, 3), 5) })",
  "test('adds to six', () => { assert.equal(add(2, 3), 6) })",
  "",
].join("\n");

// Asserts nothing about the module, so it fails nothing against null -- the spec suite's own version of
// a contract that constrains nothing.
const VACUOUS_SPEC_SUITE = [
  "'use strict'",
  "const { test } = require('node:test')",
  "const assert = require('node:assert/strict')",
  "test('always true', () => { assert.ok(true) })",
  "",
].join("\n");

/** Lay out a workspace of one module plus the two test files that judge it. */
function workspace(name, { module, contract, spec }) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "module.js"), module, "utf8");
  fs.writeFileSync(path.join(dir, "tests", "contract.test.js"), contract, "utf8");
  fs.writeFileSync(path.join(dir, "tests", "conformance.test.js"), spec, "utf8");
  return {
    module: path.join(dir, "module.js"),
    contract: path.join(dir, "tests", "contract.test.js"),
    spec: path.join(dir, "tests", "conformance.test.js"),
  };
}

/**
 * Run the guard and capture its output.
 *
 * Captured through a file descriptor rather than a pipe, matching the script itself: DSH's confined
 * sandbox modes refuse a piped spawn outright, which would make this oracle unusable exactly where the
 * guard is meant to run.
 */
function guard(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-contract-spec-out-"));
  const outFile = path.join(dir, "out.txt");
  const fd = fs.openSync(outFile, "w");
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  return { status: run.status, output: fs.readFileSync(outFile, "utf8") };
}

test("a contract that disagrees with the specification is refused", () => {
  // The defect this exists for: the module satisfies the specification, and the contract still rejects
  // it. Both of the guard's existing checks pass here -- it asserts, and it discriminates against null.
  const w = workspace("over-specified", {
    module: CONFORMING,
    contract: OVER_SPECIFIED_CONTRACT,
    spec: SPEC_SUITE,
  });
  const run = guard(["--contract", w.contract, "--module", w.module, "--spec", w.spec]);

  assert.equal(run.status, 1, "a demonstrated disagreement must not exit 0");
  assert.match(run.output, /specification/i, "the verdict must name the specification as the reference");
  assert.match(
    run.output,
    /adds to six/,
    "the verdict must name the failing contract test, so the architect can act on it"
  );
  assert.match(
    run.output,
    /suite is incomplete|demands more/i,
    "the verdict must keep both possibilities open: the contract demands more, or the suite is incomplete"
  );
});

test("a contract faithful to the specification is accepted", () => {
  const w = workspace("faithful", {
    module: CONFORMING,
    contract: FAITHFUL_CONTRACT,
    spec: SPEC_SUITE,
  });
  const run = guard(["--contract", w.contract, "--module", w.module, "--spec", w.spec]);

  assert.equal(run.status, 0, "the control: nothing here is wrong");
  assert.match(run.output, /OK/);
});

test("a specification suite that constrains nothing is refused", () => {
  // The suite gets the same treatment the contract gets: a suite that passes a module returning itself
  // for everything cannot be the reference a contract is measured against.
  const w = workspace("vacuous-spec", {
    module: CONFORMING,
    contract: FAITHFUL_CONTRACT,
    spec: VACUOUS_SPEC_SUITE,
  });
  const run = guard(["--contract", w.contract, "--module", w.module, "--spec", w.spec]);

  assert.equal(run.status, 1, "a suite that constrains nothing must not be trusted as a reference");
  assert.match(run.output, /constrains nothing|not fit/i);
});

test("a module that violates the specification does not make the contract wrong", () => {
  // The guard must not cry foul when the module is simply broken. Here the specification suite fails the
  // module, so the contract's failures are explained and the contract stays fit to judge.
  const w = workspace("violating-module", {
    module: VIOLATING,
    contract: FAITHFUL_CONTRACT,
    spec: SPEC_SUITE,
  });
  const run = guard(["--contract", w.contract, "--module", w.module, "--spec", w.spec]);

  assert.equal(run.status, 0, "a broken module is not a contract defect");
  assert.doesNotMatch(
    run.output,
    /DISAGREEMENT:/,
    "no disagreement may be claimed when the module is the thing that is wrong"
  );
});

test("without --spec the guard behaves exactly as it did before", () => {
  // Backwards compatibility, asserted rather than assumed: the over-specified contract is indistinguishable
  // from a good one by the old checks, and that is the whole reason --spec exists.
  const w = workspace("no-spec", {
    module: CONFORMING,
    contract: OVER_SPECIFIED_CONTRACT,
    spec: SPEC_SUITE,
  });
  const run = guard(["--contract", w.contract, "--module", w.module]);

  assert.equal(run.status, 0, "the old judgement must be unchanged when no suite is supplied");
  assert.match(run.output, /OK/);
});

test("a missing specification suite is reported, not ignored", () => {
  // Silently ignoring a mistyped path would turn the strongest check into a no-op, which is the failure
  // mode this project treats as worse than no check at all.
  const w = workspace("missing-spec", {
    module: CONFORMING,
    contract: FAITHFUL_CONTRACT,
    spec: SPEC_SUITE,
  });
  const run = guard([
    "--contract",
    w.contract,
    "--module",
    w.module,
    "--spec",
    path.join(TMP, "missing-spec", "tests", "nope.test.js"),
  ]);

  assert.equal(run.status, 1, "a suite that cannot be found must fail loudly");
  assert.match(run.output, /does not exist/i);
});

test("cleanup", () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.ok(!fs.existsSync(TMP));
});
