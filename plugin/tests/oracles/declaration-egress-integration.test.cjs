// Integration oracle for SECURITY-REVIEW-2 finding 8/10.
//
// The pure suite (declaration-egress-scope.test.cjs) proves the DECISION. This file proves the decision
// is WIRED: it mounts the real plugin, captures the real tools/post-execute listener, and drives mock
// tool dispatches through it. A pure function that nothing calls closes no finding, and this repository
// has shipped exactly that mistake before -- an unwired gate that returned the same shape as a working
// one and reported SUCCESS.
//
// Every assertion here is about a route that does NOT go through READ_TOOLS, because the read route is
// already covered by egress-guard.test.cjs and the defect is precisely that the other routes were never
// inspected at all.
//
// ONE MOUNT, AT MODULE SCOPE, ON PURPOSE. The plugin refuses a second mount in the same process:
//
//     [LOCAL_ROUTER] Plugin already registered. Skipping duplicate mounting.
//
// and `apply` then returns WITHOUT registering anything, so a per-test `hooksFor()` yields an empty
// handler map from the second test onward. That reads as "the listener is not registered" and makes the
// whole file look like the wiring is missing when it is present. It also made an earlier version of this
// file's source-mode control pass VACUOUSLY, because that mount never happened and the assertion it
// guarded was never really made. So the mode is fixed for the file and the listener is captured once.
//
// The source-mode no-op is asserted in the pure suite instead, where no host is involved.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const { apply } = require(PLUGIN + "/dist/index.js");

const handlers = {};
const ctx = {
  on: (event, fn) => {
    handlers[event] = fn;
  },
  get: () => undefined,
  tools: { register: () => {} },
};
apply(ctx, {
  sourceReadEgress: "declarations",
  declarationRoot: path.join(PLUGIN, "dist"),
});

/**
 * Drive one mock tool dispatch through the real post-execute listener.
 *
 * `result` is the shape the host hands the seam: the tool's own output. A block must REPLACE it rather
 * than let it stand, so every assertion is on what comes back, never on a log line.
 */
async function dispatch(name, args, rawOutput = "RAW IMPLEMENTATION BODY") {
  const listener = handlers["tools/post-execute"];
  assert.ok(listener, "the plugin must register a tools/post-execute listener in declarations mode");
  const exec = { name, arguments: args };
  const result = { content: [{ type: "text", text: rawOutput }] };
  const next = async () => ({ kind: "accept", content: result.content });
  return listener(exec, result, next);
}

/** True when the returned decision replaced the tool output rather than letting it stand. */
function replacedContent(decision) {
  if (!decision || decision.kind !== "accept") return true;
  return !JSON.stringify(decision.content || []).includes("RAW IMPLEMENTATION BODY");
}

/** The text the host would show the model, whatever path produced it. */
function textOf(decision) {
  const content = (decision && decision.content) || [];
  return content.map((c) => String((c && c.text) || "")).join("\n");
}

// SEARCH: the defect. A search over a code file returns matched implementation lines, and the old gate
// returned before inspecting it because 'grep' is not in READ_TOOLS.
test("a search scoped to a source file is refused under declarations mode", async () => {
  const decision = await dispatch("grep", { pattern: "delegatedUnder", path: "src/guard.ts" });
  assert.ok(replacedContent(decision), "the search output must not reach the architect");
  assert.match(textOf(decision), /declarations/i, "the refusal must name the setting: " + textOf(decision));
});

test("a scope-free search is refused under declarations mode", async () => {
  const decision = await dispatch("rg", { pattern: "api" });
  assert.ok(replacedContent(decision), "a search with no scope cannot be shown to avoid source");
});

// SHELL: the same leak by the other door.
test("a shell command that reads a source file is refused under declarations mode", async () => {
  const decision = await dispatch("pwsh", { command: "Get-Content src/guard.ts" });
  assert.ok(replacedContent(decision), "shell stdout must not carry an implementation body");
  assert.match(textOf(decision), /declarations/i, "the refusal must name the setting");
});

// CONTROLS. These exist so the wiring cannot pass by refusing everything.
test("control: a search scoped to documentation is allowed through", async () => {
  const decision = await dispatch("grep", { pattern: "install", path: "docs/README.md" });
  assert.ok(!replacedContent(decision), "a search over prose must not be refused");
});

test("control: a listing command is allowed through", async () => {
  const decision = await dispatch("pwsh", { command: "Get-ChildItem src" });
  assert.ok(!replacedContent(decision), "a listing command returns names, not bytes");
});

test("control: a tool that is not a read, search or shell is unaffected", async () => {
  const decision = await dispatch("delegate_worker", { taskName: "x", instruction: "y" });
  assert.ok(!replacedContent(decision), "an unrelated tool is not an egress route");
});

test("control: cat is a READ tool, so it is routed by path and not by command", async () => {
  // cat is a member of READ_TOOLS, not SHELL_TOOLS. A dispatch named 'cat' carrying a `command` field is
  // therefore classified as a read whose target is arguments.path, which is absent -- so nothing is
  // refused. This control pins that classification, because a wiring that reached the shell branch here
  // would be reading the wrong argument field, and that is the defect that would hide a real block.
  const decision = await dispatch("cat", { command: "Get-Content src/guard.ts" });
  assert.ok(!replacedContent(decision), "cat must be classified as a read, not a shell command");
});
