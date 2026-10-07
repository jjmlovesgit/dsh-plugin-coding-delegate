// Oracle for the approval-seam guard: the `ask` tier must genuinely ask, and must
// fail closed. Drives the real tools/pre-execute listener from the built plugin.
const { test } = require("node:test");
const assert = require("node:assert/strict");

// The plugin skips its duplicate-mount guard when NODE_ENV === 'test', which lets
// apply() be called once per test with a fresh mock ctx.
process.env.NODE_ENV = "test";

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { apply, requestApprovalForWrite, evaluateCodeWriteGuard } = require(PLUGIN + "/dist/index.js");

const REGISTERED_KEY = Symbol.for("dsh-plugin-local-router.registered");

/** Build a mock ctx, run apply(), and hand back the captured pre-execute listener. */
function guardFor(approvalImpl) {
  delete globalThis[REGISTERED_KEY]; // apply() short-circuits if already mounted
  const handlers = {};
  const calls = [];
  const approval =
    approvalImpl === undefined
      ? undefined
      : {
          request: async (req) => {
            calls.push(req);
            return approvalImpl(req);
          },
        };

  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    get: (name) => (name === "approval" ? approval : undefined),
    tools: { register: () => {} },
  };

  apply(ctx, {});
  assert.ok(handlers["tools/pre-execute"], "guard hook was not registered");
  return { preExecute: handlers["tools/pre-execute"], calls };
}

const writeCall = (filePath, extra = {}) => ({
  name: "write",
  arguments: { file_path: filePath },
  agent: { id: "agent-1" },
  callId: "call-1",
  signal: undefined,
  ...extra,
});

const allowNext = async () => ({ kind: "allow" });

test("ask tier: an 'allowed-once' grant lets the write through", async () => {
  const { preExecute, calls } = guardFor(async () => "allowed-once");
  const result = await preExecute(writeCall("tests/oracle.mjs"), allowNext);
  assert.equal(result.kind, "allow", "an allowed-once grant must permit the call");
  assert.equal(calls.length, 1, "the approval service must actually be asked");
});

test("ask tier: refusal outcomes deny the write", async () => {
  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    const { preExecute } = guardFor(async () => outcome);
    const result = await preExecute(writeCall("tests/oracle.mjs"), allowNext);
    assert.equal(result.kind, "deny", `${outcome} must deny`);
    assert.match(result.reason, new RegExp(outcome));
  }
});

test("ask tier: a non-vocabulary answer is normalised to unavailable and denies", async () => {
  const { preExecute } = guardFor(async () => "sure-go-ahead");
  const result = await preExecute(writeCall("tests/oracle.mjs"), allowNext);
  assert.equal(result.kind, "deny");
  assert.match(result.reason, /unavailable/);
});

test("ask tier: a throwing answerer fails closed", async () => {
  const { preExecute } = guardFor(async () => {
    throw new Error("no open turn");
  });
  const result = await preExecute(writeCall("tests/oracle.mjs"), allowNext);
  assert.equal(result.kind, "deny");
  assert.match(result.reason, /unavailable/);
});

test("ask tier: a missing approval service fails closed", async () => {
  const { preExecute } = guardFor(undefined);
  const result = await preExecute(writeCall("tests/oracle.mjs"), allowNext);
  assert.equal(result.kind, "deny", "no approval service must never mean allow");
  assert.match(result.reason, /unavailable/);
});

test("ask tier: a missing agent fails closed without asking", async () => {
  const { preExecute, calls } = guardFor(async () => "allowed-once");
  const result = await preExecute(writeCall("tests/oracle.mjs", { agent: undefined }), allowNext);
  assert.equal(result.kind, "deny");
  assert.equal(calls.length, 0, "there is nobody to ask");
});

test("the approval request carries agent, tool, callId and the guard's reason", async () => {
  const { preExecute, calls } = guardFor(async () => "allowed-once");
  const signal = new AbortController().signal;
  await preExecute(writeCall("tests/oracle.mjs", { signal }), allowNext);
  const req = calls[0];
  assert.deepEqual(req.agent, { id: "agent-1" });
  assert.equal(req.toolName, "write");
  assert.equal(req.callId, "call-1");
  assert.equal(req.signal, signal);
  assert.match(req.reason, /delegate_worker/);
});

test("deny tier is unaffected: source writes never reach the approval service", async () => {
  const { preExecute, calls } = guardFor(async () => "allowed-once");
  const result = await preExecute(writeCall("src/thing.ts"), allowNext);
  assert.equal(result.kind, "deny");
  assert.equal(calls.length, 0, "a hard deny must not ask anyone");
});

test("an existing deny from another listener is respected, not overridden", async () => {
  const { preExecute } = guardFor(async () => "allowed-once");
  const result = await preExecute(writeCall("tests/oracle.mjs"), async () => ({ kind: "deny", reason: "earlier hook said no" }));
  assert.equal(result.kind, "deny");
  assert.equal(result.reason, "earlier hook said no");
});

test("guardMode 'deny' skips the prompt entirely", async () => {
  delete globalThis[REGISTERED_KEY];
  const handlers = {};
  let asked = 0;
  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    get: (name) => (name === "approval" ? { request: async () => (asked++, "allowed-once") } : undefined),
    tools: { register: () => {} },
  };
  apply(ctx, { guardMode: "deny" });
  const result = await handlers["tools/pre-execute"](writeCall("tests/oracle.mjs"), allowNext);
  assert.equal(result.kind, "deny");
  assert.equal(asked, 0, "guardMode 'deny' must not consult the approval service");
});

test("requestApprovalForWrite is safe to call directly with a broken service", async () => {
  const verdict = evaluateCodeWriteGuard(writeCall("tests/x.mjs"));
  assert.equal(verdict.kind, "ask");
  assert.equal(await requestApprovalForWrite({ get: () => undefined }, writeCall("tests/x.mjs"), verdict), "unavailable");
  assert.equal(await requestApprovalForWrite({ get: () => ({ request: "not-a-function" }) }, writeCall("tests/x.mjs"), verdict), "unavailable");
  assert.equal(await requestApprovalForWrite({ get: () => { throw new Error("ctx exploded"); } }, writeCall("tests/x.mjs"), verdict), "unavailable");
});
