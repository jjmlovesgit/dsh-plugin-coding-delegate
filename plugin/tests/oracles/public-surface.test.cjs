// Contract oracle: the plugin's public export surface must not shrink.
//
// Honest provenance: this is a CHARACTERISATION contract. It passed on its first run, because it freezes
// what `dist/index.js` already exports rather than specifying something new. It exists to make a refactor
// safe: `src/index.ts` is 3,799 lines and is about to be split into modules, and every oracle and unit
// test reaches the plugin through `dist/index.js`. Without this, a name lost during the split would be
// discovered by a caller rather than by the suite.
//
// Presence, not exact equality: adding an export is fine, losing one is not.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

const NAMED_EXPORTS = [
  "AGENT_ROLE_LIMIT",
  "DEFAULT_CONTEXT_MAX_BYTES",
  "DEFAULT_LOCAL_ENDPOINT",
  "DEFAULT_SOURCE_EGRESS_MIN_LINES",
  "DEFAULT_VERIFICATION_POLICY",
  "DELEGATE_WORKER_OPENAI_SCHEMA",
  "DELEGATE_WORKER_SCHEMA",
  "DELETE_PRIMITIVES",
  "LocalRouter",
  "MIN_SEARCH_CHARS",
  "PROFILES",
  "SavingsTracker",
  "apply",
  "applyAgentRole",
  "applyArchitectConfig",
  "applySearchReplaceBlocks",
  "commandProgram",
  "contractFileHashes",
  "contractViolations",
  "delegateWorker",
  "describeFailures",
  "describeSourceRead",
  "detectSourceEgress",
  "estimateTokenCount",
  "evaluateCodeWriteGuard",
  "evaluateDelegatedReadPolicy",
  "evaluateEmissionPath",
  "evaluateSourceEgress",
  "evaluateVerificationPolicy",
  "extractAndEmitFiles",
  "extractPromptText",
  "hasCommandDeleteSignal",
  "hasCommandWriteSignal",
  "inject",
  "isPathWithin",
  "loadDelegatedRegistry",
  "mergeDelegatedRecords",
  "name",
  "parseDelegatedRegistry",
  "parseSearchReplaceBlocks",
  "parseTestOutput",
  "pruneDelegatedRecords",
  "redactVerificationOutput",
  "rememberAgentRole",
  "rememberDelegated",
  "requestApprovalForVerification",
  "requestApprovalForWrite",
  "resetAgentRoles",
  "resolveAgentRole",
  "resolveChatCompletionsUrl",
  "resolveContextFiles",
  "resolveContractFiles",
  "resolveDataDir",
  "resolveDelegateStatus",
  "resolveDelegatedRegistryPath",
  "resolveLeadProviders",
  "resolveVerificationPolicy",
  "roleForAgent",
  "runInProcessFallback",
  "runSandboxVerification",
  "saveDelegatedRegistry",
  "scanDLP",
  "sha256File",
  "using",
];

const DEFAULT_EXPORTS = [
  "AGENT_ROLE_LIMIT",
  "DEFAULT_CONTEXT_MAX_BYTES",
  "DEFAULT_SOURCE_EGRESS_MIN_LINES",
  "DELEGATE_WORKER_OPENAI_SCHEMA",
  "DELEGATE_WORKER_SCHEMA",
  "LocalRouter",
  "MIN_SEARCH_CHARS",
  "PROFILES",
  "SavingsTracker",
  "apply",
  "applyAgentRole",
  "applyArchitectConfig",
  "applySearchReplaceBlocks",
  "contractFileHashes",
  "contractViolations",
  "delegateWorker",
  "describeSourceRead",
  "detectSourceEgress",
  "evaluateDelegatedReadPolicy",
  "evaluateSourceEgress",
  "extractAndEmitFiles",
  "inject",
  "loadDelegatedRegistry",
  "mergeDelegatedRecords",
  "name",
  "parseDelegatedRegistry",
  "parseSearchReplaceBlocks",
  "parseTestOutput",
  "pruneDelegatedRecords",
  "rememberAgentRole",
  "rememberDelegated",
  "resetAgentRoles",
  "resolveAgentRole",
  "resolveContextFiles",
  "resolveContractFiles",
  "resolveDelegateStatus",
  "resolveDelegatedRegistryPath",
  "resolveLeadProviders",
  "roleForAgent",
  "runSandboxVerification",
  "saveDelegatedRegistry",
  "scanDLP",
  "sha256File",
  "using",
];

test("every public name is still a named export of dist/index.js", () => {
  const mod = require(DIST);
  const missing = NAMED_EXPORTS.filter((n) => mod[n] === undefined);
  assert.deepEqual(missing, [], `named exports lost:\n  ${missing.join("\n  ")}`);
});

test("the default export still carries every name it carried before", () => {
  const mod = require(DIST);
  assert.ok(mod.default && typeof mod.default === "object", "the default export must survive");
  const missing = DEFAULT_EXPORTS.filter((n) => mod.default[n] === undefined);
  assert.deepEqual(missing, [], `default export lost:\n  ${missing.join("\n  ")}`);
});

test("the plugin still declares its identity and what it injects", () => {
  // These three are what DSH itself relies on, so they are the ones a split is most likely to strand.
  const mod = require(DIST);
  assert.equal(typeof mod.name, "string", "name must remain a string export");
  assert.equal(typeof mod.apply, "function", "apply must remain callable");
  assert.deepEqual(mod.inject, ["tools"], "the injected service list must not drift");
  assert.deepEqual(mod.using, ["tools"], "the used service list must not drift");
});
