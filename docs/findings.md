# Findings not yet fixed

Small, real, and known-but-open. Each is the kind of thing this project would rather write down than
rediscover. Resolved entries are kept in place, marked, so the reasoning is not lost.

## `TokenUsage.inputTokens` is not the window — found by live testing, fixed

The context-quality counters first reported the prompt as `usage.inputTokens`. That is wrong, and wrong by
a factor of thousands.

Measured by decoding a real session log — this project's own, in fact — and running the fold over the
events it actually recorded. The last model call reported:

| field | value |
| --- | --- |
| `inputTokens` | 228 |
| `cacheReadTokens` | 659,456 |
| `totalTokens` | 661,541 |
| `outputTokens` | 1,857 |

and `inputTokens + cacheReadTokens + outputTokens === totalTokens` exactly. So `inputTokens` counts only
the **uncached remainder**; the cached prefix — which on any caching provider is most of the window — has
to be added back. The first version reported **228 tokens for a 660,000-token window**, off by ~2,900×,
and in the direction that makes a full window look empty.

**Why the types did not catch it.** `TokenUsage` declares `inputTokens: number` and documents only
`totalTokens` ("exact full-call total"). Nothing in the type says `inputTokens` excludes the cache; the
semantics only exist in the data. Reading the `.d.ts` was enough to find the *field*, and not enough to
find the *meaning*.

**How it was caught.** Not by review and not by the oracle — the oracle asserted what the implementation
did, and agreed with it. It was caught by folding a real session log and noticing that a session this
long reported a 333-token prompt. The symptom was a number that was obviously too small, which is the
argument for live verification over more assertions.

**Fixed** by summing the cache read (`plugin/src/context-quality.ts`), and renamed
`lastModelInputTokens`/`peakModelInputTokens` to `lastPromptTokens`/`peakPromptTokens`, because the old
name is what invited the mistake: the provider's "input tokens" is not the prompt. The oracle now carries
the measured figures as its case rather than a synthetic one.

**Verified after the fix, on the same live log:** `675,105 / 1,000,000` tokens — 67.5% of the advertised
window at the peak, where the broken version said `333 / 1,000,000`.

Two notes on reading that log, for anyone repeating it: the session files are **multi-frame zstd**, and
Node's `zstdDecompressSync` decodes only the first frame (201 bytes of header), so the frames have to be
walked and each one decompressed separately. And DSH persists the *construction seed* alongside live
events, so a fold over the whole file over-counts relative to what a live `session/event` subscriber sees
— 15 turns / 564 steps against 12 / 335 here.

## The test suite polluted the operator's live registry — fixed

`delegateWorker` calls `rememberDelegated`, which persists. So any test that delegates files wrote into
the operator's real `~/.dsh/local-router/delegated-registry.json`.

Observed directly: the registry's newest entries were
`C:\Users\Jim\AppData\Local\Temp\dsh-delta-*\target.ts`. **Measured rather than attributed by reading:**
one `vitest` run and one `node --test tests/oracles/*.test.cjs` run each grew the registry by exactly one
record, repeatably. `delta-emission.test.cjs` was the oracle responsible; `context-injection.test.cjs`
delegates but writes nothing today, because its refusal paths return before emission.

The first draft of this finding named the wrong pair of files and the wrong fix. Reading the source
suggested `context-injection` and `delta-emission`; instrumenting the registry showed `vitest` was the
other contributor, which source-reading had missed entirely.

**Fixed** by redirecting plugin state in the two runners:

- `plugin/vitest.config.ts` sets `DSH_HOME` to a temp directory through `test.env`, which covers every
  unit test including `plugin.test.ts`.
- `delta-emission.test.cjs` and `context-injection.test.cjs` set `DSH_LOCAL_ROUTER_DATA_DIR` before the
  first `require` of `DIST`.

Two details worth keeping:

- **`DSH_HOME` was used for vitest, not `DSH_LOCAL_ROUTER_DATA_DIR`.** The data-dir override is taken
  verbatim, so it would have broken `resolveDataDir`'s own assertion that the result ends in
  `local-router`; `DSH_HOME` is joined with that segment. That test was then strengthened to pin the
  *unset* default as well, rather than quietly testing the new override instead.
- **Verified by measurement, not by inspection:** registry size before and after each suite. Both are
  now 0 growth, where each was 1.

## `enable_thinking: false` on the worker does nothing — documented as advisory

`delegateWorker` sends `enable_thinking: false` and `reasoning_effort: 'none'` on every request. The
local server ignores both: LM Studio's per-model setting is authoritative. Measured with
`scripts/probe-thinking.mjs` — four variants of one request, including `enable_thinking: false` and
`reasoning_effort: 'high'`, returned byte-identical results.

