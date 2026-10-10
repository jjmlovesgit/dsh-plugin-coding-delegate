// Oracle for the pure trace-redaction helper (SECURITY-REVIEW-2 finding 19).
//
// The defect: `trace()` wrote `JSON.stringify(data)` verbatim to `router-debug.log`, and two call sites
// passed `prompt.slice(0, 100)` -- so a credential-bearing payload was persisted to disk in plaintext.
// The fix put `redactTracePayload` at the sink, which covers every current and future caller rather than
// relying on call-site discipline.
//
// WHY THIS FILE EXISTS SEPARATELY. `security-review-2-regressions.test.cjs` drives the real `trace()`
// through a temp data directory, which proves the sink does not persist a synthetic token. That is an
// end-to-end assertion and it is the more important one. What it cannot do is pin the SHAPE of the
// redaction, because it only observes the log file. This file tests the helper directly, which is
// possible only because the fix exported it -- so the shape is asserted rather than inferred.
//
// `trace` is NOT pure; `redactTracePayload` is, and that is the whole reason it was extracted.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const { redactTracePayload, resolveDataDir } = require(PLUGIN + "/dist/logging.js");

const TOKEN = "SYNTHETICSECRET0123456789ABCDEF";

test("a prompt field is replaced by its length, and no content survives", () => {
  const out = redactTracePayload({ prompt: TOKEN, decision: "allow" });
  assert.ok(!String(out.prompt).includes(TOKEN), "prompt content must not survive redaction");
  assert.ok(!String(out.prompt).includes("SYNTHETIC"), "not even a prefix may survive");
  // The marker reports the length so the log still says how much was withheld.
  assert.match(String(out.prompt), new RegExp("\\(" + TOKEN.length + " chars\\)"));
});

test("every other field is preserved, so redaction cannot succeed by writing nothing", () => {
  const out = redactTracePayload({ prompt: TOKEN, decision: "allow", turn: 7, route: "WORKER_LOCAL" });
  assert.equal(out.decision, "allow");
  assert.equal(out.turn, 7);
  assert.equal(out.route, "WORKER_LOCAL");
});

test("the caller's object is not mutated", () => {
  const input = { prompt: TOKEN };
  redactTracePayload(input);
  assert.equal(input.prompt, TOKEN, "the redactor must return a copy, not edit in place");
});

test("a payload without a prompt is passed through unchanged", () => {
  const input = { violations: "openai-key", action: "reroute-local" };
  const out = redactTracePayload(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input, "a copy is still returned, so a later edit cannot reach the caller");
});

test("a non-string prompt is left alone rather than coerced or dropped", () => {
  // A number or undefined is not prompt text, and silently replacing it would remove information the
  // log is entitled to keep.
  const out = redactTracePayload({ prompt: 42, decision: "allow" });
  assert.equal(out.prompt, 42);
  assert.equal(out.decision, "allow");
});

test("a non-object payload returns unchanged, including a bare string", () => {
  assert.equal(redactTracePayload("plain text"), "plain text");
  assert.equal(redactTracePayload(undefined), undefined);
  assert.equal(redactTracePayload(null), null);
  // An array is not a field map; indexing one by 'prompt' would be meaningless.
  const arr = [1, 2, 3];
  assert.equal(redactTracePayload(arr), arr);
});

test("the data directory is resolvable, so the sink has somewhere to write", () => {
  // Cheap structural assertion: the redactor is only meaningful alongside a real log path. This also
  // pins that `resolveDataDir` remains exported, which the integration oracle depends on.
  assert.equal(typeof resolveDataDir(), "string");
  assert.ok(resolveDataDir().length > 0);
});
