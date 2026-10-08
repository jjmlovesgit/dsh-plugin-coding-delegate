# Experiment: does delegation reduce the metered context a feature costs?

Setup and protocol. **No results yet** — this file exists so that whatever gets run is worth
believing, and so that a refutation is possible.

## The question

Producing a given feature, does the delegated pattern require less **metered context** than one
model doing everything?

That is a token-and-context question. Two adjacent claims are already settled and this experiment
cannot reopen them:

- **Cost.** Local hardware does not pay for itself. Measured: this project's entire delegated
  output is worth $0.1047 of cloud-equivalent, against a card that would need roughly 19,000x this
  workload to break even.
- **Privacy.** What stays local is the *writing*. The architect reads source to architect, every
  read enters its window, and every read is re-sent on every later turn — measured at ~8.5 read
  events per turn. The reading is not private and cannot be, because planning against a codebase
  requires seeing it.

What is *unmeasured* is the thing both claims get confused with: whether the pattern reduces what
the metered model has to hold in order to get the feature built. That is what this measures.

## The task

Build `createTtlCache` from
[`../contract-first/SPEC.md`](../contract-first/SPEC.md) — architect-authored, prose and interface
only, no algorithm.

**Both arms receive the spec verbatim.** Neither receives any other description of the work.

### The frozen judge

[`../contract-first/tests/spec-conformance.test.cjs`](../contract-first/tests/spec-conformance.test.cjs)
— 16 checks written from `SPEC.md` before either arm runs, and not touched afterwards.

Both arms are judged by this file and nothing else. The delegated arm declares it as
`contractFiles`, so its hashes are checked before and after the worker runs and no worker can edit
it. **That is deliberate and it is a deviation from the normal pattern**: usually the architect
authors the contract, and here it is handed to both arms so that the two are judged identically.
It follows that this experiment measures the *emission and iteration* cost of delegation, not the
cost of authoring a contract, which is a real part of the pattern and is excluded here.

### Why this task, and its weakness

It is small, self-contained, has internal structure (a store, a recency order, an expiry rule and
four counters that meet), and comes with a judge that already exists and is already frozen.

**Its weakness is the reading term.** `SPEC.md` is one page and there is no existing codebase to
integrate with, so both arms do very little reading — and reading is the term we believe dominates
in real work. This task therefore measures the *writing and iteration* half well and the *reading*
half barely at all. A stronger version of this experiment starts from an existing multi-file
project and asks for a feature that must integrate with it. That is harder to arrange fairly,
because the two arms will read different things, and the asymmetry has to be disclosed rather than
removed.

## Task 2: the aggregation window

Task 1 is reused exactly as it stands: [`../contract-first/SPEC.md`](../contract-first/SPEC.md) and
[`../contract-first/tests/spec-conformance.test.cjs`](../contract-first/tests/spec-conformance.test.cjs).

Task 2 is new and exists so the arms can be counterbalanced, which the design below requires and which
one task cannot provide:

| artifact | file | sha256 |
| --- | --- | --- |
| specification | [`SPEC-2.md`](SPEC-2.md) | `f0598c8a5cff8a83…` |
| frozen judge | [`tests/spec-conformance-2.test.cjs`](tests/spec-conformance-2.test.cjs) | `91fe3a4352e54a7d…` |

A bounded sliding aggregation window: timestamped samples, a trailing time bound, a capacity bound that
discards oldest-first, aggregates that must survive discards, and four counters. It is deliberately not
the TTL cache again — the eviction discipline is a different one (capacity, not recency), so the second
task tests a different failure mode rather than a re-run of the first.

**Provenance, stated because it is a deviation.** `SPEC-2.md` and its judge were authored by a
*delegated local worker* on the architect's instruction, not by the architect directly — which is the
pattern working as designed, and also means the artifact carries the same provenance as any other
delegated unit in this repository. The architect reviewed both, and then had them verified
independently (below) rather than trusting the author's own report.

