# Findings not yet fixed

Small, real, and known-but-open. Each is the kind of thing this project would rather write down than
rediscover.

## Running the test suite pollutes the operator's live registry

`delta-emission.test.cjs` and `context-injection.test.cjs` call `delegateWorker`, and `delegateWorker`
calls `rememberDelegated`, which persists. So running the oracles writes into the operator's real
`~/.dsh/local-router/delegated-registry.json`.

Observed directly: the registry's newest entries were
`C:\Users\Jim\AppData\Local\Temp\dsh-delta-*\target.ts` — one per oracle run, forever.

Impact is low, because they are temp paths and gating reads of them is moot. But it is undeclared state
mutation from a test run, which is the same category as the config that claimed a control it did not have.

**Fix:** set `DSH_LOCAL_ROUTER_DATA_DIR` to a temp directory for *every* oracle that delegates, not only
for `durable-registry.test.cjs`, which is the one that already does it. `resolveDataDir()` honours that
variable and reads it at call time, so an env assignment in the oracle is sufficient.

## `enable_thinking: false` on the worker does nothing

`delegateWorker` sends `enable_thinking: false` and `reasoning_effort: 'none'` on every request. The
local server ignores both: LM Studio's per-model setting is authoritative. Measured with
`scripts/probe-thinking.mjs` — four variants of one request, including `enable_thinking: false` and
`reasoning_effort: 'high'`, returned byte-identical results.

So the worker reasons a little whether or not it is asked not to, and `PROFILES.WORKER.enable_thinking`
reads as a control that works. It should either be removed or documented as advisory.

## `PROFILES.LEAD` is almost entirely inert

Only `PROFILES.LEAD.provider` is read — one line, by `resolveLeadProviders`. `model`, `endpoint`,
`contextWindow`, `temperature`, `max_tokens`, `enable_thinking`, `reasoning_effort` and `systemInstruction`
are never applied, because the plugin leaves lead requests exactly as the host configured them.

`systemInstruction` is already documented as reference-only. The rest are not, and they currently read as
though they configure the tier.

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

