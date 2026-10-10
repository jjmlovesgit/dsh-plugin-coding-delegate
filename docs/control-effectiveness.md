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
object it captured did not contain the key.

**And it must go in the PROFILE PATCH, not `~/.dsh/config.json`.** The first attempt put it in `config.json`
and the hook did not register at all — no registration line **and** no warning, which is only possible if
the whole block was skipped because `options.sourceReadEgress` was undefined. Plugin options come from
`~/.dsh/profiles/<profile>/cordis.patch.yml`, under the `id: local-router` entry, which is where
`localProvider`, `guardAskPaths` and `coherenceVerification` already live.

**That error invalidates a conclusion recorded earlier in this file.** An experiment here concluded that
"DSH reloads plugin options without a restart", citing `verificationAllowlist` taking effect live as the
evidence. But `verificationAllowlist` was written to `config.json` too, so it was **never in effect either**
— the profile patch does not set it, and the ledger records **63 `UNIT_PASSED` units that ran without it**.
What actually made those verifications run was the **approval seam in a top-level session**: the option never
applied, and the prompt was approved in the one context that had an approver.

So the corrected statement is narrower than both earlier versions: **options are read once at registration,
from the profile patch, and a change needs a restart.** Two wrong conclusions came from testing in the wrong
file and reading the result as confirmation — which is the same failure as the false greens, one layer out:
a plausible result accepted because it was consistent with the belief being tested.

**And it is opt-in rather than default**, because changing what every read returns is not a decision to make
for the operator.

**Verified live, in a real session, on both paths.** The oracle tests the mechanism against fixtures; this
tests the hook inside a running DSH process — the distinction that had been missing for every boundary here.

| probe | what was asked | what happened |
| --- | --- | --- |
| **interception** | `read plugin/src/paths.ts` | received the declaration: `export declare function canonicalisePath(p: string): string` and the other two exports, **`declare`-only with zero bodies**, against a 44-line source containing a symlink-walking loop. The reply carried the banner naming the declaration file. |
| **staleness refusal** | `guard.ts` touched past its `.d.ts`, then read | **refused** — *"its type skeleton … is OLDER than the source, so it may describe a signature that has since changed. Rebuild the declarations … and read again."* No fallback to raw source, no obsolete types served. |

Each substitution is traced as `SOURCE_DECLARATION_SERVED` with `requested`, `served` and `bytes` (626 for
`paths.d.ts`), so the claim is checkable afterwards rather than inferred from the reply.

**One operational caveat from running it: `tsc` will not refresh a declaration whose source CONTENT is
unchanged.** Touching a source advances its mtime, and the next build leaves the stale `.d.ts` alone — so the
file stays refused until the declaration is deleted and re-emitted, or the source mtime restored. The check
is correct and the remedy is unintuitive, which is exactly what should be written down rather than
rediscovered during an incident.

### The policy is session-scoped, so turning it off is not a setting — it is a restart