### The judge was verified in both directions before freezing

A suite that has only ever been watched passing is not evidence. `node --test` was run against a
reference implementation written from the specification, and then against six deliberate mutations of
it. Baseline **27/27 green**; every mutation red:

| mutation | caught by |
| --- | --- |
| evicts newest instead of oldest | "capacity discards the OLDEST sample and the aggregate excludes it" |
| never expires for age | "the boundary moment is expired, not retained (window is half-open)" |
| `windowMs` itself retained (`<=` for `<`) | "the boundary moment is expired, not retained" |
| observation mutates | "retainedCount is an observation and removes nothing" |
| zero-seeded min/max | "min and max survive negatives where a zero-seeded implementation would not" |
| capacity discard counted as age | "samples too old to remain are counted as expired, not evicted, even over capacity" |

The runner and the reference live in [`./.verifier/`](./.verifier/), **and the arms must not read that
directory.** It contains a complete solution to task 2; a run that read it would be measuring reading
comprehension of the answer. It is in the repository because the verification has to be re-runnable —
a one-off result in a log is not a gate — and it is in a fenced subdirectory rather than deleted for
exactly that reason.

Worth recording, because it is the failure mode this whole file is about: the first verification run
came back **green on six of seven rows**, and the green row was `windowMs itself retained`. The
mutation was never implemented — the verification script listed it, and the `isLive` helper it was
supposed to alter was written without it — so that row ran the *correct* implementation and reported,
accurately, that nothing was caught. A mutation harness that silently fails to mutate is a green gate
with nothing behind it. It was found by reading the mutation's own source, not the green line.

## The arm prompts

These are the two runs. They differ in **exactly one line** — whether `delegate_worker` may be used —
and that line is marked below. Everything else is byte-identical, including the spec text, the judge,
and the stopping rule. Paste one into a fresh session, run the judge, then
`node experiments/delegation-ab/measure-session.cjs <session>` and record the row.

**The stopping rule is part of the prompt**, not left to the operator's judgement: the run ends when
the judge is green, or when the operator stops it. An arm that keeps iterating against a passing judge
inflates its own token count, and an arm that stops short of green is void by the decision rule anyway.

**Before each run, `experiments/delegation-ab/src/` must be empty.** A run that begins with the other
arm's file in place is reading its opponent's answer. This is validity condition 2 and it is the one
most easily broken by accident.

### Arm D — delegated

    Implement the module specified in experiments/delegation-ab/SPEC-2.md.

    The specification is the whole requirement: read it and satisfy it. Do not read
    experiments/delegation-ab/.verifier/ -- it contains a solution to this task, and reading it would
    invalidate the run.

    The workspace is experiments/delegation-ab. Your implementation must be at
    experiments/delegation-ab/src/aggregation-window.js.

    You may use delegate_worker to have a local worker write the implementation. You are not to write
    the implementation yourself, and you are not to read it back except as the plugin's read policy
    permits.

    Acceptance: node --test tests/spec-conformance-2.test.cjs must pass, run from
    experiments/delegation-ab.

    Stop when the suite is green. If it is not green after your attempts, stop and report.

### Arm S — standard

    Implement the module specified in experiments/delegation-ab/SPEC-2.md.

    The specification is the whole requirement: read it and satisfy it. Do not read
    experiments/delegation-ab/.verifier/ -- it contains a solution to this task, and reading it would
    invalidate the run.

    The workspace is experiments/delegation-ab. Your implementation must be at
    experiments/delegation-ab/src/aggregation-window.js.

    You may not use delegate_worker. Write the implementation yourself, and iterate on it yourself,
    as many times as it takes.

    Acceptance: node --test tests/spec-conformance-2.test.cjs must pass, run from
    experiments/delegation-ab.

    Stop when the suite is green. If it is not green after your attempts, stop and report.

## Design

Two arms, four runs.

