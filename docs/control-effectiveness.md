# Control effectiveness: the five-point design against what is actually enforced

An auditor's question is not "what does it do" but **"what is enforced, by what mechanism, demonstrated by
which test, and where is it only documented."** This file answers that for the five-point zero-trust
hybrid design. Every row is either tied to a runnable oracle or marked as unenforced.

States used below:

- **Enforced** — a mechanism refuses the thing, and a test demonstrates the refusal.
- **Enforced, with limits** — the mechanism works, and the row names where it stops.
- **Not enforced** — documented intent only. Nothing in this repository prevents it.

---

## 1. Inverted ingestion (boundary-only egress)

**State: NOT ENFORCED. Tooling gap.**

Nothing in this repository generates an AST skeleton, a symbol graph or a `declare`-only view of the
codebase. There is no Tree-sitter pass, no LSP query, no `tsc --declaration` step anywhere in the build or
the plugin. Boundary stripping therefore happens **entirely through prompt curation** — whatever the
architect happens to read or not read.

| | |
| --- | --- |
| mechanism | none |
| demonstrating test | none — there is nothing to test |
| what actually happens today | the architect reads whatever files it chooses, and `SOURCE_READ` *records* that choice without restricting it |

**What the trace actually carries, corrected.** An earlier revision of this row said `SOURCE_READ` records
path, range and hash. It does not. The record is
`{ role, agent, tool, target, extension }` — no byte count, no line range, no hash — and it fires only for
`CODE_EXTENSIONS`, so reads of markdown, JSON, logs and configuration are invisible to it. Byte sizes in
the measurement below are resolved from the file **on disk at analysis time**, which is faithful for files
unchanged since the read and wrong for files that have been edited.

**Measured, from telemetry rather than arranged** (`scripts/measure-reading-cost.cjs`, 136 records):

| | |
| --- | --- |
| architect read events | **124** |
| distinct files | **40** |
| **reads per file** | **3.1** |
| bytes, every read counted | 4,430,010 — **~1,107,503 tokens** |
| bytes, each file counted once | 668,294 — **~167,074 tokens** |
| hottest | `delegation.ts` **29×**, `index.ts` **22×**, `guard.ts` **15×** |

**The split is the finding, and it partly undercuts the skeleton argument.** A skeleton replaces the
*distinct* figure (~167k tokens) with something far smaller — that is the real prize, and it is exactly
what inverted ingestion would buy. But the *per-read* figure is an order of magnitude larger, and it is not
caused by the breadth of reading at all: **it is re-reading the same 40 files**, 3.1 times each. A skeleton
does not fix that. Three reads of a skeleton still cost three reads; only reading less often does. So
inverted ingestion attacks the smaller term, and reading hygiene — read late, read once, let the window die
between units — attacks the larger one.

**Measured reduction, so the ratio is a reading rather than a hope**
(`scripts/measure-skeleton-ratio.cjs`, over `plugin/src`):

| | bytes | ~tokens | ratio |
| --- | --- | --- | --- |
| source (17 files) | 272,647 | 68,162 | — |
| declarations | 82,028 | 20,507 | **0.301** |
| declarations, comments stripped | 34,942 | 8,736 | **0.128** |

**3–8× smaller, not the 1000× an earlier draft implied.** The spread between 3.3× and 7.8× is doc comments:
a declaration emit preserves them, and this repository documents heavily.

### Row 1 is missing an egress-side control, not just a generator

These are two separate gaps and only one of them is usually noticed.

**Generation** is absent: nothing produces the skeleton. That is the gap the ratio above addresses, and it
is ordinary tooling work.

**Enforcement now exists, opt-in, as `sourceReadEgress: 'declarations'`.** The guard inspects **write**
paths and previously constrained **read** paths not at all — the architect could name any file and
`SOURCE_READ` recorded the choice without limiting it. That is now closable at the same plugin, with one
correction to the obvious design: **it cannot be done at `tools/pre-execute`.** `PreToolDecision` is only
`allow | deny | ask`, and the host's own type comment says input rewriting *"is excluded because arguments
are already logged and presented"* — so "serve the declaration instead" is not representable there.
`tools/post-execute` accepts `{ kind: 'accept', content }`, which **replaces** the model-facing result, and
that is the only seam where the substitution is possible.

