// Oracle: the pending-prompt handoff is scoped to the session that queued it.
//
// `agent/pre-step` carries the claimed messages and `agent/request` carries none, so the plugin
// stashes the prompt at pre-step and reads it back at request time. That stash used to be keyed by
// turn number alone, and turn numbers are per session -- every delegated subagent starts at turn 1 --
// so two sessions sitting on the same turn could hand each other their text. The subject the gate
// scans is `corpus.length > prompt.length ? corpus : prompt`, so a borrowed prompt LONGER than this
// session's own corpus replaced it outright and the session's own text was never scanned at all.
// That is the one direction that is exposure rather than a false positive: the credential goes out.
//
// Both directions are pinned here, each asserted through the real agent/pre-step capture and the real
// agent/request gate of the built plugin:
//   1. a session's own credential still trips the gate when another session queued the same turn;
//   2. a clean session is not pinned by another session's credential at the same turn.
//
// Before the key carried the session, test 1 sent a credential to the cloud provider and test 2
// pinned a session that had said nothing sensitive.
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = require("node:path").resolve(__dirname, "..", "..");
const { apply } = require(PLUGIN + "/dist/index.js");

const SECRET = 'api_key = "sk-' + "a".repeat(32) + '"';
// Long enough to out-length the other session's whole corpus, which is what made the borrowed prompt
// win the `corpus.length > prompt.length` comparison.
const PAD = "x".repeat(120);

/** Mount the plugin and return its captured listeners. */
function mount(options = {}) {
  const handlers = {};
  const ctx = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    get: () => undefined,
    tools: { register: () => {} },
  };
  apply(ctx, {
    dlpAction: "local",
    localProvider: "lm-studio",
    localModel: "qwen/qwen3.8-27b",
    cloudProvider: "deepseek-official",
    cloudModel: "deepseek-chat",
    ...options,
  });
  return handlers;
}

/** Real pre-step capture for one session, one turn. */
function preStep(handlers, agent, turn, content) {
  return handlers["agent/pre-step"](
    { turn, agent, messages: [{ role: "user", content }] },
    async () => ({ kind: "enter" })
  );
}

/** Real request gate for one session, one turn. */
function request(handlers, agent, turn) {
  return handlers["agent/request"](
    { turn, agent, step: 1, signal: new AbortController().signal },
    async () => ({ provider: "upstream-default", model: "upstream-default" })
  );
}

test("a session's own credential still trips the gate when another session queued the same turn", async () => {
  const handlers = mount();
  const victim = { id: "session-victim" };
  const other = { id: "session-other" };

  await preStep(handlers, victim, 1, `here is my key ${SECRET}`);
  // Queued second and longer, so it was the entry `get(1)` returned.
  await preStep(handlers, other, 1, `${PAD} a long and entirely clean message`);

  const config = await request(handlers, victim, 1);
  assert.equal(
    config.provider,
    "lm-studio",
    "this session's own text must be what its gate scans, whatever another session queued"
  );
});

test("a clean session is not pinned by another session's credential at the same turn", async () => {
  const handlers = mount();
  const clean = { id: "session-clean" };
  const dirty = { id: "session-dirty" };

  await preStep(handlers, clean, 1, "rename the variable x to y in this function");
  await preStep(handlers, dirty, 1, `${PAD} here is my key ${SECRET}`);

  const config = await request(handlers, clean, 1);
  assert.equal(
    config.provider,
    "deepseek-official",
    "this session said nothing sensitive, so it is not the one the gate was for"
  );
});

test("each session's own turn-1 prompt decides its own request, in either arrival order", async () => {
  const handlers = mount();
  const first = { id: "session-first" };
  const second = { id: "session-second" };

  await preStep(handlers, first, 1, `${PAD} here is my key ${SECRET}`);
  await preStep(handlers, second, 1, `${PAD} rename the variable x to y in this function`);

  const secondConfig = await request(handlers, second, 1);
  const firstConfig = await request(handlers, first, 1);

  assert.equal(secondConfig.provider, "deepseek-official", "the clean session goes to the cloud");
  assert.equal(firstConfig.provider, "lm-studio", "the credential-bearing session stays local");
});
