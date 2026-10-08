# Findings not yet fixed

Small, real, and known-but-open. Each is the kind of thing this project would rather write down than
rediscover. Resolved entries are kept in place, marked, so the reasoning is not lost.

## A refused write was retried at the declared hint — fixed

**Any emission refusal could be walked around.** Found while building the unit-scope boundary, and it is
the more serious half of the same defect.

`extractAndEmitFiles` ends with a fallback: if nothing was written and the caller declared `targetFiles`,
the content's first code block is written to the first declared hint. The fallback exists for output that
named no file of its own. But it was gated on `filesWritten.length === 0` — which is also true when a file
*was* named and then **refused**.

So a refusal did not stop the write; it moved it. The content meant for the refused path landed at the
declared hint instead, and the verdict reported a written file rather than an error. Measured: a unit
declaring `a.ts` whose worker emitted `b.ts` wrote **1 file** where it should have written none. And the
obvious probe — declaring an inside path while the worker emits a path outside the workspace — would have
put the escaped content inside the workspace at the declared name.

**Impact:** containment, contract-file protection and now unit scope were all advisory to a worker that
named its own file and lost. The checks reported refusals into `emission.errors` that a caller reading
only `filesWritten` would never see as a problem.

**Fixed** by tracking whether a file was *named*, and gating the fallback on that rather than on whether
anything was written (`plugin/src/emission.ts`). Regression test in `unit-scope.test.cjs`: a write refused
for being outside the workspace must not be retried inside it.

Worth noting how it was found: not by reviewing the fallback, which reads correctly in isolation, but by
writing a contract for a *different* feature and having it fail with `1 !== 0`. The two features were
unrelated; the bug lived in the seam between them.

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

## Three of the retry-context oracle's seven failures were the test's fault, not the feature's

The A2 oracle was written first and demonstrated failing **7 of 7**, which is what a contract-first oracle
is supposed to do. Four of those were the feature genuinely missing — the two parsers, the window builder,
and the end-to-end injection. Three were not.

Two of the three called `delegateWorker` with a `runVerification` command and **no `verificationPolicy`**.
The default policy is `ask`, and an oracle has no approver, so the command was refused rather than run: the
first attempt came back `VERIFICATION_NOT_APPROVED` instead of `VERIFICATION_FAILED`, and the "unit that
passed" case never passed at all. The delegation that would have run did not run, for a reason with nothing
to do with context. The fix is one `ALLOW` policy object, named once, with a comment saying why it is there.

The third asserted `second.success === true` on a call that supplied **no verification command**. That call
is `UNVERIFIED` — this plugin's entire position is that nothing was then proven — so `success` is `false` by
design and always will be. The assertion was never true; it merely happened to fail for a different reason
first.

**Why this is worth recording.** A pre-implementation failure count is only evidence when every failure is
the feature's absence. Here the same 7 of 7 would have been reported for an oracle carrying three wrong
assertions, and after implementation the feature would have looked broken when it was not — or, worse, the
assertions would have been "fixed" by weakening the code until they passed. The rule this repo keeps
rediscovering: when an oracle fails, read *why* it failed before believing it. `verificationPolicy` is
especially easy to forget, because the refusal is silent and comes back wearing a plausible status.

An honest amendment to the ROADMAP entry, then: retry-context's oracle proves the feature four times, not
seven. The three harness assertions above are worth keeping — the two policy cases are real controls on the
end-to-end path — but they are not evidence that the feature was absent before it existed.

## The oracle suite still writes into the operator's live data directory

This is the sequel to the entry above about the delegated registry, and it was found by accident while
auditing something else entirely.

`vitest.config.ts` redirects `DSH_HOME` to a temp directory, for a good stated reason: `npm test` used to
append to the operator's real `delegated-registry.json`. That fix is correct and it works. **But it only
covers vitest.** The 275 `.cjs` oracles run under `node --test`, which never loads `vitest.config.ts`, and
only **7 of 28** of them redirect the data directory themselves.

The consequence is measurable: `~/.dsh/local-router/router-debug.log` is 3.3 MB and roughly 120,000 lines,
carrying test fixtures — a fake Slack token, an RSA private key block, `password: "hunter2hunter2"` —
interleaved with live traffic from real sessions. The `DLP_FIREWALL_TRIPPED` and
`PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR` entries from `router-debug.log` at `23:06:18Z` are a `node --test`
run, not the running host.

**Why this is worse than untidy.** `router-debug.log` is not debug output in the colloquial sense — it is
this project's live-observation instrument. `docs/live-verification.md` is built by reading it; several
findings in this file were found by reading it; and the newest document in `docs/` uses it to establish
what the running host does. A test suite writing into that file attacks the evidence base directly. It also
made a check in that audit inconclusive: the absence of a "Plugin already registered" line looked like
evidence that the duplicate-mount guard was never hit, but the log cannot support that reading while it is
being written to by two different processes.

