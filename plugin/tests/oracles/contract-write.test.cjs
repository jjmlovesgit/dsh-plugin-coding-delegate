// Contract oracle: the architect may author contract files, and only contract files.
//
// Rule 2 says the architect may not author source, and rule 7 says a verdict means the architect's own
// tests passed unmodified. Those two are in direct conflict, because a test file IS source. The
// resolution is a narrow, declared exception: the test is the specification rather than the
// implementation, and the worker is already refused as an emission target for contract paths.
//
// The default is deliberately `ask`, NOT `allow`. `guardAskPaths` already makes `tests/` approval-eligible,
// and that is a tested property of this plugin -- defaulting the carve-out to allow would silently
// withdraw the prompt for every test write in the repository. Opting in is what makes it frictionless:
//
//   contractPaths: ['tests/']
//   contractWriteMode: 'allow'
//
// An earlier draft of this oracle asserted `allow` as the default, and eleven existing assertions
// disagreed. The tests were right.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const write = (filePath) => ({ name: "write", arguments: { file_path: filePath } });
const read = (filePath) => ({ name: "read", arguments: { file_path: filePath } });

const CONTRACT_TARGETS = [
  "plugin/tests/oracles/thing.test.cjs",
  "tests/contract.test.cjs",
  "C:\\repo\\tests\\unit\\a.ts",
];

test("by default the carve-out changes nothing: a contract write still asks", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  for (const target of CONTRACT_TARGETS) {
    const verdict = evaluateCodeWriteGuard(write(target));
    assert.ok(verdict, `${target} should still be gated by default`);
    assert.equal(verdict.kind, "ask", `${target} should ask, not deny`);
  }
});

test("opting in is what makes a contract write frictionless", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  for (const target of CONTRACT_TARGETS) {
    assert.equal(
      evaluateCodeWriteGuard(write(target), { contractWriteMode: "allow" }),
      null,
      `${target} should be an allowed contract write once the operator opts in`
    );
  }
});

test("implementation is still refused, which is the whole point of rule 2", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  for (const target of ["plugin/src/index.ts", "src/thing.ts", "lib/util.cjs"]) {
    const verdict = evaluateCodeWriteGuard(write(target), { contractWriteMode: "allow" });
    assert.ok(verdict, `${target} should still be gated`);
    assert.equal(verdict.kind, "deny", `${target} must not become writable`);
  }
});

test("the carve-out can be widened to a different path list", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  assert.equal(
    evaluateCodeWriteGuard(write("specs/thing.spec.ts"), {
      contractPaths: ["specs/"],
      contractWriteMode: "allow",
    }),
    null
  );
  // ...and once widened, tests/ falls back to the ordinary rule rather than staying special.
  const fallback = evaluateCodeWriteGuard(write("tests/old.test.cjs"), { contractPaths: ["specs/"] });
  assert.ok(fallback, "tests/ should no longer be a contract path");
  assert.equal(fallback.kind, "ask", "it should fall back to the guardAskPaths downgrade");
});

test("the carve-out can be refused outright", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(write("tests/thing.test.cjs"), {
    contractWriteMode: "deny",
  });
  assert.ok(verdict);
  assert.equal(verdict.kind, "deny");
  assert.match(verdict.reason, /contract/i);
});

test("an empty path list disables the carve-out entirely", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(write("tests/thing.test.cjs"), {
    contractPaths: [],
    contractWriteMode: "allow",
  });
  assert.ok(verdict, "with no contract paths, tests/ is just an ask-eligible source write");
  assert.equal(verdict.kind, "ask");
});

test("the carve-out does not touch reads", () => {
  // It is about who may write the specification, not about who may look at anything.
  const { evaluateCodeWriteGuard } = require(DIST);
  assert.equal(evaluateCodeWriteGuard(read("plugin/src/index.ts")), null);
  assert.equal(
    evaluateCodeWriteGuard(read("tests/thing.test.cjs"), { contractWriteMode: "deny" }),
    null
  );
});

test("a non-source file under a contract path is unaffected", () => {
  // The carve-out lives inside the source-write branch; it must not change anything else.
  const { evaluateCodeWriteGuard } = require(DIST);
  assert.equal(evaluateCodeWriteGuard(write("tests/fixtures/data.json")), null);
});
