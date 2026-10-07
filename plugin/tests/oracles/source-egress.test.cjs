// Contract oracle for lead-tier unit 2c: rule 8, source may not reach the cloud.
//
// Written before the implementation; it fails until the unit exists.
//
// Every other route for source has a gate. The read guard covers reading delegated code back, and
// contextFiles injects into the *worker*, never the cloud. What is left is the blunt route: source
// sitting in the outbound payload itself, because it was typed or pasted into a cloud-bound
// conversation. Rule 8 covers that, and it is the one gate here whose detector is a heuristic.
//
// So the design is deliberately conservative and its limits are asserted rather than implied:
//
//   - only FENCED blocks with a source language tag count. Prose about code does not.
//   - the block must be at least `minLines` long, so a one-line quote passes.
//   - an UNTAGGED fenced block is NOT detected. That is a real false negative and it is in the contract
//     so nobody can later mistake this for a proof.
//   - a request bound for the local worker is not egress at all, whatever it contains.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const fence = (lang, ...lines) => "```" + lang + "\n" + lines.join("\n") + "\n```";

test("a long enough fenced source block is detected", () => {
  const { detectSourceEgress } = require(DIST);
  const found = detectSourceEgress("Here is the fix:\n" + fence("ts", "const a = 1", "const b = 2", "const c = 3"));
  assert.equal(found.found, true);
  assert.equal(found.blocks, 1);
  assert.deepEqual(found.languages, ["ts"]);
});

test("a short block passes, so quoting a line is not an incident", () => {
  const { detectSourceEgress } = require(DIST);
  assert.equal(detectSourceEgress(fence("ts", "const a = 1")).found, false);
  assert.equal(detectSourceEgress(fence("ts", "const a = 1", "const b = 2")).found, false);
});

test("the threshold is adjustable, and lower means more false positives", () => {
  const { detectSourceEgress } = require(DIST);
  assert.equal(detectSourceEgress(fence("ts", "const a = 1"), { minLines: 1 }).found, true);
});

test("scripts count as source, because a deployment script is still source", () => {
  const { detectSourceEgress } = require(DIST);
  const found = detectSourceEgress(fence("bash", "set -e", "cd /srv", "rm -rf build"));
  assert.equal(found.found, true);
  assert.deepEqual(found.languages, ["bash"]);
});

test("several blocks are counted and their languages reported", () => {
  const { detectSourceEgress } = require(DIST);
  const found = detectSourceEgress(
    fence("ts", "const a = 1", "const b = 2", "const c = 3") +
      "\nand\n" +
      fence("python", "x = 1", "y = 2", "z = 3")
  );
  assert.equal(found.blocks, 2);
  assert.deepEqual(found.languages.sort(), ["python", "ts"]);
});

test("prose about code is not detected, and neither is an untagged block", () => {
  // The second half is a KNOWN false negative, asserted deliberately.
  const { detectSourceEgress } = require(DIST);
  assert.equal(
    detectSourceEgress("I refactored the parser to walk the token list twice.").found,
    false
  );
  assert.equal(detectSourceEgress(fence("", "const a = 1", "const b = 2", "const c = 3")).found, false);
});

test("a request bound for the local worker is not egress, whatever it carries", () => {
  const { evaluateSourceEgress, detectSourceEgress } = require(DIST);
  const detection = detectSourceEgress(fence("ts", "const a = 1", "const b = 2", "const c = 3"));
  const verdict = evaluateSourceEgress("deny", detection, "local");
  assert.equal(verdict.kind, "allow");
  assert.match(verdict.reason, /local/i);
});

test("with nothing detected, every policy allows", () => {
  const { evaluateSourceEgress } = require(DIST);
  const none = { found: false, blocks: 0, languages: [] };
  for (const action of ["deny", "ask", "allow"]) {
    assert.equal(evaluateSourceEgress(action, none, "cloud").kind, "allow");
  }
});

test("the policy decides what a detected block means", () => {
  const { evaluateSourceEgress } = require(DIST);
  const detection = { found: true, blocks: 2, languages: ["ts", "bash"] };
  assert.equal(evaluateSourceEgress("deny", detection, "cloud").kind, "deny");
  assert.equal(evaluateSourceEgress("ask", detection, "cloud").kind, "ask");
  assert.equal(evaluateSourceEgress("allow", detection, "cloud").kind, "allow");
  // The refusal has to say which rule it is and how to proceed, or it is just an error.
  assert.match(evaluateSourceEgress("deny", detection, "cloud").reason, /sourceEgress|rule 8/i);
});