| | arm | what it may do |
| --- | --- | --- |
| D | **delegated** | the architect specifies and delegates; `delegate_worker` available; no source authored by the architect |
| S | **standard** | one model does everything — reads, writes, iterates — with `delegate_worker` not used |

**Two tasks, arms reversed between them**, to separate the pattern's effect from having seen the
task before. With one task each this is an anecdote; with two and reversed order it is weak
evidence, which is the strongest thing available at this size.

Four validity conditions, each of which has killed an experiment in this repository before:

1. **The judge is frozen before either arm runs.** Otherwise the delegated arm's own contract
   judges the delegated arm — the defect `docs/experiment.md` Finding 5 exists to record.
2. **Both arms start from the same state.** Reset between runs. If the standard arm's code is
   present when the delegated arm starts, the second run is reading the first run's answer.
3. **The standard arm is a good-faith attempt.** Same model, same spec, free to read and write
   whatever it wants, as many attempts as it needs. A weak standard arm is a rigged experiment and
   would be obvious to anyone reading it afterwards.
4. **The two arms differ in exactly one respect:** whether `delegate_worker` is used. Same task
   text, same repo state, same acceptance tests, same time budget.

## Metrics

**Primary: cumulative input tokens** — the sum of per-call prompt size across the run. That is the
metered cost.

Secondary: peak window fill, compactions, prunes, tokens reclaimed, number of calls, whether
`delegate_worker` was used, and whether the frozen judge passed.

### Correction: where the primary metric actually comes from

This section originally said the figure was "in the `CONTEXT_QUALITY` trace, per call". **It is not, and
it never was.** `context-quality.ts` folds session events into `lastPromptTokens` and
`peakPromptTokens` — two snapshots — and records no per-call figure at all, so the cumulative number
cannot be recovered from the trace by any amount of arithmetic. The claim was made against the module's
documentation rather than its code, and one `read` of `context-quality.ts` disproves it.

It is recovered from the **session transcript** instead: `~/.dsh/sessions/**/session.v3.jsonl.zstd`,
where every `assistant/message` carries the host's own usage record for that call. The file is a
concatenation of independent zstd frames — and `zlib.zstdDecompressSync` decodes only the *first* one,
returning the 201-byte session header and nothing else, which is exactly how a reader concludes the
transcript holds no usage data and gives up. Split on the zstd magic number and every frame decodes.

`measure-session.cjs` does this and prints the row the table below needs:

    node experiments/delegation-ab/measure-session.cjs <session-id-prefix>
    node experiments/delegation-ab/measure-session.cjs --list

The figure is reported **two ways**, because they are a different price and a different claim:
`inputTokens` is the uncached remainder, `cacheReadTokens` the cached prefix, and on a long session the
prefix is nearly all of the total. A single collapsed number would hide which one moved.

The architect side comes from the transcript; the local side from
`savings-ledger.json` — **two instruments, joined by hand**. Report them separately; do not present
a single combined figure as though one instrument produced it. Note also what the primary metric
contains and excludes: a delegated worker's inference happens in the plugin's own process, not as
session calls, so **the worker's tokens are absent from it by construction**. That is the comparison the
protocol wants — the worker is not metered — but it is the single largest way this experiment could be
read as flattering the pattern, so it is stated here rather than discovered later.

## Threats to validity, stated up front

- **n = 1 per task.** This can suggest; it cannot prove. Reporting it as proof would repeat the
  overreach this project has already had to correct.
- **The delegated arm's cost includes the architect's contracts.** It replaces code-output with
  spec-output — roughly 160k of prose against 200k of code across this project's history. Not free,
  just different, and this task excludes contract authoring entirely (above).
- **Reading differs in kind, not only amount.** A delegated architect prepares `contextFiles`, which
  requires knowing what to inject; a standard arm explores. The asymmetry cannot be removed, only
  disclosed.
