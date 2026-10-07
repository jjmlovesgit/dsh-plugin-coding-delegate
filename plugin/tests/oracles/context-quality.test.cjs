// Contract oracle: context-quality counters.
//
// Written before the implementation; it fails until the unit exists.
//
// Why this is a contract. README says, of the plugin's central claim: "What the plugin does not yet do
// is measure context quality; it measures tokens." The claim is that keeping code out of the architect's
// window is what lets a long session survive, and until this counter exists that claim is argued rather
// than observed. This is the unit that makes it observable.
//
// The events are DSH's own, read from the installed packages rather than invented here:
//
//   dsh-session    augments SessionEventMap with turn/start, turn/end, step/start, step/end, ...
//   dsh-compaction augments it with compaction/start, compaction/summary, compaction/end, compaction/prune
//
// and `compaction/summary` and `compaction/prune` each carry `shadowedTokenCount` -- the host's own
// figure for how much context the replacement removed. So the measurement is *reported by the harness*,
// not estimated by this plugin, which is the difference between evidence and a proxy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN = path.resolve(__dirname, "..", "..");
const DIST = PLUGIN + "/dist/index.js";

// An event as the `session/event` firehose publishes it: a discriminated record with `type` and `data`.
const ev = (type, data = {}) => ({ type, data, time: 0, seq: 1 });

test("the counters start at zero", () => {
  const { EMPTY_CONTEXT_QUALITY } = require(DIST);
  assert.equal(EMPTY_CONTEXT_QUALITY.turns, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.steps, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.compactions, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.prunes, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.failedCompactions, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.tokensReclaimed, 0);
});

test("a turn is counted, and so is a step", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("turn/start", { turn: 1 }));
  s = foldContextQuality(s, ev("step/start", { turn: 1, step: 1 }));
  s = foldContextQuality(s, ev("step/start", { turn: 1, step: 2 }));
  assert.equal(s.turns, 1);
  assert.equal(s.steps, 2);
});

test("a completed summarising compaction is counted, with the tokens it reclaimed", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("turn/start", { turn: 4 }));
  s = foldContextQuality(s, ev("compaction/start", { compactionId: "c1", turn: 4 }));
  s = foldContextQuality(
    s,
    ev("compaction/summary", { compactionId: "c1", shadowedTokenCount: 12000, provider: "deepseek", model: "deepseek-chat" })
  );
  s = foldContextQuality(s, ev("compaction/end", { compactionId: "c1", turn: 4 }));
  assert.equal(s.compactions, 1);
  assert.equal(s.tokensReclaimed, 12000);
  assert.equal(s.failedCompactions, 0);
});

test("a model-free prune is counted separately, and also reclaims", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  const s = foldContextQuality(
    EMPTY_CONTEXT_QUALITY,
    ev("compaction/prune", { shadowedTokenCount: 800 })
  );
  assert.equal(s.prunes, 1);
  assert.equal(s.compactions, 0, "a prune is not a summarising compaction");
  assert.equal(s.tokensReclaimed, 800);
});

test("reclaimed tokens accumulate across compactions and prunes", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = EMPTY_CONTEXT_QUALITY;
  s = foldContextQuality(s, ev("compaction/summary", { shadowedTokenCount: 1000 }));
  s = foldContextQuality(s, ev("compaction/prune", { shadowedTokenCount: 250 }));
  s = foldContextQuality(s, ev("compaction/summary", { shadowedTokenCount: 5000 }));
  assert.equal(s.compactions, 2);
  assert.equal(s.prunes, 1);
  assert.equal(s.tokensReclaimed, 6250);
});

test("a compaction that ended with an error is counted as failed, not as completed", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("compaction/start", { compactionId: "c9", turn: 2 }));
  s = foldContextQuality(s, ev("compaction/end", { compactionId: "c9", turn: 2, error: "provider 500" }));
  assert.equal(s.failedCompactions, 1);
  assert.equal(s.compactions, 0);
  assert.equal(s.tokensReclaimed, 0);
});

test("an event it does not care about returns the same reference", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  const s = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("tool/call", { name: "read" }));
  assert.equal(s, EMPTY_CONTEXT_QUALITY, "an uninteresting event must not allocate, or the change feed is never quiet");
  const t = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("assistant/message", { turn: 1, step: 1 }));
  assert.equal(t, EMPTY_CONTEXT_QUALITY);
});

test("malformed events do not throw and do not move the counters", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  const rubbish = [
    null,
    undefined,
    {},
    { type: "turn/start" },
    { type: "turn/start", data: null },
    ev("compaction/summary", { shadowedTokenCount: "lots" }),
    ev("compaction/summary", { shadowedTokenCount: -5 }),
    ev("compaction/summary", { shadowedTokenCount: Infinity }),
    ev("compaction/summary", { shadowedTokenCount: NaN }),
    ev("compaction/prune"),
  ];
  let s = EMPTY_CONTEXT_QUALITY;
  for (const event of rubbish) {
    assert.doesNotThrow(() => {
      s = foldContextQuality(s, event);
    }, "the firehose handler must never throw: " + JSON.stringify(event));
  }
  assert.equal(s.tokensReclaimed, 0, "an unusable token count must not be counted as zero-or-anything");
  assert.equal(s.compactions, 0);
});

