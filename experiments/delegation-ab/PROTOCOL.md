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
metered cost. It is in the `CONTEXT_QUALITY` trace, per call, with a high-water mark.

Secondary: peak window fill, compactions, prunes, tokens reclaimed, number of calls, and whether
the frozen judge passed.

The architect side comes from `context-quality.ts` off `session/event`; the local side from
`savings-ledger.json` — **two instruments, joined by hand**. Report them separately; do not present
a single combined figure as though one instrument produced it.

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

*(empty — to be filled in by the runs, not before)*

| task | first arm | arm | cumulative input tokens | peak window | calls | judge |
| --- | --- | --- | --- | --- | --- | --- |
| TTL cache | | D | | | | |
| TTL cache | | S | | | | |
