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

**Enforcement is also absent, and this is the more important half.** The code guard inspects **write** paths
— `tools/pre-execute` on writes and shell commands. It does not constrain **read** paths at all: the
architect may name any file it likes, and `SOURCE_READ` records the choice without limiting it. So even with
a generator built, nothing would route a read of `src/foo.ts` to `types/foo.d.ts`. Inverted ingestion would
be a **convention the architect is asked to follow**, which is precisely the policy-versus-control
distinction this whole file is about.

A mechanical version is available and is the stronger design: a **read-redirect filter** at the same
`tools/pre-execute` seam that already refuses writes — a read of a source path is served the declaration
instead, or refused with the declaration offered in its place. Two properties follow, and they are the ones
a governance reviewer asks for:

- **Source cannot leave because of the shape of the egress, not because the model chose not to ask for it.**
  What crosses is whatever the extractor emits, and nothing else.
- **It is auditable.** "The architect read 124 files" becomes "the architect read these declarations", which
  is checkable against the emitted tree rather than inferred from good behaviour.

Until that exists, row 1 stays **not enforced**, and the privacy perimeter for the implementation remains a
boundary of the *delegation loop* only — the delegated unit's code never comes back, which is real and
measured, while the rest of the repository remains readable at will.

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
| 1 | inverted ingestion | **not enforced** | none |
| 2 | downward delegation | enforced | `control-bypass.test.cjs` + 3 others |
| 3 | on-box verification, sanitized receipts | enforced, with limits | `redaction` / `coherence` / `registry-verdict` |
| 4 | flakiness containment | enforced, with limits | `flaky-verdict.test.cjs` |
| 5 | protocol models | design only | none |

**Two of five are unenforced, and both are the ones that address the architect's reading.** That is not a
coincidence: the reading is where the design's cost and exposure actually live, and it is the part no code
here touches. Rows 2–4 govern what happens *after* the architect has already read whatever it read.

352 oracle checks and 39 unit tests back the enforced rows. Neither unenforced row has a test, which is the
point of writing this file rather than a feature list.