So the worker reasons a little whether or not it is asked not to, and `PROFILES.WORKER.enable_thinking`
read as a control that works.

**Resolved by documenting, not removing.** The two keys are still transmitted and still state the intent,
so `PROFILES.WORKER` now carries a doc comment saying they are **advisory only** and must not be read as
a control — `plugin/src/profiles.ts`. Removal was the alternative and was not taken: it would change the
request payload and the unit test that pins it, to express the same fact less clearly. The limit is now
stated where the configuration is read, which is the place it was misleading.

## `PROFILES.LEAD` is almost entirely inert — marked reference-only

Only `PROFILES.LEAD.provider` is read — one line, by `resolveLeadProviders`. `model`, `endpoint`,
`contextWindow`, `temperature`, `max_tokens`, `enable_thinking`, `reasoning_effort` and `systemInstruction`
are never applied, because the plugin leaves lead requests exactly as the host configured them.

`systemInstruction` was already documented as reference-only. **Resolved by extending that marking to
every field**, in `plugin/src/profiles.ts`: the doc comment now names each unapplied field, says plainly
that changing one has no effect on any request, and frames the object as the record of what the tier was
configured to be rather than as configuration.

The fields were **not** deleted. `lead-tier.test.cjs` is a contract oracle that asserts the tier's shape —
`enable_thinking`, `reasoning_effort`, `endpoint`, `provider`, `contextWindow`, `systemInstruction` — and
the tier is retired, not removed. Deleting the fields would leave that oracle asserting nothing about a
capability the plugin still exposes through `leadTier`/`leadProviders`, which is a worse outcome than a
clearly-labelled record.

## The fence scanner truncates a block whose body contains a fence

`extractAndEmitFiles` finds fenced blocks with a non-greedy regex:

```ts
/```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
```

`[\s\S]*?` stops at the **first** three-backtick run anywhere after the header. When the body itself
contains a fence — a patch whose SEARCH text quotes a ` ``` ` line, or a file whose content is a
markdown example — the captured body ends early and everything after it is dropped.

Measured, not inferred. A worker reply whose patch quoted a regex containing ` ``` ` extracted as:

```
PATH= "plugin/src/index.ts"
BODY= "<<<<<<< SEARCH\n  const fileAttrRegex = /"
```

The block parser then reported `the patch contained no complete search/replace block`, and the emission
was refused. The parse and apply primitives are correct — handed the same text directly they return one
complete block — so the fault is entirely in the scanner.

**Impact:** any delegated emission that quotes or generates a fenced block inside a fenced block is
refused, and the refusal is reported as a malformed patch rather than as a scanner limitation. This is
what made the refactor's own extraction hard: the moved code contains regexes with ` ``` ` in them, so no
patch quoting that code could be applied. It was worked around by staging those patches in a file and
applying them with `scripts/apply-staged-patch.cjs`, which is a workaround for a bug, not a design.

**Fix:** match the closing fence only where a fence can legally close — at the start of a line, and
requiring the run to be at least as long as the opening one. `^(?:```+)\s*$` with the `m` flag, anchored
per line, rather than `[\s\S]*?` to the next bare run.

## The configured worker stops generating at about 1,200 tokens

`PROFILES.WORKER.max_tokens` is 8192, but a direct request asking for 300 lines came back with exactly
`completion_tokens=1200` and `finish_reason=stop` — the model chose to stop, so it is a model or LM Studio
preset limit rather than a plugin one. Prompts are not the constraint: a 5,252-token prompt was accepted.

**Impact:** a single delegated emission cannot produce a module much larger than ~150 lines, and a reply
that carries both a file and a patch plan is truncated mid-structure. Every "the worker returned 28 lines"
and "no complete search/replace block" failure in the emission.ts round traces to this. Work that needs a
large file must arrive in several small requests, or the fence/parse path must be made robust enough that
truncation is visible as truncation.

## The context-quality counters cannot see a resumed session's history

`context-quality.ts` folds DSH's `session/event` firehose. That firehose does **not** publish events that
entered through construction — replay, fork, or resume — which DSH's own session service documents: a
constructor seed never emits.

**Impact:** a resumed session is counted from the resume, not from its true beginning. For "compactions
per session" and "turns before restart" that is the wrong denominator, and it fails in the direction of
under-reporting: a session that was compacted five times before a restart shows zero once resumed.

It is not fixable by subscribing harder. The honest options are to read the persisted log for the seed
(the `session-stats` projection shows the pattern: a fold with a state version, seeded from stored rows),
or to label the counter as process-scoped rather than session-scoped. The second is truer to what the
firehose can actually answer, and is what the module's doc comment says today.