With the option on, a read of a source file is answered with its emitted `.d.ts` instead. It fails closed in
**two** ways, and the second one was added later because the first was not enough: a source file with **no**
declaration is refused, and a declaration **older than its source** is also refused
(`staleDeclarationReason`). Without the second, editing an interface and skipping the build served the
architect yesterday's signature — green for the same reason every false green in this repository has been
green, because nothing checked the thing that mattered, and no oracle could catch it since a test suite
always runs against a freshly built tree.

**mtime is evidence of a rebuild, not proof of a match.** A checkout, a `touch` or clock skew defeats it.
The honest label is *"the build is trusted, not verified"* — now with one mechanical assertion standing
between an operator and a stale contract, and not a content digest.

Each substitution is traced as `SOURCE_DECLARATION_SERVED` with the requested path, the served path and the
byte count, so the claim is checkable against the emitted tree rather than inferred from good behaviour.

| | |
| --- | --- |
| mechanism | `declarationPathFor` and `staleDeclarationReason` in `guard.ts`; a `tools/post-execute` hook in `index.ts` |
| option | `sourceReadEgress: 'declarations'` plus `declarationRoot`, both operator config |
| default | `'source'` — off, because it changes what the architect sees for every read |
| demonstrating test | [`egress-guard.test.cjs`](../plugin/tests/oracles/egress-guard.test.cjs) — mapping, pass-through of non-source reads, **staleness refusal**, and **no implementation statements in the served artifact** |

**Measured, not asserted:** the served declarations for `guard.ts`, `delegation.ts` and `emission.ts`
contain **zero** `for`/`while`, `if`/`switch`, and `fs.` calls, against 16, 80 and 2 in the sources. That is
the control's actual claim — not that a path resolves, but that bodies do not cross.

**What is still not automated: generation as a separate step.** In this repository it already exists —
`build` is `tsc`, `tsconfig.json` sets `"declaration": true`, so `plugin/dist` **is** the declarations tree
and all 17 source modules resolve. `sourceReadEgress` needs only `declarationRoot` pointed at `dist` after a
build. A repository that has no such step must add one, and the option fails closed when a mapping misses
rather than falling back.

**One operational limit, found by testing it rather than reasoning about it: this option is read at plugin
REGISTRATION, so it needs a server restart.** A live test with `sourceReadEgress` added to the running
plugin's config served raw source and registered no hook, because `apply()` had already run and the config
object it captured did not contain the key. An earlier measurement in this repository concluded that DSH
"reloads plugin options without a restart" — that is true for options consulted **per dispatch**, like
`verificationAllowlist`, and false for options that gate **registration**, which is what this one is. The
distinction was not written down at the time and cost a wasted live test; it is here now.

**And it is opt-in rather than default**, because changing what every read returns is not a decision to make
for the operator.

**This is the largest gap in the design and the one with the most upside.** It is also not a plugin
problem: the plugin cannot strip what has already entered the window. Closing it means a preprocessor that
runs before the architect sees anything, and a measurement of the skeleton-to-source ratio on a real
corpus — which has not been done, and which is why any order-of-magnitude token claim in this area is
currently unsupported.

## 2. Spec-driven downward delegation

**State: ENFORCED.**

| | |
| --- | --- |
| mechanism | `evaluateCodeWriteGuard` at `tools/pre-execute`; `contractFiles` hashing; `targetFiles` / `emitAllowlist` containment |
| demonstrating tests | [`control-bypass.test.cjs`](../plugin/tests/oracles/control-bypass.test.cjs), [`contract-integrity.test.cjs`](../plugin/tests/oracles/contract-integrity.test.cjs), [`unit-scope.test.cjs`](../plugin/tests/oracles/unit-scope.test.cjs), [`edit-boundary.test.cjs`](../plugin/tests/oracles/edit-boundary.test.cjs) |
| measured | 15 authoring routes, of which **4 are refused outright and 11 held for approval**; 6 spellings of one path all caught; with no approval service, none reached source |

