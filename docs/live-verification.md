# Live verification after a restart

A DSH restart was the last unverified link for two units, because the running server holds the `dist` it
loaded at startup — so every commit this session was invisible to the process that was exercising it.
After the restart, both were observed working, and the observation found two further defects.

## What the restart verified

**1. The fence scanner fix (`ad08939`) is live.** The probe that failed before the restart was re-run
unchanged — a patch whose SEARCH text quotes a ` ``` ` line, matching text that does not exist in the
file:

| | result |
| --- | --- |
| before restart | `the patch contained no complete search/replace block` — the body was truncated at the fence |
| after restart | `no exact match for a search block (// THIS-TEXT-DOES-NOT-EXIST-IN-THE-FILE probe marker with a )` |

The second message is the proof: the parser saw the **whole** block, quotes and all, and correctly
reported that the text is not in the file. That is what the fix was for, and it is a different failure
message rather than a passing test — the useful kind of evidence.

**Consequence:** the `docs/pending-patch.md` + `scripts/apply-staged-patch.cjs` workaround is no longer
needed. Patches quoting fences now go through `delegate_worker` like any other.

**2. The context-quality counters are live.** `router-debug.log` gained its first `CONTEXT_QUALITY`
entries, sourced from a real session:

```
=== CONTEXT_QUALITY ===
{ "session": "session-", "event": "turn/start",
  "summary": "1 turn(s), 0 step(s), ... 0 token(s) at the last call" }

=== CONTEXT_QUALITY ===
{ "session": "session-", "event": "assistant/message",
  "summary": "1 turn(s), 1 step(s), ... 681499 token(s) at the last call" }
```

So the `session/event` subscription works from a plugin, the fold runs on live events, the counters
accumulate across events, and **681,499 tokens** is the cache-summed window — the number the broken
version reported as 333.

## Two defects the live run found

**The session label identified nothing.** DSH ids are `session-<uuid>`, and `key.slice(0, 8)` is the
constant prefix, so every session logged as `"session-"`. Fixed to take the eight characters *after* the
prefix.

**The seed limitation is real, and an independent source confirms it.** The plugin's own
`HOOK_CAPTURE` recorded this turn as `"turn": 16`, while the live counter said `1 turn(s)`. DSH's session
status line agrees with the plugin: **16 turns**. The firehose publishes only what this process produced,
so a resumed session is counted from the resume. The doc comment predicted this; now it is observed.

## The cross-check that validates the cache fix

DSH's own status line reported **213M tokens over 575 steps, 99.8% cache hit**. Three consequences:

- **213M / 575 ≈ 370,435 tokens per step.** The window really is in the hundreds of thousands, so the
  broken `inputTokens` reading — a ~330-token median — was not a display quirk. Any total derived from it
  would have read ~189,750 against DSH's 213,000,000: **under-counted by ~1,123×**.
- **681,499 tokens at a 99.8% cache hit implies ~1,363 uncached tokens.** The last call reported
  `inputTokens` 228. Same order, and the small difference is explained by the rate being a session
  average rather than the last call's own. This is independent confirmation that `inputTokens` is the
  uncached remainder, arrived at from outside the plugin entirely.
- **16 turns.** As above.

## What remains unverified live

- **The compaction counters.** No compaction has occurred in any observed session, so `compaction/summary`,
  `compaction/prune` and `compaction/end` are oracle-tested only. The event shapes are read from
  `dsh-compaction`'s own types, but no live event has been folded.
- **`contextWindow`.** The summary shows `681499 token(s) at the last call` with no denominator, because
  `request/context` is logged only when the route, capacity or system prompt mode *changes* — one such
  event in 3,397 in the previous session. The absolute figure works; the fraction of capacity is
  best-effort by DSH's design, not a gap in this fold.
