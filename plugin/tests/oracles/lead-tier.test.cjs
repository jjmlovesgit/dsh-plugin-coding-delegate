// Contract oracle for lead-tier unit 2a: a LEAD profile that something actually reads.
//
// Written before the implementation; it fails until the unit exists.
//
// A profile nothing consumes is decoration, and this repository has already deleted one config file
// for exactly that reason. So the LEAD profile is not just declared: `leadTier` derives the non-
// architect provider list from it, which makes the profile the single source of truth for what the
// lead tier is, and makes it testable.
//
// Why the lead is local rather than a cloud model: the plugin's own rules say the architect may not
// read back what it delegated, and "source may not reach the cloud". A cloud lead reading the
// repository would be source reaching the cloud, paid for with the metered allowance the plugin exists
// to protect. The GPU is already a fixed cost, so the lead costs wall-clock and nothing else.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

test("a LEAD profile exists and is a thinking model, unlike the worker", () => {
  const { PROFILES } = require(DIST);
  assert.ok(PROFILES.LEAD, "PROFILES.LEAD must exist");
  assert.equal(PROFILES.LEAD.enable_thinking, true, "the lead's whole job is judgement over code");
  assert.equal(PROFILES.LEAD.reasoning_effort, "high");
  assert.equal(
    PROFILES.WORKER.enable_thinking,
    false,
    "the worker stays a non-thinking bulk emitter"
  );
});

test("the lead runs locally, so the source it reads never reaches the cloud", () => {
  const { PROFILES } = require(DIST);
  assert.notEqual(
    PROFILES.LEAD.provider,
    PROFILES.ARCHITECT.provider,
    "a lead on the architect's provider would be a cloud lead"
  );
  assert.match(PROFILES.LEAD.endpoint, /^http:\/\/127\.0\.0\.1:/, "the lead is a local endpoint");
});

test("the lead is told to author contracts and not to write implementation", () => {
  const { PROFILES } = require(DIST);
  const instruction = PROFILES.LEAD.systemInstruction;
  assert.match(instruction, /contract/i);
  assert.match(instruction, /do(?:es)? not write implementation/i);
  // The patch format is exact-match, so the lead has to know that quoting matters.
  assert.match(instruction, /exactly/i);
});

test("leadTier is off by default, so nothing changes until an operator asks for it", () => {
  const { resolveLeadProviders } = require(DIST);
  assert.deepEqual(resolveLeadProviders({}), []);
  assert.deepEqual(resolveLeadProviders({ leadProviders: [] }), []);
});

test("leadTier derives the provider list from the LEAD profile", () => {
  const { PROFILES, resolveLeadProviders } = require(DIST);
  assert.deepEqual(resolveLeadProviders({ leadTier: true }), [PROFILES.LEAD.provider]);
});

test("an explicit provider list wins over the leadTier shortcut", () => {
  const { resolveLeadProviders } = require(DIST);
  assert.deepEqual(resolveLeadProviders({ leadTier: true, leadProviders: ["ollama"] }), ["ollama"]);
  assert.deepEqual(resolveLeadProviders({ leadProviders: ["ollama"] }), ["ollama"]);
});

test("the reference persona and the agent preset have not drifted apart", () => {
  // PROFILES.LEAD.systemInstruction is never injected -- the plugin leaves lead requests alone -- so
  // the preset is what actually runs. That makes the profile documentation, and documentation that
  // can drift is documentation that lies. This holds the two to the same requirements.
  const fs = require("node:fs");
  const path = require("node:path");
  const preset = fs.readFileSync(
    path.resolve(PLUGIN, "..", "presets", "lead", "agent.cordis.yml"),
    "utf8"
  );
  const reference = require(DIST).PROFILES.LEAD.systemInstruction;

  // Phrases that must appear in BOTH. Deliberately role-level only: the preset carries the contract
  // FORMAT because that is what the architect consumes, and the profile is not supposed to duplicate
  // it. What must not drift is what the lead IS.
  for (const phrase of ["contract", "do not write implementation", "dispatch the worker"]) {
    const pattern = new RegExp(phrase.replace(/ /g, "\\s+"), "i");
    assert.match(reference, pattern, `the profile forgot: ${phrase}`);
    assert.match(preset, pattern, `the preset forgot: ${phrase}`);
  }
});

test("switching the lead tier on is what makes a lead request a lead request", () => {
  // The composition the hook performs, end to end: the profile feeds the provider list, which feeds
  // the role decision, which decides whether the request is rewritten.
  const { PROFILES, resolveLeadProviders, resolveAgentRole, applyAgentRole } = require(DIST);
  const leadProviders = resolveLeadProviders({ leadTier: true });

  const leadRequest = { provider: PROFILES.LEAD.provider, contextWindow: PROFILES.LEAD.contextWindow };
  const role = resolveAgentRole({ hostProvider: PROFILES.LEAD.provider, leadProviders });
  assert.equal(role.role, "lead");

  const out = applyAgentRole(leadRequest, role, {
    cloudProvider: PROFILES.ARCHITECT.provider,
    cloudModel: PROFILES.ARCHITECT.model,
    architectInstruction: PROFILES.ARCHITECT.systemInstruction,
    workerTool: { type: "function", function: { name: "delegate_worker" } },
  });

  assert.equal(out.provider, PROFILES.LEAD.provider);
  assert.equal(out.contextWindow, PROFILES.LEAD.contextWindow, "the lead keeps its own window");
  assert.equal("system" in out, false, "and is not told it is the architect");
});