The control's scope is stated rather than implied: it covers **this plugin's write paths**. Source a model
produces in conversation, through a second tool path, or through another plugin is invisible to it.

## 3. On-box verification and sanitized receipts

**State: ENFORCED.**

| | |
| --- | --- |
| mechanism | `runVerification` executes as a local subprocess; output redaction; the architect receives pass/fail counts, file names and hashes only |
| demonstrating tests | [`redaction.test.cjs`](../plugin/tests/oracles/redaction.test.cjs), [`coherence.test.cjs`](../plugin/tests/oracles/coherence.test.cjs), [`registry-verdict.test.cjs`](../plugin/tests/oracles/registry-verdict.test.cjs) |
| measured | one delegated unit, **0 architect judge runs**, 27/27 first attempt, and the trajectory contains **no read of the module** |

Two limits, both measured rather than assumed:

- **The verification command is approval-gated**, and the gate is operator configuration. Where no approval
  seam exists, verification is refused and the architect falls back to running the judge itself — which cost
  **179,840 tokens** on the loop plus **440,500** around it in the run where that happened.
- **DSH pins a delegated child's `approvalPolicy` to `'never'`**, so a unit cannot verify itself from inside
  a subagent. Self-verifying delegations need a top-level session.

## 4. Flakiness containment

**State: ENFORCED, WITH LIMITS.**

| | |
| --- | --- |
| mechanism | `verificationRepeats` (default **3**, cap 20) with short-circuit consensus; the fourth verdict `UNIT_FLAKY` (commit `fdb1327`); `evaluateSettledFile` refuses to settle a flaky file |
| demonstrating tests | [`flaky-verdict.test.cjs`](../plugin/tests/oracles/flaky-verdict.test.cjs) — 10 checks, including the full state transition table |
| measured transitions | `PASS PASS PASS` → `UNIT_PASSED` (3 runs); `FAIL FAIL FAIL` → `UNIT_FAILED` (3 runs); `PASS FAIL` and `FAIL PASS` → `UNIT_FLAKY` (2 runs); a late flip caught on run 3 |

**The limit, stated plainly: this blocks registry settlement, not git promotion.** A flaky verdict means the
file cannot be read back as verified and is not citable as verified work. Whether that blocks a *commit* or
a *merge* depends entirely on the downstream harness reading the verdict. Nothing in this plugin
intercepts `git commit`, and if a pipeline promotes on green CI rather than on a delegation verdict, a
`UNIT_FLAKY` result is invisible to it.

**The socket now exists** — [`scripts/check-promotion.cjs`](../scripts/check-promotion.cjs) — and it is a
separate program on purpose, because settling a file is the plugin's job and refusing a commit is the
repository's:

```
node scripts/check-promotion.cjs --changed            # pre-commit: nothing changed since its verdict
node scripts/check-promotion.cjs --path src/thing.ts  # one file
node scripts/check-promotion.cjs --all                # everything registered
```

Exit **0** = every file asked about is settled. **1** = at least one is not. **2** = the question could not
be answered, because "I could not check" and "it is fine" must never share an exit code.

**It recomputes the hash rather than looking up the verdict**, which is what makes it useful in a hook: a
file that passed and was then edited is not the version anything verified, so the recorded sha256 is
compared against the current content. Verified against the live registry — a file whose content matches a
`UNIT_PASSED` record exits 0; a file with no record exits 1; a file edited after its verdict exits 1 with
that reason; and with no registry readable at all it exits 2 rather than passing.

**Two limits its users need.** It records files a **delegated worker** wrote, so a file written by the
architect or a human is reported unknown rather than passing — a repository gating on this is gating on
delegated work being verified, not on all work. And `--changed` falls back to checking *every* registered
path when it cannot diff against HEAD, because for a gate, failing closed means checking more than asked
and never waving a commit through.

