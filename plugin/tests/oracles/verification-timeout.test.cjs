// Contract oracle: the verification timeout must be expressible.
//
// Written before the implementation; it fails until the unit exists.
//
// Why this is a contract and not a nicety: the timeout was hardcoded at 30 s inside
// runSandboxVerification, and no configuration could raise it. A contract whose command legitimately
// needs longer -- a full suite, a build, an install -- could not be expressed at all, so the operator's
// only options were to shorten the work or to abandon verification. That is not a fail-closed bound; it
// is a silent one, because a legitimate slow command is reported as a failure and looks like bad code.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-timeout-"));

test("the default timeout is exported, and is the 30 s the plugin already used", () => {
  const { DEFAULT_VERIFICATION_TIMEOUT_MS } = require(DIST);
  assert.equal(DEFAULT_VERIFICATION_TIMEOUT_MS, 30000);
});

test("an unconfigured policy carries the default, so nothing changes for existing users", () => {
  const { DEFAULT_VERIFICATION_TIMEOUT_MS, resolveVerificationPolicy } = require(DIST);
  assert.equal(resolveVerificationPolicy({}).timeoutMs, DEFAULT_VERIFICATION_TIMEOUT_MS);
});

test("the operator can raise the timeout", () => {
  const { resolveVerificationPolicy } = require(DIST);
  assert.equal(resolveVerificationPolicy({ verificationTimeoutMs: 120000 }).timeoutMs, 120000);
});

test("a nonsense timeout falls back to the default rather than removing the bound", () => {
  const { DEFAULT_VERIFICATION_TIMEOUT_MS, resolveVerificationPolicy } = require(DIST);
  const bad = [0, -1, -30000, NaN, Infinity, -Infinity, "abc", null, undefined, {}, []];
  for (const value of bad) {
    assert.equal(
      resolveVerificationPolicy({ verificationTimeoutMs: value }).timeoutMs,
      DEFAULT_VERIFICATION_TIMEOUT_MS,
      "verificationTimeoutMs: " + String(value) + " must not be accepted"
    );
  }
});

test("a fractional timeout is floored to a whole millisecond", () => {
  const { resolveVerificationPolicy } = require(DIST);
  assert.equal(resolveVerificationPolicy({ verificationTimeoutMs: 1500.7 }).timeoutMs, 1500);
});

test("the bound is actually applied: a command that outlives it is killed", () => {
  const { runSandboxVerification } = require(DIST);
  const dir = tmp();
  // Sleeps ~5 s. Under a 500 ms bound this can only report failure if the bound reached the spawn:
  // a command allowed to finish would exit 0 and report passed.
  const result = runSandboxVerification('node -e "setTimeout(()=>{},5000)"', dir, {
    redact: false,
    timeoutMs: 500,
  });
  assert.ok(
    result.failed > 0,
    "expected a timeout failure, got " + JSON.stringify(result)
  );
});

test("the same shape of command passes when the bound is raised", () => {
  const { runSandboxVerification } = require(DIST);
  const dir = tmp();
  const result = runSandboxVerification('node -e "setTimeout(()=>{},2000)"', dir, {
    redact: false,
    timeoutMs: 30000,
  });
  assert.equal(result.failed, 0, "expected success, got " + JSON.stringify(result));
});