- **Order.** Counterbalanced across the two tasks, not eliminated. Four runs from one person is not
  a controlled trial.
- **The operator is not blind.** The metrics are instrument readings, but the judgement about
  whether a run was in good faith cannot be automated.

## The decision rule

Written before the runs, so the result cannot be reinterpreted afterwards:

- **If cumulative input for the delegated arm is not materially lower**, the token half of the claim
  is **unsupported and should be withdrawn.** The pattern would then rest on removing the writing
  and the iteration from the architect's window — which this measures directly and which is a real
  effect regardless of the token total.
- **If it is materially lower**, report the ratio and the task, and say plainly that this is one
  task, one operator, two runs — a suggestive result, not a general one.
- **If the frozen judge fails for either arm**, that run is void and gets repeated. A run that
  produced code the judge rejects is not a cheaper way of producing the feature.

## Procedure

1. Copy `SPEC.md` and `tests/spec-conformance.test.cjs` nowhere — reference them in place, so both
   arms are provably judged by the same bytes.
2. `git stash`/checkout to a clean tree. Record the commit.
3. Run arm D on task 1, then reset. Run arm S on task 1. Then task 2 with the arms reversed.
4. After each run, record from the `CONTEXT_QUALITY` trace: cumulative input tokens, peak window
   fill, compactions, calls. Record the judge's pass/fail. Record the commit the run ended on.
5. Write the four rows here. State which arm was first for each task.

## Results

### Row 0: this project, already built

Measured before any arm runs, on the session that built this repository — a real delegated workload of
full size and full messiness. It is **not** one of the four runs and has **no standard-arm counterpart**,
so it cannot answer the question on its own. It is here because it is the largest piece of evidence that
exists, it was free, and because a prediction that survives contact with it is worth more than one that
has only met a toy task.

| metric | value |
| --- | --- |
| calls (architect) | 1,795 |
| **cumulative input tokens** | **666,756,560** |
| — uncached (`inputTokens`) | 2,101,968 |
| — cached (`cacheReadTokens`) | 664,654,592 |
| mean prompt per call | 371,452 |
| peak prompt | 791,798 |
| turns / steps | 122 / 1,795 |
| `delegate_worker` calls | 329 |
| compactions / prunes / reclaimed | 4 / 16 / 2,429,036 |
| elapsed | 26.4 h |
| session | `session-f0387683` |

Read honestly, this cuts against a naive form of the claim. Over a session that leaned on delegation
**329 times**, the architect still carried 666.8M input tokens, at a mean of ~371k per call, with a peak
of 791,798. A worker's 548k tokens from `savings-ledger.json` is **0.08%** of that. Whatever delegation
is buying here, it is not a small architect window.

The mean exceeds DeepSeek's advertised 128k context several times over, and that is not a contradiction
in the instrument: `inputTokens + cacheReadTokens` is the whole prompt *re-billed* on each call, cached
in large part at a lower rate. So the two figures under the total are not decoration — they are the
difference between "this cost 666M tokens" and "this carried a 666M-token prefix, most of it re-read at
the cache rate". Quote the pair or quote neither.

### The four runs

*(in progress — arm D on the aggregation window is complete; the remaining three rows are still to run)*

The arms are counterbalanced: **D runs first on the aggregation window, S runs first on the TTL cache.**
The "first arm" column is therefore the point of the table, not decoration.

This is a **deviation from the order written in the Procedure section**, which named the TTL cache as
task 1. Both tasks are architect-written specifications with judges frozen before any arm ran, so neither
result is contaminated by having been solved first *in this experiment* — but the TTL cache has been
implemented in this repository before, under `experiments/contract-first/`, and the aggregation window
had not been implemented anywhere until this run. Rather than accept that asymmetry inside a single task
pair, task 1 of the experiment is the newer task, and the counterbalance is preserved across the pair that
does exist. What matters for the decision rule is unchanged: for each task, one arm went first.