**The short-circuit rule matters and the first implementation got it wrong.** Exiting as soon as a run
failed would report a race that lost twice as `UNIT_FAILED` — a deterministic regression — masking the
non-determinism instead of exposing it. Only disagreement short-circuits, because it is the single outcome
that running more cannot change. `FAIL` means "failed every time we looked".

## 5. Protocol models for architectural deadlock

**State: DESIGN ONLY. Not enforced, and not currently buildable here.**

| | |
| --- | --- |
| mechanism | none |
| demonstrating test | none |
| what exists | a documented escalation pattern in [`verification-architecture.md`](verification-architecture.md) — feed the architect an abstracted protocol model (states, transitions, assumptions) instead of either function body, so an emergent coupling can be reasoned about without source crossing |

Generating a finite-state model of cross-module behaviour is a research-grade static analysis problem.
**The ingest side is trivial; the generation side is the entire difficulty**, and it is not implemented.
Until it is, this row describes what a human should do when a deadlock occurs, not what the software does.

---

## Summary

| # | control | state | test |
| --- | --- | --- | --- |
| 1 | inverted ingestion | **enforced, opt-in, needs a restart**; generator is the existing `tsc` build | `egress-guard.test.cjs` |
| 2 | downward delegation | enforced | `control-bypass.test.cjs` + 3 others |
| 3 | on-box verification, sanitized receipts | enforced, with limits | `redaction` / `coherence` / `registry-verdict` |
| 4 | flakiness containment | enforced, with limits | `flaky-verdict.test.cjs` |
| 5 | protocol models | design only | none |

**Row 1 moved.** It was two gaps, and only one was usually noticed: no generator, and no egress control. The
egress half is now enforced — the mechanical read filter that makes "the architect reads declarations" a
property of the path rather than a promise. The generator turns out to be the build this repository already
runs, though whether it is *sufficient* generation is untested: `declare` output preserves doc comments, and
whether an architect can author a satisfiable contract from it alone is Run 2, which has not been run.

**One row of five is unenforced: protocol models**, and the reason is unchanged — generating a finite-state
model of cross-module behaviour is research-grade static analysis, and the ingest side being easy is what
makes that gap easy to underestimate.

355 oracle checks and 39 unit tests back the enforced rows.

## Open items on the promotion socket

Both found by using it, neither yet built. Recorded here rather than only in a commit message, because a
commit message is not a backlog.

**Multi-target ingestion.** `scripts/check-promotion.cjs` takes one `--path` per invocation, so gating a
changeset is N shell calls, which is not how a pre-commit hook wants to work. It should accept several
paths, or read a git change-list. Worth noting the trap found while writing this: a bare positional
filename is resolved against the current directory, so `--path aggregation-window.js` silently finds no
record and exits 1 — a false negative that reads exactly like a real failure.

**Explicit verification telemetry in the default output.** On success the verifier prints only
`1 file(s) checked, 0 not settled`, and reason strings appear **only on failure**. So a gate cannot
distinguish a machine pass from a human attestation in its output, which is the precise distinction this
verdict exists to draw. `--json` does expose it — `"attested by jim and unchanged since"` versus
`"a unit passed it and its content is unchanged"` — but requiring a flag for the audit-relevant fact is
backwards. A one-line summary naming the counts by verdict would fix it, and silence-on-success (Unix-style)
can stay the default for hook use.

## The distinction these two controls illustrate

`CODE_EXTENSIONS` refused a write to `scripts/check-promotion.cjs` because the filename ends in `.cjs`. It
had no idea the file was an audit artifact, and it would have refused a `.ps1` or a `.sql` identically. The
egress control above decides by whether the bytes contain executable bodies rather than declaration stubs,
which is a statement about the content and can be explained to the person it refuses.