test("a realistic session folds to the expected totals", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  const log = [
    ev("turn/start", { turn: 1 }),
    ev("step/start", { turn: 1, step: 1 }),
    ev("assistant/message", { turn: 1, step: 1 }),
    ev("step/end", { turn: 1, step: 1 }),
    ev("turn/end", { turn: 1, reason: "success" }),
    ev("turn/start", { turn: 2 }),
    ev("step/start", { turn: 2, step: 1 }),
    ev("compaction/prune", { shadowedTokenCount: 400 }),
    ev("tool/call", { name: "read" }),
    ev("step/end", { turn: 2, step: 1 }),
    ev("compaction/start", { compactionId: "c1", turn: 2 }),
    ev("compaction/summary", { compactionId: "c1", shadowedTokenCount: 9000 }),
    ev("compaction/end", { compactionId: "c1", turn: 2 }),
    ev("turn/end", { turn: 2, reason: "success" }),
  ];
  const s = log.reduce((acc, e) => foldContextQuality(acc, e), EMPTY_CONTEXT_QUALITY);
  assert.equal(s.turns, 2);
  assert.equal(s.steps, 2);
  assert.equal(s.compactions, 1);
  assert.equal(s.prunes, 1);
  assert.equal(s.tokensReclaimed, 9400);
  assert.equal(s.failedCompactions, 0);
});

test("the counters render as one line an operator can read", () => {
  const { foldContextQuality, describeContextQuality } = require(DIST);
  const { EMPTY_CONTEXT_QUALITY } = require(DIST);
  let s = foldContextQuality(EMPTY_CONTEXT_QUALITY, ev("turn/start", { turn: 1 }));
  s = foldContextQuality(s, ev("compaction/prune", { shadowedTokenCount: 1500 }));
  const line = describeContextQuality(s);
  assert.equal(typeof line, "string");
  assert.match(line, /1 turn/);
  assert.match(line, /1500/);
  assert.equal(line.includes("\n"), false, "it is a trace payload, so it must be one line");
});

// The per-turn window figure. README named "frontier tokens in the window per turn" as the third proxy;
// reading the installed packages showed it needs to be neither estimated nor fetched from the
// dsh-token-meter projection, because the provider already reports it:
//
//   dsh-llm     TokenUsage has a REQUIRED `inputTokens`
//   dsh-session `assistant/message` carries `usage?: TokenUsage`
//
// So the input-token count of the request the model actually received arrives on the same firehose the
// rest of these counters fold.

test("the model's reported input tokens are recorded, and the high-water mark is kept", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = foldContextQuality(
    EMPTY_CONTEXT_QUALITY,
    ev("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 9000, outputTokens: 120 } })
  );
  assert.equal(s.lastModelInputTokens, 9000);
  assert.equal(s.peakModelInputTokens, 9000);
  s = foldContextQuality(
    s,
    ev("assistant/message", { turn: 1, step: 2, usage: { inputTokens: 4000, outputTokens: 80 } })
  );
  assert.equal(s.lastModelInputTokens, 4000, "the latest call is the current window");
  assert.equal(s.peakModelInputTokens, 9000, "the high-water mark is the figure that forces a compaction");
});

test("the advertised context window and the route are recorded", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  const s = foldContextQuality(
    EMPTY_CONTEXT_QUALITY,
    ev("request/context", { provider: "deepseek-official", model: "deepseek-chat", contextWindow: 128000 })
  );
  assert.equal(s.contextWindow, 128000);
  assert.equal(s.route, "deepseek-official/deepseek-chat");
});

test("a model call with unusable usage does not move the figures", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = EMPTY_CONTEXT_QUALITY;
  const bad = [undefined, null, {}, { inputTokens: "many" }, { inputTokens: -1 }, { inputTokens: NaN }, { inputTokens: Infinity }];
  for (const usage of bad) {
    assert.doesNotThrow(() => {
      s = foldContextQuality(s, ev("assistant/message", { turn: 1, step: 1, usage }));
    }, "usage: " + JSON.stringify(usage));
  }
  assert.equal(s.lastModelInputTokens, 0);
  assert.equal(s.peakModelInputTokens, 0);
});

test("a missing usage figure is not read as a shrunken window", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality } = require(DIST);
  let s = foldContextQuality(
    EMPTY_CONTEXT_QUALITY,
    ev("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 5000, outputTokens: 10 } })
  );
  s = foldContextQuality(s, ev("assistant/message", { turn: 1, step: 2 }));
  assert.equal(s.lastModelInputTokens, 5000, "an unreported figure must leave the last known one standing");
  assert.equal(s.peakModelInputTokens, 5000);
});

test("the one-line summary carries the window figures when it has them", () => {
  const { EMPTY_CONTEXT_QUALITY, foldContextQuality, describeContextQuality } = require(DIST);
  let s = foldContextQuality(
    EMPTY_CONTEXT_QUALITY,
    ev("request/context", { provider: "deepseek-official", model: "deepseek-chat", contextWindow: 1000 })
  );
  s = foldContextQuality(
    s,
    ev("assistant/message", { turn: 1, step: 1, usage: { inputTokens: 750, outputTokens: 5 } })
  );
  const line = describeContextQuality(s);
  assert.match(line, /750/);
  assert.match(line, /1000/);
  assert.equal(line.includes("\n"), false, "still a trace payload");
});

test("the new counters start at zero too", () => {
  const { EMPTY_CONTEXT_QUALITY } = require(DIST);
  assert.equal(EMPTY_CONTEXT_QUALITY.lastModelInputTokens, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.peakModelInputTokens, 0);
  assert.equal(EMPTY_CONTEXT_QUALITY.contextWindow, null);
  assert.equal(EMPTY_CONTEXT_QUALITY.route, "");
});
