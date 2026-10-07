// Contract oracle: record when the architect reads source, so the access can be judged later.
//
// Written before the implementation; it fails until the unit exists.
//
// This is observation, not enforcement. The read guard only gates files a worker wrote, so the architect
// can read any source file today, and the only thing stopping it is a sentence in its system prompt. The
// decision was to keep that access for now and record it, so that "can the architect be made blind to
// code?" becomes a question with evidence behind it instead of an opinion.
//
// Attribution is deliberately best-effort. The plugin cannot ask the host which agent is which, so it
// correlates the agent ids it sees on requests with the ids it sees on tool calls, and says 'unknown'
// when that fails. Recording the attempt is the point: if attribution never works the record still says
// how often source was read, and it says so honestly rather than guessing a role.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

function observed(input) {
  return require(DIST).describeSourceRead(input);
}
function read(target, role = "architect") {
  return observed({ tool: "read", target, role });
}

test("an agent whose role has not been observed is unknown, not guessed", () => {
  const { roleForAgent, resetAgentRoles } = require(DIST);
  resetAgentRoles();
  assert.equal(roleForAgent("never-seen"), "unknown");
  assert.equal(roleForAgent(undefined), "unknown");
  assert.equal(roleForAgent(""), "unknown");
});

test("a role seen on a request is remembered for that agent", () => {
  const { rememberAgentRole, roleForAgent, resetAgentRoles } = require(DIST);
  resetAgentRoles();
  rememberAgentRole("agent-a", "architect");
  rememberAgentRole("agent-b", "lead");
  assert.equal(roleForAgent("agent-a"), "architect");
  assert.equal(roleForAgent("agent-b"), "lead");
});

test("a changed role is updated, not duplicated", () => {
  const { rememberAgentRole, roleForAgent, resetAgentRoles } = require(DIST);
  resetAgentRoles();
  rememberAgentRole("agent-a", "architect");
  rememberAgentRole("agent-a", "lead");
  assert.equal(roleForAgent("agent-a"), "lead");
});

test("the role map is bounded, and the oldest entry is the one dropped", () => {
  const { rememberAgentRole, roleForAgent, resetAgentRoles, AGENT_ROLE_LIMIT } = require(DIST);
  resetAgentRoles();
  for (let i = 0; i < AGENT_ROLE_LIMIT + 5; i++) rememberAgentRole(`agent-${i}`, "architect");
  assert.equal(roleForAgent("agent-0"), "unknown", "the oldest should have been evicted");
  assert.equal(
    roleForAgent(`agent-${AGENT_ROLE_LIMIT + 4}`),
    "architect",
    "the newest should be held"
  );
});

test("reading a source file is recorded, and says who it was attributed to", () => {
  const seen = read("C:/repo/plugin/src/index.ts");
  assert.equal(seen.track, true);
  assert.equal(seen.extension, ".ts");
  assert.equal(seen.role, "architect");
  assert.match(seen.reason, /architect/);
});

test("a source read that cannot be attributed is still recorded, and says so", () => {
  // The honest case: the read happened, the role is not known. Losing the record would be worse than
  // losing the attribution.
  const seen = read("C:/repo/plugin/src/index.ts", "unknown");
  assert.equal(seen.track, true);
  assert.equal(seen.role, "unknown");
  assert.match(seen.reason, /unknown/);
});

test("a WRITE to a source file is not a read, and must not be recorded as one", () => {
  // Without this the observation would count the architect's blocked writes as reads, and the evidence
  // it exists to gather would be wrong.
  assert.equal(observed({ tool: "write", target: "C:/repo/plugin/src/index.ts", role: "architect" }).track, false);
  assert.equal(observed({ tool: "edit", target: "C:/repo/plugin/src/index.ts", role: "architect" }).track, false);
});

test("non-source reads and missing targets are not recorded", () => {
  assert.equal(read("C:/repo/README.md").track, false);
  assert.equal(read("C:/repo/plugin/package.json").track, false);
  assert.equal(read("C:/repo/notes.txt").track, false);
  assert.equal(read(undefined).track, false);
  assert.equal(read("").track, false);
});

test("a script counts as source, because reading one is reading code", () => {
  assert.equal(read("C:/repo/build.ps1").track, true);
  assert.equal(read("C:/repo/tool.mjs").track, true);
});