**Why the per-file fix did not hold.** Seven oracles set `DSH_LOCAL_ROUTER_DATA_DIR` or `DSH_HOME`
individually, which is a per-file convention that nothing enforces. A new oracle is isolated only if its
author remembers, and 21 authors did not — or did not need to until their oracle happened to exercise a
path that calls `trace()`. A per-file fix for a cross-cutting concern is not a fix; it is a habit.

The honest repair is one central redirect for the `.cjs` runner, not 21 more copies of the same two lines.

**Fixed.** `plugin/scripts/isolate-oracle-data-dir.cjs` is a `--require` preload, and `npm run test:oracles`
is now `node --require ./scripts/isolate-oracle-data-dir.cjs --test tests/oracles/*.test.cjs`. The parent
`node --test` process decides the directory once and every test child inherits it through `DSH_ORACLE_HOME`,
so a run leaves one temp directory rather than twenty-eight. `DSH_HOME` is used rather than
`DSH_LOCAL_ROUTER_DATA_DIR`, matching `vitest.config.ts`, because the data-dir override is taken verbatim
and would break `resolveDataDir`'s own assertion that the result ends in `local-router`.

The preload also asserts, and throws, if the redirect ever resolves back to the live directory, so the
failure mode is a dead oracle run rather than another few months of silent pollution.

Measured in both directions:

| | effect on the live log, per oracle run |
| --- | --- |
| before | **+4 fixture markers** (2 Slack token, 2 `hunter2hunter2`), plus ~19 KB of trace |
| after | **0** |

The fixtures did not vanish, they moved: each run now leaves a `dsh-oracles-home-*` directory holding a
19,511-byte trace log with exactly those 2 + 2 markers in it. The suite is unchanged at 275/275.

`scripts/check-oracle-isolation.cjs` encodes the property. It counts fixture markers in the live log before
and after running `npm run test:oracles` — markers rather than a file hash, because the running DSH host
appends to that log continuously, so a hash comparison would differ every time and prove nothing. It was
demonstrated red before the fix and green after.

**The general lesson, and it is not about tests.** The earlier registry fix and this one were both per-file
conventions, and both leaked through the files nobody remembered to update. Worse: the gate command was
documented in `docs/refactor.md` as a bare `node --test`, so the manual was instructing every future
session to reintroduce the bug. A contract check that fails loudly is worth more than a convention that is
usually followed — and a documented command is part of the system, not a comment on it.

**The polluted history, archived rather than deleted.** The log up to 2026-10-07 19:27 local moved to
`~/.dsh/local-router/archive/router-debug.pre-oracle-isolation-2026-10-07.log` (3,392,964 bytes), and a
clean `router-debug.log` began 22 ms later — the plugin appends per write rather than holding the file
open, so it recreated the path with no restart and no change to `logging.ts`.

The file was archived and not deleted because it is not garbage: it holds the live evidence
`docs/live-verification.md` quotes, and several entries in this file were found in it. It is mixed, not
worthless. Note what the split costs, though — a quote from before that timestamp will no longer be in the
current log, which is why `live-verification.md` now says where to look. Splitting the evidence base is
itself a small loss, and it was the cheaper of the two options only because the alternative was an
instrument that could not be trusted at all.

## A compile-time contract can be silently vacuous, and `skipLibCheck` hides why

Building the host contract (ROADMAP 21) turned up a failure mode worth its own entry, because the
symptom is indistinguishable from success.

The goal was simple: check this plugin's session-event vocabulary against the host's own
`SessionEventMap`, so that a DSH rename fails `npm run build`. The mechanism is
`as const satisfies readonly SessionEventType[]` in `plugin/src/session-events.ts`.

Three things had to be true for that to mean anything, and **none of them announces itself when false**:

1. `@deepseek-ai/dsh-session` must resolve its types under this plugin's `moduleResolution: "node"`. It
   does, via a top-level `types` field — but that setting ignores `exports` maps, so a package shipping
   only an `exports` map would have resolved to nothing.
2. The `compaction/*` events are not in `dsh-session` at all. `dsh-compaction` declaration-merges them
   from `declare module '@deepseek-ai/dsh-session/types'` — a **subpath**, and there is no physical
   `.../dsh-session/types` on disk. Under `moduleResolution: "node"` that specifier cannot resolve, so
   the augmentation would target a *different* interface rather than merging. Fixed with one explicit
   `paths` entry pointing at the real `types.d.ts`.
3. If any of this failed, `SessionEventMap` could resolve to `any`. `keyof any` is `string | number |
   symbol`, so `satisfies readonly SessionEventType[]` would accept **every** string — including a typo.

And the reason all three fail silently: `skipLibCheck: true` suppresses errors *inside* `.d.ts` files, so
"invalid module name in augmentation" never surfaces. A vacuous assertion and a satisfied one produce
identical output: a clean build.

**So the assertion was tested by breaking it.** Renaming `turn/start` to `turn/started` produced

```
TS2820: Type '"turn/started"' is not assignable to type 'keyof SessionEventMap'.
        Did you mean '"turn/start"'?
```

