# Live verification after a restart

A DSH restart was the last unverified link for two units, because the running server holds the `dist` it
loaded at startup — so every commit this session was invisible to the process that was exercising it.
After the restart, both were observed working, and the observation found two further defects.

> **Where this evidence lives.** Every `router-debug.log` extract below was read before
> 2026-10-07 19:27 local, when the log was 3.4 MB and still shared with the oracle runner — test fixtures
> were being interleaved into it, which is why an earlier reading of it was inconclusive. It has since been
> split: the history up to that moment is archived at
> `~/.dsh/local-router/archive/router-debug.pre-oracle-isolation-2026-10-07.log`, and a clean
> `router-debug.log` begins there. Any quote below that cannot be found in the current log is in the
> archive. See `findings.md` and `scripts/check-oracle-isolation.cjs`.

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

## The A2 loop, verified live after the next restart

`retryContext` shipped in `3d9404a` and, like everything before it, was invisible to the running process
until a restart. The restart happened, and the loop was then run for real through the registered tool path
— not against a stub HTTP server, as the oracle does, but through DSH's own `delegate_worker`.

It needs a failure that carries a location, so a scratch tree was built outside the repo's build path and
the loop was run in three calls against one workspace:

| call | what it did | what came back |
| --- | --- | --- |
| 1 | created `src/thing.ts` (60 lines) and a `fail.js` printing a TAP failure at `src/thing.ts:30:5` | `SUCCESS`; the `node -e` check over both files passed — which also confirms **verification commands really do execute** on this path |
| 2 | a delegation with `runVerification: "node fail.js"` | `VERIFICATION_FAILED`, with `failures[0].location = "src/thing.ts:30:5"` |
| 3 | a delegation declaring **no `contextFiles` at all** | `contextInjected` = `src/thing.ts` **lines 20–40**, 21 lines, 230 bytes, with a `sha256` |

Three things follow, and only the first was ever in doubt:

1. **The stored location reached the next attempt's injection.** Nothing was declared, so the injection
   cannot have come from anywhere else.
2. **The window is the reported line ± 10.** Line 30 in, 20–40 out — `RETRY_CONTEXT_WINDOW_LINES` doing
   exactly what it says it does.
3. **The architect was handed metadata and not one byte of code.** The verdict carries `path`,
   `relativeName`, `lineRange`, `lines`, `bytes` and `sha256`; the contents went to the worker. That is
   this plugin's whole thesis, demonstrated on its own failure path.

A fourth call, declaring nothing again, returned **no `contextInjected` key at all** — the locations were
consumed by the one attempt that used them, so an old failure cannot quietly influence every later unit in
a session. The scratch tree was deleted afterwards and the working tree was clean.

Because this run touches `tools.register`, the registered tool path, the approval seam, the verification
spawn, emission under unit scope and `session/event` in one go, it is also the closest thing to a host
integration test this project has. [`dsh-0.2-upgrade.md`](dsh-0.2-upgrade.md) uses it as the post-update
check for exactly that reason.

## The contract-injection fix, verified live

`536dfe1` closed a leak the item 15 experiment found: retry-context fed a failure's location back as the
next attempt's context, and a failing contract names itself, so the implementer was shown the very file
`contractFiles` exists to withhold. The full account is in [`experiment.md`](experiment.md).

The running process held the pre-fix `dist`, so the leak stayed observable during the experiment itself and
a restart was needed before the fix could be judged. After the restart the leak was reproduced
deliberately in a scratch workspace — a contract whose own failure names it, seeding the retry set, then a
call declaring that file as `contractFiles` and declaring **no** context of its own, so any injection could
only have come from the retry path.

| | `contextInjected` |
| --- | --- |
| before the fix | `SPEC.md` **plus the contract, lines 65–178, 114 lines, 4,701 bytes** |
| after the fix, live | **absent entirely** |

`contractFiles` reported `unchanged: true` with its sha256 on both sides. That is the useful detail: the
integrity check was never broken and is not what was fixed — the retry path was, and the retry path is
therefore where the verification had to happen. A green integrity report would have been consistent with
the leak still being open.

## The edit boundary and the coherence command, verified live

The rule that a whole-file emission may **create** a file but not **modify** one was verified end to end
through real delegations after a restart, in all three directions, against a throwaway
`src/edit-boundary-probe.js` in the experiment workspace:

| the unit asked for | result |
| --- | --- |
| creation of a file that did not exist | **SUCCESS**, one file written |
| a whole-file rewrite of that file | **VERIFICATION_FAILED**, `filesWritten: []` |
| the same change as a search/replace patch | **SUCCESS**, `patched in place with 1 hunk(s)` |

The refusal is the point, and it says what to do rather than only what it refused:

    Refused to overwrite …\src\edit-boundary-probe.js: the file already exists and a whole-file emission
    may create a file but not modify one; the worker cannot see the file unless its content was injected,
    so the architect should re-delegate with the content as context and have the worker emit a
    search/replace patch instead

The third row is that advice followed, and it is why the rule constrains the form of an edit rather than
what can be expressed. The probe was removed afterwards and the working tree was clean.

The coherence command's path independence was verified live the same way, after its own restart: the
delegation into `experiments/contract-first` that used to report `INCOHERENT` reported **`SUCCESS` with
`Coherence check: Passed 313, Failed 0`**, and `last-coherence.log` showed `tsc`, the 39 unit tests and the
oracle run — the whole gate, executed from a workspace that is not the repository root.

## What remains unverified live

- **The failed-compaction counter.** This used to read "no compaction has occurred in any observed session",
  and that is now false. Read back out of `router-debug.log`, session `f0387683` carries **2
  `compaction/summary` events and 9 `compaction/prune` events**, and the fold tracked every one of them
  exactly: the prune counter stepping 1→9 with `shadowedTokenCount` accumulating 2,529 → 50,937, and each
  summary counting one compaction, the later reading `1 compaction(s), 9 prune(s), 712,892 token(s)
  reclaimed`. So `compaction/summary` and `compaction/prune` are live-verified. What remains is
  `compaction/end`, which is the only source of the *failure* signal — it is the case that increments
  `failedCompactions`, no such event appears anywhere in the log, and that counter has therefore only ever
  been observed reading 0. A counter only ever seen at zero is oracle-tested, not verified.
- **`contextWindow`.** The summary shows `681499 token(s) at the last call` with no denominator, because
  `request/context` is logged only when the route, capacity or system prompt mode *changes* — one such
  event in 3,397 in the previous session. The absolute figure works; the fraction of capacity is
  best-effort by DSH's design, not a gap in this fold.
