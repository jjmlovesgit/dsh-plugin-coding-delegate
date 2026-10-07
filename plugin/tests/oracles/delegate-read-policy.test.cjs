// Contract oracle for lead-tier unit 3: delegateReadPolicy, the rule-3 escape hatch.
//
// Written before the implementation; it fails until the unit exists.
//
// The read guard gates ANY agent reading a file the plugin wrote on a delegation's behalf, because the
// plugin cannot yet tell which agent is which. That is the safe direction, but for a lead tier it is
// also wrong: the lead's whole job is to read the code. Until the host exposes agent lineage (item 1),
// the operator needs an explicit way to say so.
//
// It is an escape hatch, not a fix, and the contract holds it to that: `allow` relaxes exactly one
// rule, and the config's own reason text says which one.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const read = (filePath) => ({ name: "read", arguments: { file_path: filePath } });
const write = (filePath) => ({ name: "write", arguments: { file_path: filePath } });
const shell = (command) => ({ name: "pwsh", arguments: { command } });

const DELEGATED = ["/repo/src/thing.ts"];
// canonicalisation is relative to the current drive, so a hardcoded C:/ passes here and fails on a
// runner whose workspace lives on D:.
const ABSOLUTE = path.resolve("/repo/src/thing.ts").replace(/\\/g, "/");

test("the default is still to ask, so nothing changes until an operator says so", () => {
  const { evaluateCodeWriteGuard, evaluateDelegatedReadPolicy } = require(DIST);
  assert.equal(evaluateDelegatedReadPolicy().kind, "ask");
  assert.equal(evaluateDelegatedReadPolicy("ask").kind, "ask");

  const verdict = evaluateCodeWriteGuard(read("/repo/src/thing.ts"), { delegatedPaths: DELEGATED });
  assert.equal(verdict.kind, "ask");
  assert.match(verdict.reason, /delegated worker/);
});

test("deny refuses the read outright instead of prompting", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(read("/repo/src/thing.ts"), {
    delegatedPaths: DELEGATED,
    delegateReadPolicy: "deny",
  });
  assert.equal(verdict.kind, "deny");
  assert.match(verdict.reason, /delegateReadPolicy|refused/i);
});

test("allow lets the read through, which is the whole point of the hatch", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  assert.equal(
    evaluateCodeWriteGuard(read("/repo/src/thing.ts"), {
      delegatedPaths: DELEGATED,
      delegateReadPolicy: "allow",
    }),
    null
  );
});

test("the shell route honours the policy the same way", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const command = `Get-Content ${ABSOLUTE}`;
  assert.equal(
    evaluateCodeWriteGuard(shell(command), { delegatedPaths: DELEGATED }).kind,
    "ask"
  );
  assert.equal(
    evaluateCodeWriteGuard(shell(command), {
      delegatedPaths: DELEGATED,
      delegateReadPolicy: "deny",
    }).kind,
    "deny"
  );
  assert.equal(
    evaluateCodeWriteGuard(shell(command), {
      delegatedPaths: DELEGATED,
      delegateReadPolicy: "allow",
    }),
    null
  );
});

test("allow relaxes exactly one rule: writing the same file is still denied", () => {
  // The hatch is about reading delegated code back. It must not become a general amnesty.
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(write("/repo/src/thing.ts"), {
    delegatedPaths: DELEGATED,
    delegateReadPolicy: "allow",
  });
  assert.equal(verdict.kind, "deny");
});

test("allow does not disable the ordinary source-write guard", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  const verdict = evaluateCodeWriteGuard(write("/repo/src/unrelated.ts"), {
    delegatedPaths: DELEGATED,
    delegateReadPolicy: "allow",
  });
  assert.equal(verdict.kind, "deny");
});

test("deny does not start gating reads of files no worker wrote", () => {
  const { evaluateCodeWriteGuard } = require(DIST);
  for (const policy of ["ask", "allow", "deny"]) {
    assert.equal(
      evaluateCodeWriteGuard(read("/repo/src/other.ts"), {
        delegatedPaths: DELEGATED,
        delegateReadPolicy: policy,
      }),
      null,
      `${policy} must not gate a non-delegated read`
    );
  }
});

test("the hatch says which rule it weakens, so the config documents its own cost", () => {
  const { evaluateDelegatedReadPolicy } = require(DIST);
  assert.match(evaluateDelegatedReadPolicy("allow").reason, /rule 3|weaken/i);
  assert.match(evaluateDelegatedReadPolicy("deny").reason, /rule 3|refus/i);
});
