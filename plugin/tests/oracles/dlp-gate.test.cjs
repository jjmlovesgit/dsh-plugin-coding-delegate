// Oracle for the enforced DLP gate.
//
// Drives the real agent/pre-step capture and the real agent/request gate from the
// built plugin, so this exercises the live path rather than the helper in isolation.
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { apply } = require(PLUGIN + "/dist/index.js");

const FAKE_KEY = 'api_key = "sk-' + "a".repeat(32) + '"';
const CLEAN = "rename the variable x to y in this function";

/** Mount the plugin on a mock ctx and return its captured listeners. */
function hooksFor(options = {}) {
  const handlers = {};
  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    get: () => undefined,
    tools: { register: () => {} },
  };
  apply(ctx, options);
  return handlers;
}

/** Feed a prompt through the real pre-step capture, then run the request gate. */
async function issueRequest(handlers, prompt, turn = 1) {
  const preStep = handlers["agent/pre-step"];
  if (preStep) {
    await preStep({ turn, messages: [{ role: "user", content: prompt }] }, async () => ({}));
  }
  const next = async () => ({ provider: "upstream-default", model: "upstream-default" });
  return handlers["agent/request"]({ agent: { id: "agent-1" }, turn, step: 1, signal: new AbortController().signal }, next);
}

test("a clean payload is passed through to the cloud architect unchanged", async () => {
  const handlers = hooksFor();
  const config = await issueRequest(handlers, CLEAN);
  assert.equal(config.provider, "deepseek-official");
  assert.equal(config.model, "deepseek-chat");
  assert.ok(Array.isArray(config.tools), "tool schema is still injected");
  assert.ok(
    config.tools.some((t) => (t?.function?.name || t?.name) === "delegate_worker"),
    "delegate_worker must remain available to the architect"
  );
});

test("a credential-bearing payload is BLOCKED, not transmitted", async () => {
  const handlers = hooksFor();
  await assert.rejects(
    () => issueRequest(handlers, `here is my key ${FAKE_KEY} please fix the client`),
    (err) => {
      assert.match(err.message, /DLP firewall blocked this request/);
      assert.match(err.message, /API Key/i, "the error should name the offending pattern");
      assert.match(err.message, /Nothing was transmitted/);
      return true;
    }
  );
});

test("dlpAction 'local' pins the sensitive request to the local worker instead", async () => {
  const handlers = hooksFor({ dlpAction: "local" });
  const config = await issueRequest(handlers, `here is my key ${FAKE_KEY} please fix the client`);
  assert.equal(config.provider, "lm-studio", "the payload must not go to the cloud provider");
  assert.equal(config.model, "qwen/qwen3.8-27b");
});

test("enforceDLP:false disables the gate entirely", async () => {
  const handlers = hooksFor({ enforceDLP: false });
  const config = await issueRequest(handlers, `here is my key ${FAKE_KEY}`);
  assert.equal(config.provider, "deepseek-official");
});

test("every credential family trips the gate", async () => {
  const samples = {
    "github pat": "ghp_" + "a".repeat(36),
    "fine-grained pat": "github_pat_" + "b".repeat(22) + "_" + "c".repeat(59),
    "openai key": "sk-" + "d".repeat(32),
    "aws key": "AKIA" + "IOSFODNN7" + "EXAMPLE",
    "slack token": "xoxb-" + "1234567890-" + "abcdefghij",
    "private key": "-----BEGIN RSA PRIVATE " + "KEY-----\nMIIE\n-----END RSA PRIVATE " + "KEY-----",
    password: 'password: "hunter2hunter2"',
  };
  for (const [name, payload] of Object.entries(samples)) {
    const handlers = hooksFor();
    await assert.rejects(
      () => issueRequest(handlers, `context ${payload} context`),
      /DLP firewall blocked/,
      `${name} should have been blocked`
    );
  }
});

test("the gate is not tripped by ordinary code discussion", async () => {
  const handlers = hooksFor();
  for (const text of [
    "refactor this module into smaller pieces",
    "add a password field to the login form",
    "the config reads an api key from an environment variable",
    "explain how AKIA prefixes are formatted",
  ]) {
    const config = await issueRequest(handlers, text);
    assert.equal(config.provider, "deepseek-official", `false positive on: ${text}`);
  }
});

test("a blocked request never returns a config object", async () => {
  const handlers = hooksFor();
  let returned;
  try {
    returned = await issueRequest(handlers, FAKE_KEY);
  } catch {
    returned = undefined;
  }
  assert.equal(returned, undefined, "a blocked request must not yield a dispatchable config");
});