which proves `SessionEventMap` resolved to the genuine map and that a host rename lands as a build
failure naming the literal. Without that break test, the green build was not evidence of anything — and
it would have gone into the README as though it were.

**The general rule this is an instance of.** When a check's failure mode is *silence* rather than an
error, a passing run tells you nothing until you have watched it fail. This project has now hit that
shape three times: the fence scanner that truncated a body containing a fence, `isSuccess` conflating the
unit and project verdicts, and this. Each was found by disbelieving a green result.

## The architect's usage hooks are wired but never fire

`index.ts` records architect turns — `tracker.recordUsage({ route: 'ARCHITECT_CLOUD', ... })` — from
`agent/post-step`, `agent/step-finish` and `agent/assistant-stream`. The ledger contains **zero** of them:
245 entries, every one `WORKER_LOCAL`, across a day in which the DeepSeek console reports **1,325 API
requests**.

So `cloudTurns`, `architectTurns`, `totalCloudTokens` and `totalSpendUSD` are permanently zero in practice.
The accounting itself is sound — `tests/savings-tracker.test.ts` asserts `ledger.cloudTurns === 1` for a
direct `recordUsage` call and passes — so this is not a counting bug. The hooks simply never deliver
`usage` on this host.

**Why it matters less than it looks, and where the fix should go.** The ledger is a delegation log; the
architect side is measured elsewhere and works. `context-quality.ts` folds `assistant/message` off the
`session/event` firehose and counts model calls correctly — 147 recorded in one session log, consistent
with a host status line reading 980 steps. One instrument works and one is dead. The right move is to
build the missing measurement on the working one rather than to resurrect the dead one.

**Diagnosed.** The three subscriptions could never have fired, for two independent reasons, both checked
against the installed host rather than reasoned about:

1. **`agent/post-step` and `agent/step-finish` do not exist.** Neither name appears anywhere in the
   installed `@deepseek-ai/*` packages. This plugin invented both.
2. **`agent/assistant-stream` exists but carries no usage.** Its frames are `start` / `chunk` / `end`
   (`AssistantStreamFrame` in `dsh-agent`), and none has a `usage` field. `dsh-agent`'s own README calls
   that stream *"presentation data rather than the replay source"* — the durable settlement is the
   `assistant/message` event, which *does* carry `usage?: TokenUsage`.

So the handlers were unreachable code and the four fields were never going to populate. They have been
removed, and the ledger's `scope` string now states that architect usage is not recorded there, and why.

**Why they were not revived.** `assistant/message` is the correct source and it is already subscribed, so
reviving was cheap in principle. It was rejected on cost: it would mean a ledger write on *every* architect
model call — 980 in one observed session — to produce a dollar figure this project no longer claims
anything about. The architect side **is** measured, by the context-quality fold on the same subscription,
as context rather than as money.

**The gap this exposes, which is the useful part.** A plugin can subscribe to an event the host does not
emit and nothing anywhere says so. `ctx.on` is invoked through `any`, so a name the host has never heard of
compiles cleanly and then fails silently for as long as the plugin lives. This is the same shape as the
README's account of `usage.inputTokens`: a plausible-looking integration that produces a number-shaped
absence and is never contradicted. ROADMAP item 21 closed it for session event *types*; hook *names* are
the half still open, and the fix is the same one — type the registration against the host's `Events`
interface so an invented name cannot compile.

**Closed, and it found a fourth phantom on the way.** Subscriptions now go through `onHost`, whose name
parameter is `keyof Events` and whose handler parameter is `OmitThisParameter<Events[K]>`. Converting
`ctx.on('tool/call')` failed to compile — `tool/call` is a *session event type*, not a hook — which both
confirmed the contract and proved `keyof Events` is the host's real vocabulary rather than an empty
interface. Two subtleties were caught by the compiler rather than by review: `onHost` must pass Cordis's
third listener argument through, because the DLP and routing hooks use `{ prepend: true }` and a wrapper
that dropped it would have silently changed dispatch order; and `OmitThisParameter` is required because
several host events declare `this: Scoped<…>`, which a plain arrow function would be rejected for.

**Then the payloads, which found a fifth thing that never worked.** Once handler parameters stopped being
annotated `any` and were inferred from the host's signature, `agent/request` failed on

```
Property 'session' does not exist on type '{ agent: Agent; turn: number; step: number; signal: AbortSignal }'
```

a fallback read kept "in case the payload carries a session" that the payload has never carried. It sat
next to a working `agent?.session` read and looked like a second chance; it was dead from the day it was
written. Same family as the phantom subscriptions, and invisible to review for the same reason — a read of
a field that is merely absent produces `undefined`, not an error, so every defensive fallback of this shape
is indistinguishable from a working one until something checks the shape.

Two things the typing could *not* settle, left as assertions and named as such in the code rather than
papered over: the unreachable `next`-is-not-a-function guards in `agent/request` and `agent/pre-step`, and
the routing hook's return value, which `applyAgentRole` types more loosely than the host's `LlmCallConfig`.
The payload on the way in is checked; the config on the way out is trusted.