| task | first arm | arm | cumulative input tokens | uncached | peak window | calls | judge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aggregation window | D | D | 1,050,313 | 45,257 | 64,779 | 24 | 27/27 pass |
| aggregation window | D | S | — could not be run | — | — | 0 judge runs | not run |
| TTL cache | S | S | | | | | |
| TTL cache | S | D | | | | | |

### Run 2: arm S, task 2 — the control arm cannot exist under this instrument

**Arm S was blocked, and the thing that blocked it is the plugin being tested.**

The arm was a fresh subagent session, given the identical task text and the frozen judge, with
`delegate_worker` forbidden and sole authorship its job. It wrote a complete 166-line implementation —
and could not place it, because *every* route to a source file was refused:

| route attempted | result |
| --- | --- |
| `write` → `src/aggregation-window.js` | blocked by the local-only code guard |
| `write` → a `.js` probe in the workspace staging dir | blocked |
| `write` → a `.js` probe in the platform temp dir | blocked |
| `write` → a `.cjs` runner | blocked |
| `pwsh Set-Content` to a `.js` path | refused as naming a source file while carrying a write signal |
| `pwsh Copy-Item` `.txt` → `.js` | refused for the same reason |

The guard is global and extension-based, not path-scoped, and it refuses **reads** of `.js` paths as
well. The string it returns — `local-only code guard` — is `guard.ts:495`, in this plugin. The architect
of this experiment then confirmed it first-hand by attempting the same write and being refused with the
same message, which names the only remaining route: *"Delegate new files to the local worker with
`delegate_worker`."*

**This is not an accident of the harness; it is the plugin working as designed.** A cloud context in
this installation cannot author source. It can read, plan, and delegate — and nothing else. So a
"standard arm", meaning one model doing everything including the writing, **cannot be run here at all**.
One of the four cells of this design is not hard to fill; it is empty by construction.

The consequences are worth stating plainly, because they cut in two directions:

- **Against the claim:** the token comparison this experiment was built to make is now unrunnable. There
  is no control to compare the delegated arm against, so the primary metric has one column and the
  decision rule has nothing to decide. On this evidence the token claim is **not merely unsupported — it
  is untestable in the environment where the plugin runs**, which is a weaker position than "unproven".
- **For the claim, and more interesting:** the guard is not a limitation on the experiment, it is a
  measurement of it. The plugin does not merely *prefer* delegation; with the cloud context unable to
  write source, delegation is the **only** path to new code in a DSH session that has this plugin
  installed. That is a real and previously unrecorded property of the design — and it is exactly the
  property that makes a within-system control arm impossible. A plugin that forbids the alternative
  cannot be benchmarked against the alternative by its own instrument.
- **Scope of the honest statement:** this experiment can therefore speak to *what the delegated arm
  costs* and to *what the guard forbids*. It cannot speak to whether delegation is cheaper than the
  alternative, because the alternative is unavailable to be measured. Any comparison against a
  non-delegating DSH session requires running that session with the plugin **disabled**, which measures
  unimproved DSH rather than a within-plugin standard arm — a different claim, and one that should be
  labelled as such if it is ever made.

**Two other things from the arm, both worth keeping.** The implementation is staged at
`aggregation-window.js.pending.txt` (166 lines, 6,392 bytes) and was never executed: the arm hand-traced
it against the judge and said so rather than inventing a pass count, which is the correct behaviour and
worth recording. And it independently reached one genuine ambiguity, reported without being asked:

> `SPEC-2.md` says the clock is the only time source and that one reading is the current moment "for the
> whole of that method", but it does not say whether a sample's stored acceptance moment comes from
> *that* reading or from a later one.

