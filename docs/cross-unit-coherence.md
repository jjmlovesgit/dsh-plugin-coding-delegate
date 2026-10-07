# Cross-unit coherence: the options

Scoping note, not a plan. `README.md` lists this as the one thing the loop does not close, and this file
is the decision material for closing it. Everything asserted here about the current code was measured
against it rather than recalled.

> **Status: B1, A1 and A2 are all built** (`coherenceVerification` + the `INCOHERENT` status,
> `evaluateUnitScope`, and `retry-context.ts` — see [`ROADMAP.md`](ROADMAP.md) Track 1b). The
> recommendation below is kept as written, because the reasons for the order are the useful part.
>
> One thing building B1 changed: `isSuccess` and "the unit passed" had to be separated. Folding coherence
> into `isSuccess` first made every broken tree report `VERIFICATION_FAILED`, pointing the architect at a
> unit that was fine. `resolveDelegateStatus` is given the *unit's* verdict, because `INCOHERENT` means
> exactly "the unit passed and the project did not" — so the status function has to be told which of the
> two failed. The oracle caught it.
>
> One thing building A2 changed: the tradeoff recorded under A2 below is too pessimistic about the
> architect. It says auto-injection "takes a decision away from the architect" — but the architect is
> handed metadata either way and never sees the code, so the only window that widens is the worker's.
> Nothing is taken from the architect that the delegation did not already withhold. What *is* taken away is
> the architect's chance to be asked, which is why the bounds listed there matter, and why A2 is reported
> in the verdict rather than applied silently.

## The problem, stated precisely

Two separate problems are hiding behind one phrase, and they need different answers.

**A. Which files does a unit need?** Today the architect declares `contextFiles` by hand, from its own
reading of the repository.

**B. Do two units agree?** Later units assume earlier ones, and nothing checks the assumption.

### What B actually looks like

Unit 1 changes `formatDate(d: Date)` to `formatDate(d: Date, tz: string)`. Its own contract passes — it
tests the function it changed. Unit 2, written from the architect's design rather than from the tree,
still calls `formatDate(d)`. Unit 2's contract passes too, because it tests the call site it wrote.

Both units are green. The project is broken. Every mechanism the plugin has today is *per unit*:
`contractFiles` hashes the tests judging one unit, verification runs one command, `UNVERIFIED` is about
one unit's evidence. There is no point at which anyone asks whether the tree still works.

## What already exists, and what it does not do

| Mechanism | Covers | Gap |
| --- | --- | --- |
| `contractFiles` + hashing | one unit's tests are the architect's and unmodified | says nothing about other units |
| `runVerification` | the command the architect supplied for *this* unit | usually scoped to this unit; nothing makes it project-wide |
| `emitAllowlist` + containment | a write stays inside the workspace | workspace-wide, not unit-wide |
| `targetFiles` | **prompt text and a fallback path-chooser only** | **not a boundary** — measured: it is read in `delegation.ts` as prose and in `emission.ts` only when a fenced block has no file header. A unit can write any file in the workspace |
| durable registry + `rememberDelegated` | what a worker wrote, with hashes and created/patched mode | recorded, never compared across units |
| `RedactedFailure.location` | `file:line` of a failed assertion | produced, then discarded |

The measured gap is the important one: **a unit's declared targets are advisory.** A unit told to change
`parser.ts` can rewrite `types.ts` instead, and nothing refuses it, reports it, or notices. That is the
mechanism by which units drift apart, and it happens *before* any coherence check could run.

## Options for B — do units agree

### B1. A project-level verification gate  ← recommended first

Let the architect declare a **second** command that must also pass: the project's own check (build, full
suite). The unit's contract judges the unit; this judges the tree.

- **Catches:** interface drift within a type-checked codebase, broken callers, integration failures,
  anything a later unit will trip over.
- **Cost:** a full suite per unit. Mitigable — run it only when the unit touched a file outside its
  declared targets, or only when the architect asks for it.
- **Why it is cheap to build:** the mechanism already exists. `runVerification` runs a subprocess,
  through the approval seam, with a timeout, redacted output and a raw log. A second invocation with a
  different command is a small change to `delegateWorker` and a status.
- **Fail-closed shape:** if the global command is supplied and does *not* pass, the unit is not a
  success — even though its own contract passed. That verdict is worth its own status (`INCOHERENT`),
  because "your unit is fine, the project is not" is a different instruction to the architect than
  "your unit failed".
- **Oracle-able:** the *policy* (when the global check is required, what a failed global check does to
  the verdict) is a pure function, like `resolveDelegateStatus`.

### B2. Re-run earlier units' contracts

Keep the contracts of completed units and re-run them after each new unit. Catches a later unit breaking
an earlier contract.

- **Catches:** the same class as B1, less completely.
- **Cost:** a ledger of contracts per session, plus their commands. More machinery than B1.
- **Verdict:** **subsumed by B1** in practice. A project-level suite already contains those contracts, and
  the architect can name a narrower command if the full suite is too slow. Not worth building separately.

