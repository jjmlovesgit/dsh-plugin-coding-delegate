// Contract oracle for lead-tier unit 1: the agent/request hook must stop treating every agent as the
// architect.
//
// Written before the implementation; it fails until the unit exists.
//
// The hook repinned *every* request to the cloud provider, appended the architect's system
// instruction ("You are the Lead Architect ... you MUST call delegate_worker") to any request lacking
// it, and injected the delegate_worker tool. That is right for the architect and wrong for everything
// else: a lead configured to run locally would be redirected to the cloud and told it was the
// architect. Both of those would silently undo the preset.
//
// The discriminator is an explicit operator allowlist of non-architect providers, not an inference.
// Inferring the role from "provider is not the architect's" would stop pinning the architect the
// moment a profile named its provider something else -- and the failure would be silent, in the
// direction of sending source to the cloud.
//
// Known gap, deliberately not closed here: the architect instruction is only injected into a `system`
// string or a `messages` array. A request carrying neither is left without it, and this contract
// asserts that existing behaviour rather than quietly changing it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const ARCHITECT = { cloudProvider: "deepseek-official", cloudModel: "deepseek-chat" };
const INSTRUCTION = "You are the Lead Architect. You have access to the `delegate_worker` tool.";
const WORKER_TOOL = { type: "function", function: { name: "delegate_worker" } };

const architectOptions = {
  ...ARCHITECT,
  architectInstruction: INSTRUCTION,
  workerTool: WORKER_TOOL,
};

const systemOf = (out) => {
  if (typeof out.system === "string") return out.system;
  const found = (out.messages || []).find((m) => m.role === "system");
  return found ? found.content : "";
};

test("with no lead providers declared, every request is still the architect", () => {
  // The safety property that makes this change a no-op until an operator opts in.
  const { resolveAgentRole } = require(DIST);
  assert.equal(resolveAgentRole({}).role, "architect");
  assert.equal(resolveAgentRole({ hostProvider: "lm-studio" }).role, "architect");
  assert.equal(
    resolveAgentRole({ hostProvider: "lm-studio", leadProviders: [] }).role,
    "architect"
  );
  assert.equal(
    resolveAgentRole({ hostProvider: "deepseek-official", leadProviders: ["lm-studio"] }).role,
    "architect"
  );
});

test("a provider the operator declared as a lead is recognised, however it is spelled", () => {
  const { resolveAgentRole } = require(DIST);
  for (const hostProvider of ["lm-studio", " LM-Studio ", "LM-STUDIO"]) {
    const verdict = resolveAgentRole({ hostProvider, leadProviders: ["lm-studio"] });
    assert.equal(verdict.role, "lead", `${hostProvider} should be recognised as a lead`);
    assert.match(verdict.reason, /lead/i);
  }
});

test("several lead providers can be declared, and blanks are ignored", () => {
  const { resolveAgentRole } = require(DIST);
  const leadProviders = ["", "  ", "lm-studio", "ollama"];
  assert.equal(resolveAgentRole({ hostProvider: "ollama", leadProviders }).role, "lead");
  assert.equal(resolveAgentRole({ hostProvider: "vllm", leadProviders }).role, "architect");
});

test("a lead request is left exactly as the operator configured it", () => {
  const { applyAgentRole } = require(DIST);
  const leadRequest = {
    provider: "lm-studio",
    model: "qwen/qwen3.8-27b",
    contextWindow: 32768,
    max_tokens: 8192,
    system: "You read the repository and author contracts. You do not write implementation code.",
    tools: [{ type: "function", function: { name: "read" } }],
  };

  const out = applyAgentRole(leadRequest, { role: "lead" }, architectOptions);

  assert.equal(out.provider, "lm-studio", "the lead must not be repinned to the cloud");
  assert.equal(out.model, "qwen/qwen3.8-27b");
  assert.equal(out.contextWindow, 32768, "the lead's context window must survive");
  assert.equal(out.max_tokens, 8192);
  assert.match(out.system, /author contracts/, "the lead's own instruction must survive");
  assert.equal(/Lead Architect/.test(out.system), false, "the architect must not claim the lead");
  assert.equal(
    out.tools.some((t) => t.function && t.function.name === "delegate_worker"),
    false,
    "the lead is not the dispatcher and must not be offered delegate_worker"
  );
});

test("the architect request is still pinned, uncapped and given the tool", () => {
  const { applyAgentRole } = require(DIST);
  const out = applyAgentRole(
    { provider: "whatever", contextWindow: 8192, messages: [] },
    { role: "architect" },
    architectOptions
  );

  assert.equal(out.provider, "deepseek-official");
  assert.equal(out.model, "deepseek-chat");
  assert.equal("contextWindow" in out, false, "the architect thread is uncapped");
  assert.equal(
    out.tools.some((t) => t.function && t.function.name === "delegate_worker"),
    true
  );
  assert.match(systemOf(out), /Lead Architect/);
});

test("a DLP reroute still pins the architect thread to the local provider", () => {
  const { applyAgentRole } = require(DIST);
  const out = applyAgentRole({ messages: [] }, { role: "architect" }, {
    ...architectOptions,
    localProvider: "lm-studio",
    localModel: "qwen/qwen3.8-27b",
    rerouteLocal: true,
  });
  assert.equal(out.provider, "lm-studio");
  assert.match(systemOf(out), /Lead Architect/, "a rerouted architect request is still the architect");
});

test("an existing delegate_worker tool is not duplicated", () => {
  const { applyAgentRole } = require(DIST);
  const out = applyAgentRole({ tools: [WORKER_TOOL] }, { role: "architect" }, architectOptions);
  assert.equal(out.tools.length, 1);
});

test("both roles are reachable from one configured provider list", () => {
  // The composition the hook performs: decide, then apply.
  const { resolveAgentRole, applyAgentRole } = require(DIST);
  const leadProviders = ["lm-studio"];

  const lead = applyAgentRole(
    { provider: "lm-studio" },
    resolveAgentRole({ hostProvider: "lm-studio", leadProviders }),
    architectOptions
  );
  const architect = applyAgentRole(
    { provider: "deepseek-official", messages: [] },
    resolveAgentRole({ hostProvider: "deepseek-official", leadProviders }),
    architectOptions
  );

  assert.equal(lead.provider, "lm-studio");
  assert.equal(architect.provider, "deepseek-official");
  assert.equal("system" in lead, false, "the lead keeps whatever the host resolved");
  assert.match(systemOf(architect), /Lead Architect/);
});