The judge's own comment resolves it — *"all three are far inside a 50ms window measured from 5"* — so a
pinned clock must store the reading it took and sweep against the same one, giving age exactly 0. **A
correct implementation cannot fail that check, and an incorrect one cannot pass it**, since a single
`now()` reading stored and compared against itself is the only shape that satisfies it. So no test
change is needed. The finding is still real and belongs to the second task's specification rather than
its judge: the clause is underdetermined as written, and it was resolved by a judge comment rather than
by `SPEC-2.md`. The cheaper fix is one sentence in the spec, not a weaker test.

### Run 1: arm D, task 2 (aggregation window)

Session `be2bd1f5-6432-4e66-ac3e-cbb891c89d1b`, a fresh subagent session whose transcript records
`origin: subagent`, `delegationDepth: 1` and `parentSession` — so it is a fresh context, not a fork, and
its tokens are attributable to it alone. The architect was given `SPEC-2.md` and told to delegate.

| | |
| --- | --- |
| delegation calls | **1** |
| worker tokens | 10,966 (`promptTokensEst` 9,810 + `completionTokensEst` 1,156) |
| worker wall time | 12.97 s |
| file written | `src/aggregation-window.js`, 2,650 bytes, sha256 `136fa3315ba2a51d…` |
| registry mode | `created` |
| judge | 27 pass / 0 fail |

**The artifact is real, and I checked it rather than trusting the report.** The registry entry
(`mode: created`) carries the same sha256 the architect quoted, and the judge is not hollow: with the
file moved aside the suite yields **0 pass / 27 fail** and with it restored **27 pass / 0 fail**. A suite
that passes whether or not the module exists would prove nothing, so the seed-to-fail direction was run
as well as the green one.

**What this row costs the claim.** Producing one 2,650-byte file cost the architect **1,050,313 input
tokens across 24 calls** — a mean of 43,763 per call, peaking at 64,779 — while the worker that typed it
used 10,966. The archived worker's equivalent run (row 0 of the earlier data) spent 1.9M over 43 calls.
Nothing here looks like a smaller window; if anything the delegated arm paid full rate for the
specification, the judge, and its own orchestration, and the delegation removed only the typing.

That is **one run of one small task**, and it is not the comparison — arm S on the same task is. It is
recorded because it is the first measurement, and because a prediction that only meets its supporting
evidence is not being tested.

**A plugin behaviour worth recording, because it is not what the README implies.** The delegation
returned `VERIFICATION_NOT_APPROVED` with the text *"No verification command was supplied; the contract
is unchecked"* — approval for the command was refused, so nothing ran. The savings ledger then recorded
the unit as **`UNIT_FAILED`**. A unit whose tests were never executed is neither a pass nor a proven
failure, and `contracts.ts` says so in as many words: `UNIT_UNVERIFIED` "is the honest third answer".
The gate distinguishes the case (`VERIFICATION_NOT_APPROVED`, `delegation.ts:319`) and the outcome
collapses it (`delegation.ts:742`), so `success: false` lands in the ledger as a failure. The
downstream effect is user-visible: the read guard refuses to read the file back with the message *"the
unit that wrote it failed verification"*, which was untrue — it passed 27/27 and merely never got to
run the check. This run therefore also cost the architect the ability to read its own successful output,
which is why the plugin's own verdict here is `UNVERIFIED` while the artifact is green.

**Two guard false positives the architect hit**, reported by it first-hand and worth their own
investigation:

- A shell command containing any token that resolves to an **ancestor** of a delegated file — a bare
  `src`, or `C:\Projects` — matches every delegated file beneath it and is refused. Plain `Test-Path`,
  `Get-ChildItem` and `Get-Content` on the workspace were all rejected for this reason.
- A command combining a delete verb with a source-file reference anywhere on the same line is refused as
  "would delete source file X" even when the delete targets an unrelated temp file, and the guard named
  a file that was never at risk.

Both refusals are fail-closed, so nothing was harmed; the cost is that ordinary housekeeping commands
stop working once a delegation has landed. They are recorded as findings, not fixed here: the
experiment's own validity depends on the plugin being the same instrument across all four arms.