### B3. Cross-unit conflict detection

Compare the set of files each unit wrote, and flag two units touching one file.

- **Catches:** little. Touching the same file twice is often correct — that is what iterating looks like.
- **Cost:** almost none; `filesWritten` and the registry already hold the data.
- **Verdict:** useful as *diagnostics in the summary*, not as a gate. As a gate it would be noise, and a
  check that cries wolf is worse than none.

### B4. Interface snapshot / diff

Hash each touched file's exported surface before and after, and flag changes to what other units depend on.

- **Catches:** exactly the drift B's example describes.
- **Cost:** high. Doing it properly needs a TypeScript parser; doing it with regexes would be a heuristic
  that is wrong in ways nobody can predict, which is the thing this project keeps having to apologise for.
- **Verdict:** **mostly unnecessary.** In a typed codebase `tsc` *is* the interface checker: a caller that
  still passes one argument fails the build. So B1 already catches most of what B4 would, using a tool
  that is exact instead of approximate. The residue B4 would add — interfaces checked at runtime, or in an
  untyped project — is real but small, and not worth a parser dependency here.

## Options for A — which files a unit needs

### A1. Make declared targets a boundary  ← recommended second

Refuse (or ask about) an emission to a path the unit did not declare.

- **Catches:** sprawl, which is the precondition for incoherence, *before* it lands.
- **Precedent in this codebase:** `contractFiles` already works exactly this way — declared, then
  enforced, then re-hashed. `emitAllowlist` already constrains by root. This constrains by declaration.
- **Tradeoff:** the architect must declare correctly or the unit fails. That is the intended direction —
  it fails closed and says so — but it is friction, and the honest mitigation is a mode: refuse by
  default, `ask` to allow with a prompt, or allow creating *new* files anywhere while requiring
  declaration to *modify* an existing one.
- **Interacts with B1:** a unit that stays in its lane produces a global failure that is diagnosable. A
  unit that sprawled produces a failure with no owner. A1 is what makes B1's signal usable.

### A2. Feed a failure's location back into the next attempt's context

`RedactedFailure.location` already carries `file:line`. On a failed unit, the next attempt's
`contextFiles` could include a window around those locations automatically.

- **Catches:** the under-declared context that made the worker guess — the ordinary cause of a unit that
  "failed for no visible reason".
- **Why this is unusually attractive here:** the plugin reads the file and puts it in the *worker's*
  prompt. The architect receives only metadata. So the loop can widen the worker's context *without
  widening the architect's window* — which is the entire thesis of the plugin, applied to its own failure
  path. `resolveContextFiles` already caps bytes and validates ranges, so the bounds exist.
- **Tradeoff:** auto-injection takes a decision away from the architect. Bounded by: only on a retry,
  only around reported locations, only within the existing byte budget, and reported in the verdict.

### A3. Give the worker a scoped read tool

- **Verdict:** rejected. That is the retired lead tier's problem in a smaller costume, and it walks into
  rule 3. The worker cannot discover; it can only be shown. A2 is the version of this idea that keeps the
  boundary.

## Recommendation

**B1 first, A1 second, A2 as the follow-on.** In that order, and each is small:

1. **B1** answers the question nobody is asking today, reuses the whole verification path, and needs one
   new status. It is the highest value per line of code in this document.
2. **A1** is what makes B1's failures attributable. Without it, a global failure after a sprawling unit
   tells the architect that something broke, not what.
3. **A2** is the recovery mechanism, and the only one here that improves the loop without touching either
   agent's boundaries.

The proposed first contract for B1:

- A `globalVerification` command, declared per delegation or in config.
- It runs after the unit's own verification, through the same approval seam and timeout.
- **If it fails, `success` is false**, even when the unit's own contract passed.
- The verdict reports both results separately, and names the status `INCOHERENT` rather than
  `VERIFICATION_FAILED`, because the architect's next action differs.
- If it is supplied but cannot run — denied spawn, refused approval — the unit is **not** a success.
- Oracle first, failing: a unit whose contract passes and whose global check fails must not report
  `SUCCESS`.

## What none of this solves

Worth stating, because the item's name promises more than any of these deliver.

- **Semantic disagreement that still compiles.** Two units can implement the same concept differently,
  both pass, and the build pass. `tsc` checks types, not intent. That remains the architect's judgement,
  and README already says so: the plugin enforces boundaries, it does not supply the judgement.
- **A unit that satisfies its contract while making the design worse.** A contract can be too weak. The
  plugin can prove the contract was met; it cannot prove the contract was right.
- **Anything outside the tested surface.** A build and a suite only cover what they cover.

So the honest claim after B1 + A1 + A2 would be: *the tree is known to still build and pass after every
unit, and every unit stayed inside what it declared.* That is a real improvement on "nothing checks", and
it is not the same as "the units agree".