**One rule can say why it fired and the other cannot, and that is the whole difference between a boundary
and a lookup table.** The practical consequence is that a heuristic's correct outcome is not evidence that
the heuristic is correct — the verifier was protected for a reason that had nothing to do with protecting
it.

## Current socket status: one patch from settled, NOT all-green

Stated here because a status summary that reads "done" would send a maintainer to run the verifier, get
four non-zero exits, and have no way to tell which layer was wrong.

| target | registry | verifier today | why |
| --- | --- | --- | --- |
| `experiments/delegation-ab/src/aggregation-window.js` | `UNIT_PASSED` | **exit 0** | the branch it needs exists |
| `plugin/src/contracts.ts` | `OPERATOR_ATTESTED`, hash matches | **exit 1** | no `OPERATOR_ATTESTED` branch in `judge()` |
| `plugin/src/guard.ts` | `OPERATOR_ATTESTED`, hash matches | **exit 1** | same |
| `scripts/check-promotion.cjs` | `UNIT_UNVERIFIED` | **exit 1** | needs the patch, then re-attestation |

The attestations are correct and persisted. `scripts/check-promotion.cjs` **lags the registry model by three
lines**, and it falls through to *"the registry holds no verdict for it"* rather than disagreeing with the
attestation. That file cannot be patched from a cloud context: `.cjs` is in `CODE_EXTENSIONS`, so the write
guard refuses it as source.

## Two containment layers, and only one of them is unconditional

Stated because a summary that says "the worker writes only within its declared boundary" reads as five
unconditional perimeters, and the unit boundary is not one of them.

| layer | mechanism | invariant |
| --- | --- | --- |
| **workspace boundary** | `workspaceDir` + `emitAllowlist` roots | **unconditional** — the worker cannot write outside these roots, on any dispatch |
| **task unit scope** | `targetFiles`, with `unitScope: 'enforce'` by default | **conditional** — a write to a path the unit did not declare is refused, but **a unit that declares nothing is unrestricted across the workspace** |

The second is an opt-in contract property, not a perimeter. The plugin's own documentation says so twice — in
`plugin/README.md` and in the `targetFiles` schema — and both say it plainly: *"Omit the field to leave the
unit unrestricted."* So the accurate claim is **contained to the workspace unconditionally, and to the
declared unit scope when one was declared**, and nothing forces an architect to declare one.

That distinction is worth keeping in view for the same reason the others in this file are: a boundary count
is only meaningful if each item is the kind of boundary it claims to be. This row is the sixth claim in this
project found stronger than its mechanism, and the pattern that caught it is unchanged — reading the
artifact rather than the summary of it.

## The question that found every defect here


**"What would this look like if it were checking nothing?"**

Asked of each result that came back green, it exposed four false greens in one session, none of which any
test suite caught on its own:

1. **A mutation harness that never mutated.** The verification script listed a `boundary-inclusive` mutation
   and the reference implementation was written without it, so that row ran the *correct* code and reported,
   accurately, that nothing was caught.
2. **A test whose setup threw before reaching an assertion.** The rule-3 checks registered delegated files
   with `rememberDelegated` and assumed that was enough — but the plugin seeds its path set from the
   persisted registry inside `apply()`, so the predicate was driven with an empty set and returned "not
   gated" for everything, including vectors the real listener blocks.
3. **A short-circuit that hid non-determinism.** `FAIL FAIL FAIL` exited after two agreeing failures, so a
   race that lost twice in a row was reported as a deterministic regression — masking the exact thing
   `UNIT_FLAKY` exists to expose.
4. **An attestation that returned a success record while the disk write threw.** `saveDelegatedRegistry`
   returns a boolean rather than throwing; the caller ignored it, and the first attestation printed a hash
   and an operator while the registry was untouched.

The common shape: **each harness checked for the absence of a crash rather than the presence of a
cryptographic invariant.** A green result is evidence about the code only in proportion to what the check
would have done had the code been wrong — and in all four cases the answer was "nothing different."

The four are fixed and pinned. The question is the durable part.