`sourceReadEgress` is read once, at registration, from the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`). It is not re-read per call, and `~/.dsh/config.json` is not
the file it comes from. An operator who wants to read implementation bodies for one sitting has to stop the
process, edit the patch, and restart it; there is no way to widen egress only for the turn in front of them,
and no way to narrow it again without another restart.

**As shipped, the patch does not set `sourceReadEgress` at all.** The option, the declaration-serving hook and
its oracle are all present, but the live profile leaves the key unset, so the control is currently **off** and
raw source is served. Turning it on is an edit to that file plus a restart — which is the first item below.

That is a deliberate consequence of registration-time wiring rather than a missing feature, but it has an
operational shape worth stating plainly, because the failure it produces is quiet and lands on the operator:

- **The setting appears not to work.** Editing the patch in a running session changes nothing, and the plugin
  emits no warning that it is ignoring a file it never watched. The evidence is an unchanged behaviour, which
  is indistinguishable from a bug in the control. This is the exact false-green shape described at the end of
  this document — a result accepted because it matched the belief being tested.
- **"Just this once" is not an option.** The natural remedy for a refused read is to relax the control for the
  duration of one problem. Here the remedy costs a restart, so the realistic operator response is to leave the
  control off and stop noticing it — which is the failure mode that makes opt-in controls decay.
- **The correct habit is to decide the setting per session, not per read** — turn it on for architecture and
  delegation work, off for incident work — and to record which mode a session ran in if the run's egress
  behaviour is later disputed.

### The contracts the architect may write are the ones it cannot read back

Two rules are each defensible and combine into an asymmetry:

| rule | behaviour |
| --- | --- |
| rule 2, with the declared carve-out | a contract test under `tests/` is the one source-like file the architect may author — `contractWriteMode: 'allow'` returns `null` from the guard and the write proceeds |
| `sourceReadEgress: 'declarations'` | a read of that same file is refused, because no build will ever produce its `.d.ts` |

The second row is not a defect to fix but a consequence of the emit configuration: `tsconfig.json` sets
`rootDir: "./src"` and `include: ["src/**/*"]`, so a file under `tests/` is outside the emit root and
**the type skeleton does not exist by construction**. The read is refused for the ordinary reason — no
declaration — and the refusal message says so instead of repeating the old instruction to rebuild and retry,
which was a remediation loop with no exit for exactly the files most likely to be refused (see `1057885`).

So under `declarations` mode the architect can write its own specification and then cannot re-read it — and
even that only once the mode is switched on, since the shipped patch leaves egress off. Three
honest consequences:

1. **Read-back is not available as a check.** An architect that intends to verify its own contract by reading
   it afterwards has no path to do so: not through `read`, and not by re-reading after a rebuild. This is
   consistent with the architecture — the worker types the contract and the verification verdict, not the
   architect's review, is what settles the unit — but it removes a habit that a reviewer working from a local
   checkout would expect to have.
2. **It is a plan-time obligation, not a fix-up.** Contract content has to be right when written, because the
   only feedback loop is the worker's verdict on the next delegation rather than an immediate glance. Design
   the contract before authoring it, not after.
3. **The asymmetry is real but narrow.** Reading `src/` is unaffected — declarations exist there and are
   served, body-free. The gap applies only to files that are write-permitted *and* outside the emit root, and
   in this repository that intersection is precisely `tests/`. If test files ever move into `src/` (as
   `*.test.ts`), they would emit and become readable, so the predicate that distinguishes them — a path
   match on `tests?/` at `index.ts:1365` — is a convenience for message wording, not the thing enforcing
   containment.

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
| 1 | inverted ingestion | **enforced, opt-in, verified live on both paths**; generator is the existing `tsc` build | `egress-guard.test.cjs` + live probes |
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

## Open items on the promotion socket — BOTH CLOSED

Kept as a record of what was wrong rather than deleted, because the two items were found by *using* the
socket and both are the kind of thing a summary would have described as working.

**Multi-target ingestion — closed.** It took one `--path` per invocation, so gating a changeset was N shell
calls. It now accepts both `--path a --path b` and bare positionals, resolved against the repo root. The
trap that motivated resolving against the root rather than the cwd: a bare filename silently finds no record
and exits 1 — a false negative that reads exactly like a real failure. The value-taking flags (`--registry`,
`--repo`, `--path`) are excluded from positional collection explicitly, because `--registry <file>` would
otherwise push the registry path into the target list and the gate would try to judge its own registry.

**Explicit telemetry in the default output — closed.** On success the verifier printed only
`1 file(s) checked, 0 not settled`, with reasons appearing **only on failure**. A gate therefore could not
distinguish a machine pass from a human attestation — the precise distinction this verdict exists to draw —
without `--json`. It now prints per-target `SETTLED` / `NOT SETTLED` lines with their reasons and a summary
naming the counts by verdict:

```
4 target(s): 3 operator-attested, 1 unit-passed, 0 unsettled
```

The `--json` structure was **deliberately left unchanged** while doing this. The oracle reads
`results[0]`, so emitting a bare array — as the initial sketch for this change did — would have broken all
twelve fixture cases: a telemetry change silently invalidating the test that guards the socket.

## The distinction these two controls illustrate

`CODE_EXTENSIONS` refused a write to `scripts/check-promotion.cjs` because the filename ends in `.cjs`. It
had no idea the file was an audit artifact, and it would have refused a `.ps1` or a `.sql` identically. The
egress control above decides by whether the bytes contain executable bodies rather than declaration stubs,
which is a statement about the content and can be explained to the person it refuses.

**One rule can say why it fired and the other cannot, and that is the whole difference between a boundary
and a lookup table.** The practical consequence is that a heuristic's correct outcome is not evidence that
the heuristic is correct — the verifier was protected for a reason that had nothing to do with protecting
it.

## Current socket status: SETTLED

All four targets verified on the machine of record, exit 0 each, with the output distinguishing the two
kinds of claim:

| target | registry | verifier |
| --- | --- | --- |
| `plugin/src/guard.ts` | `OPERATOR_ATTESTED`, hash matches | **exit 0** — *attested by jim and unchanged since* |
| `plugin/src/contracts.ts` | `OPERATOR_ATTESTED`, hash matches | **exit 0** — *attested by jim and unchanged since* |
| `scripts/check-promotion.cjs` | `OPERATOR_ATTESTED`, hash matches | **exit 0** — *attested by jim and unchanged since* |
| `experiments/delegation-ab/src/aggregation-window.js` | `UNIT_PASSED`, hash matches | **exit 0** — *a unit passed it and its content is unchanged* |

The `OPERATOR_ATTESTED` branch in `judge()` exists, and
[`promotion-socket.oracle.mjs`](../plugin/tests/oracles/promotion-socket.oracle.mjs) covers all twelve
judgement cases — both promotable verdicts, both mutation cases, all four refusals, a record with no verdict
field, an absent registry, an unparseable registry, and newest-record-wins in both file orders.

### An attestation is not durable, and that is by design

Found while settling the socket, and worth knowing before anyone treats an attestation as permanent:
**`guard.ts` had its attestation silently replaced by later delegation activity.** A delegation writes a
fresh record for every file it touches, and newest-record-wins means the human verdict is superseded — the
record survived with its hash and mode but with **no `outcome` field at all**, which the socket then refused
as "no verdict".

That is the correct semantics rather than a defect: a verdict describes *content*, so a record that
outlives the bytes it described would be worse. But it means an attestation must be **re-established after
any delegation that touches the file**, and anyone treating one as a permanent certificate has the wrong
model. The alternative — letting a stale human claim outlive its content — is the failure this verdict
exists to prevent.

## Two containment layers, and neither of them is unconditional

Stated because a summary that says "the worker writes only within its declared boundary" reads as five
unconditional perimeters, and neither of these is one.

| layer | mechanism | invariant |
| --- | --- | --- |
| **workspace boundary** | `workspaceDir` + `emitAllowlist` roots | **policy-gated base, unconditional inside it** — the worker cannot write outside these roots on any dispatch, but a *caller-supplied* `workspaceDir` is trusted only when it is the session root or an allowlisted one; anything else prompts, and is refused when no approval service is reachable |
| **task unit scope** | `targetFiles`, with `unitScope: 'enforce'` by default | **conditional** — a write to a path the unit did not declare is refused, but **a unit that declares nothing is unrestricted across the workspace** |

The first was unconditional in the wrong sense for as long as it existed. Containment of the emitted
files was always sound: both sides are canonicalised, so a symlink or a `..` cannot escape the base. What
went unexamined is that the base was a **model-visible argument**, so naming a directory outside the
session workspace made every later check true by construction. That is the difference between a boundary
and a boundary the subject gets to place, and it is why the base is now decided by policy.

The second is an opt-in contract property, not a perimeter. The plugin's own documentation says so twice — in
`plugin/README.md` and in the `targetFiles` schema — and both say it plainly: *"Omit the field to leave the
unit unrestricted."* So the accurate claim is **contained to the chosen workspace unconditionally, and to the
declared unit scope when one was declared**, and nothing forces an architect to declare one.

That distinction is worth keeping in view for the same reason the others in this file are: a boundary count
is only meaningful if each item is the kind of boundary it claims to be. This row is the sixth claim in this
project found stronger than its mechanism, and the pattern that caught it is unchanged — reading the
artifact rather than the summary of it.

## Two gaps in the socket itself

**It cannot be wired into CI as a LIVE gate, and this is structural rather than a bug** — though its
*oracle* can be and is. The distinction is worth keeping straight, because the two are easy to conflate:

- **The oracle runs in CI.** `promotion-socket.oracle.mjs` builds its own registry fixtures, so it tests the
  judgement with no machine state at all, and `.github/workflows/ci.yml` runs it as its own step. That is
  what catches a verdict branch going missing.
- **The socket itself cannot.** It reads the registry at `~/.dsh/local-router/delegated-registry.json`,
  which is **per-machine and not in the repository** — so on a fresh CI runner there is no registry, it exits
  2 (unanswerable, correctly), and it would fail every build. The verdicts describe what one machine's worker
  did. The honest consequence: **this is a local promotion gate, not a CI gate.** Closing that would mean
  committing or publishing the registry, which turns a local evidence record into a shared one, and is a
  design decision nobody has made.

**`scripts/check-promotion.cjs` now has an oracle — and the reason given for its absence was wrong.** This
paragraph used to read "has no oracle", explained by a tidy story: the socket is `.cjs`, `CODE_EXTENSIONS`
contains `.cjs`, the write guard refuses source writes to a cloud context, therefore nobody could author the
test it needed. An earlier revision recorded that as unavoidable.

Two things about it were false, and checking cost one read.

1. **The oracle exists.** `plugin/tests/oracles/promotion-socket.oracle.mjs` tests `check-promotion.cjs` end to
   end, calling the real script through a child process with its own registry fixtures. It covers every
   verdict and both hash states — exactly what "it should have a test" asked for.
2. **A `.cjs` test under `tests/` was never refused.** The write guard short-circuits on the contract carve-out
   *before* the extension gate is reached, and `tests/` is the default `contractPaths` entry. Writing
   `tests/thing.test.cjs` with `contractWriteMode: 'allow'` returns `null` — permitted —
   `contract-write.test.cjs` asserts precisely that, and a direct probe of the built guard confirms it, along
   with the two states either side: the **default** mode returns `ask` rather than a refusal, and
   `contractWriteMode: 'deny'` returns `deny`. All three are the carve-out, not the extension. The extension
   in the story had nothing to do with it.

What the extension heuristic really refuses is `scripts/check-promotion.cjs` itself, because it sits outside
every contract path — the probe returns `deny` for it, identically to `lib/util.cjs`. That is arguably the
rule working: the production socket is source, and source is the worker's to write. **The rule did not block
the test; the explanation of why the test was absent was the thing that was wrong** — which is the same
failure as the four at the end of this document, arriving one more time. A plausible causal story was accepted
because it was consistent with the belief being tested, and it survived in two files at once: here, and in the
oracle header that repeats it.

**My first attempt to verify this reproduced the bug it was checking for.** The probe returned `PERMITTED` for
every case including `contractWriteMode: 'deny'`, which is impossible — a deny that permits means the probe
was measuring nothing. It had used the wrong argument field and the wrong module, so target extraction failed
and the guard returned `null` for all seven inputs. The tell was a result that could not be true, not a result
that looked wrong. Corrected, it discriminates across all three verdicts. That is the whole method: an
assertion and a probe that agree because both are inert is the failure mode this document is about, and it
recurred while the paragraph describing it was being written.

So the durable lesson is not "the heuristic blocked the audit artifact". It is that **a rule described in
prose is not evidence about what the rule does**, and this one had been described in two places without either
description being executed. `contract-write.test.cjs` is the evidence; the prose was not.

**What remains true is narrower, and it is the distinction above.** The oracle runs in CI; the socket does
not, because it needs the per-machine registry. The *judgement* is covered by fixtures — the operator's
registry still cannot be checked on a fresh runner, and that is the honest limit rather than a missing oracle.

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
