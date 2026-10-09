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

Closing that needs a promotion socket, not more plugin: either the pipeline reads
`delegated-registry.json`, or the plugin emits a machine-readable promotion token. A DSH plugin reaching
into git hooks is the wrong layer.

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
