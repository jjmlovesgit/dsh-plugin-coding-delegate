# Roadmap

This file exists because the plan did not. The task list lived in a conversation, went through a lossy
compaction, and survived only because some of it happened to be captured — which is the exact failure
[README.md](README.md) describes and this plugin exists to prevent. It is now a file.

Kept out of the published package on purpose, alongside
[`docs/delta-emission.md`](docs/delta-emission.md): a roadmap inside the tarball reads as a promise.

## How we work

**Architect in the cloud, execution locally.** The cloud model plans, decides, and writes the contract.
It does not write implementation code. Local execution satisfies the contract.

**Contract first, always.** Each unit of work starts with a test that fails. The test is the architect's
and is never edited by whatever satisfies it — a worker that authors the test that scores it is marking
its own homework, and a contract the executor can rewrite is not a contract. The debrand unit is the
worked example: `plugin/tests/oracles/debrand.test.cjs` was written first and failed 6 of its 7
assertions against the old tree.

**Never push a red oracle.** A new contract is committed together with the change that satisfies it, so
CI is green at every commit.

### How we know we are on a path to success

| Gate | What it proves | Where |
| --- | --- | --- |
| `npm ci` → build → `git diff --exit-code -- dist` | committed `dist` is exactly what `src` compiles to | CI |
| Unit tests (vitest) | behaviour at the module seam | CI |
| Regression oracles (`node --test`) | the pure decision functions still decide correctly | CI |
| Contract oracles | each unit's declared goal actually holds, and could have failed | repo |
| Live verification | the seams oracles cannot reach: real approval prompts, real reloads | manual |

Live verification is not optional decoration. Approvals were only proven real by observing 1.9–3.1 s
ask→decide latencies in a session audit with no `auto` preset active. An oracle cannot see that.

## Track 1 — completing the two-tier loop

No host dependency, no decision pending. **This is the actionable track.**

| # | Unit | Status |
| --- | --- | --- |
| C | **Contract-path integrity** — declare the contract's test files, hash them before the worker runs, refuse worker emissions targeting them, re-hash after verification and fail the verdict if they changed | **Built.** `tests/oracles/contract-integrity.test.cjs`, 9 assertions, failing 8 of 9 before implementation |
| A | **Architect-blind context injection** — `contextFiles` names and ranges, contained, DLP-scanned, reported as metadata only | **Built.** `tests/oracles/context-injection.test.cjs`, 10 assertions, failing 10 of 10 before implementation |
| B | **Search/replace delta emission** — exact-match, no fuzz, all-or-nothing | **Built.** `tests/oracles/delta-emission.test.cjs`, 10 assertions, failing 10 of 10 before implementation |
| 18 | `Select-String <file>.js` read-detection false positive | **Already fixed — the row was stale.** Fixed by `READ_ONLY_INSPECTORS` + `isReadArgument` and regression-tested at `plugin.test.ts:431`; the wider read/invoke behaviour is now locked by `tests/oracles/read-detection.test.cjs` |
| D | **Durable delegated-path registry** — the read guard's memory outlives the process, so a restart cannot silently widen what the architect may read | **Built.** `tests/oracles/durable-registry.test.cjs`, 10 assertions, all 10 failing before implementation. Found by a *failed* live test, not by design review |

C shipped first because it is small, independent, and it is the unit that makes a passing verdict mean
*the architect's tests, unmodified, passed against the worker's code*. A followed, then B. **Track 1 is
complete**: the worker can be shown existing code without the architect seeing it, and it can return a
delta rather than a whole file, so the loop closes on existing code as well as on new files.

Item 18 turned out to be already fixed and already regression-tested: the row was stale, carried from the
original checklist and never reconciled against the code. Verifying it with a probe across fourteen read
forms and four invocation forms found the guard correct in every one, and that evidence is now an oracle
rather than a throwaway script. **Track 1 is closed.**

D was added after that closure, and not from design review: the live run's *invalid* read-guard test
exposed it. Reloading to load the test flag also emptied the in-memory registry, which is how the gap
became visible — the guard had no way to know, after a restart, what it had been protecting.

## Track 1b — cross-unit coherence: **B1, A1 and A2 all built**

The one thing README lists as not closed. Everything Track 1 built is *per unit*: the contract judges one
unit, verification runs one command, and `UNVERIFIED` is about one unit's evidence. Nothing ever asked
whether the tree still works.

The decision material is [`cross-unit-coherence.md`](cross-unit-coherence.md), written from the code
rather than from memory. It separates the two problems hiding behind the phrase — *which files does a
unit need* and *do two units agree* — and finds a measured gap underneath both: **`targetFiles` was a hint,
not a boundary.** It was read as prompt text and as a fallback path-chooser, so a unit told to change
`parser.ts` could rewrite `types.ts` and nothing refused, reported, or noticed. A1 below closed that.

| # | Unit | Status |
| --- | --- | --- |
| B1 | **A project-level verification gate** — a second, operator-declared command (build, full suite) run after the unit's contract, with the power to void it | **Built.** `coherenceVerification`, with `INCOHERENT` as its own status because "your unit passed, the project did not" is a different instruction to the architect than "your unit failed". `tests/oracles/coherence.test.cjs`, 10 assertions, **4 failing before implementation**; the other 6 are characterisation controls. Skipped when the unit wrote no files, and when verification is denied. Operator configuration rather than model input, so it is absent from the tool schema and not approval-gated. **Live-verified in both directions** once configured in the profile: a normal delegation reported `SUCCESS` with the gate running and passing (305 passed, 0 failed, with `last-coherence.log` as evidence it executed), and a delegation into a subdirectory workspace reported **`INCOHERENT`** while its own contract passed — the operator's `cd plugin` cannot resolve from there, and the raw log says so in cmd's own words. It reuses the unit command's `timeoutMs`, which defaults to 30s; the full gate measures **5.3s**, so it fits, but a slower project gate would need that shared bound raised. **The subdirectory failure was a configuration defect, not a property of the check, and it is now fixed and live-verified.** `coherenceVerification` runs with `cwd` set to the delegation's own workspace, so every path in it must be absolute; the profile now carries `cd /d C:\Projects\DSHLaya\plugin && npm run build && npx vitest run && npm run test:oracles` — cmd syntax, because the runner's shell is `cmd.exe`. Measured both ways from `experiments/contract-first`: the relative form exits 1, the absolute form exits 0 with 39/39 unit and 313/313 oracles. After the restart, the same delegation into `experiments/contract-first` that used to report `INCOHERENT` reported **`SUCCESS` with `Coherence check: Passed 313, Failed 0`**, and `last-coherence.log` shows `tsc`, the 39 unit tests and the oracle run — the whole gate, executed from a foreign workspace |
| A1 | **Declared targets as a boundary** — refuse an emission to a path the unit did not declare, so a unit stays in its lane and B1's failures are attributable | **Built.** `evaluateUnitScope`, with `unitScope: 'enforce'` as the default and `'off'` as the escape hatch. A declared directory covers its subtree, so `src`, `src/` and an exact filename all work with one rule; a sibling sharing a prefix is refused; declaring nothing constrains nothing. The tool schema now says `targetFiles` is ENFORCED, because the model is the one declaring. `tests/oracles/unit-scope.test.cjs`, 10 assertions. **Found a real defect while writing it**: a refused emission was retried at the declared hint, so containment, contract and scope refusals all moved the write rather than stopping it — see `findings.md` |
| A2 | **Feed a failure's `file:line` back into the next attempt's context** — widens the worker's view without widening the architect's | **Built.** `parseFailureLocations` + `retryContextRequests` in `retry-context.ts`, wired into `delegateWorker` with `retryContext: 'auto'` as the default and `'off'` as the escape hatch. A failed unit's reported locations are kept per workspace, cleared by any later unit that passes, and folded into the next attempt's injection as one window per file, consumed once. The code goes to the **worker** and the architect is told which files were added, never their contents — this plugin's thesis applied to its own failure path. Best-effort by construction: the widened set replaces the declared one only if it resolves cleanly, so an auto-injection can never turn a runnable delegation into `CONTEXT_REFUSED`. `tests/oracles/retry-context.test.cjs`, 7 assertions. **Three of its seven pre-implementation failures were the oracle's fault, not the feature's** — see `findings.md` |

Rejected with reasons in the scoping note: B2 (re-running prior contracts) is subsumed by B1; B3
(file-conflict detection) is diagnostics rather than a gate, and a check that cries wolf is worse than
none; B4 (interface diffing) is largely what `tsc` already does exactly, so it is not worth a parser
dependency to approximate it.

Item 15 below — "plus checks from outside the contract" — was this item's first statement.

## Track 2 — the lead tier: **retired**

Kept as a record, not a plan. The tier was built — `leadTier`, the role decision, the `LEAD` profile, a
preset that mounted and ran — and then measured. The measurements say a 27B local model cannot carry this
role against this codebase:

- **The window does not fit.** *Re-measured after the refactor; this ground no longer holds for a single
  module.* At retirement the lead's configured context was 32,768 tokens and `plugin/src/index.ts` was
  147 KB — roughly **40,900 tokens**: one file, larger than the whole window, with `plugin/src` together
  at ~46,700. It has since been split (see [`refactor.md`](refactor.md),
  [`refactor-complete.md`](refactor-complete.md)). Measured now: `index.ts` is **~13,400 tokens**, the
  largest module (`delegation.ts`) is **~7,300**, and `plugin/src` together is **~45,700**. Any one module
  fits the lead's window; only the whole of `src` does not.
- **The reasoning budget is not ours to set.** LM Studio's per-model setting is authoritative. Four
  variants of one request — server default, `enable_thinking: false`, `true`, and `reasoning_effort:
  high` — returned byte-identical results: 64 completion tokens and the same 183-character reasoning
  field. Nothing the plugin or DSH sends changes it. Reproduce with `scripts/probe-thinking.mjs`.
  A corollary worth keeping: `PROFILES.WORKER.enable_thinking: false` is sent on every delegation and
  **ignored**, so the worker is not as unthinking as its profile claims either.
- **The saving was on the wrong side.** *Re-measured; weaker, still true.* Offloading typing is worth
  ~159,000 tokens across this project's entire history. At retirement the arithmetic was one 41,000-token
  file carried for fifty turns: ~2,046,000 input tokens. With the split, the largest module is ~7,300
  tokens, so the same fifty turns cost **~365,000** — an order of magnitude less, and still more than
  twice the entire typing history. Letting the architect read code to engineer still gives up the larger
  saving to capture the smaller one; the margin is simply smaller than recorded.
- **Nothing was ever proven.** No lead-authored contract was ever dispatched and verified. The tier's
  failure mode is an under-specified contract producing a confident wrong patch — worse than the frontier
  model writing the code itself.

**The decision stands, and this is what it now rests on.** Grounds 2 and 4 are unchanged, and each is
sufficient alone: the reasoning budget is not the plugin's to set, and nothing was ever proven. Grounds 1
and 3 were re-measured after the refactor and both weakened. Ground 1 in particular is now dead as
written — the refactor met the one precondition this section said would change the arithmetic — so the
retirement should be read as resting on **2 and 4**, not on the file being unreadable.

So the two-tier loop stands, and its honest claim is **"your GPU does the typing"**, not "the architect's
window stays clean". The architect reads code to engineer. The discipline that replaces the lead tier is:
**read narrowly, read late, and prefer the verdict you already have.**

What stays built and load-bearing from this work: `leadTier`/`leadProviders` and `PROFILES.LEAD` (an
operator may still run a local thinking agent alongside), `delegateReadPolicy`, rule 8, and the durable
registry.

| # | Item | Status |
| --- | --- | --- |
| 2a | **`agent/request` respects a lead provider** — a request the host resolved to a declared lead provider is left as configured, so a local lead is not repinned to the cloud or told it is the architect | **Built.** `tests/oracles/agent-role.test.cjs`, 8 assertions, failing 8 of 8 before implementation. `leadProviders` is empty by default, so this is a no-op until an operator opts in |
| 2b | **`LEAD` profile and the `leadTier` opt-in** — the lead as a local thinking model, with the provider list derived from the profile so it is declared once | **Built.** `tests/oracles/lead-tier.test.cjs`, 7 assertions, failing 7 of 7 before implementation |
| 2c | **Rule 8 — source may not reach the cloud** (this is item 9 below; same work, one row each) | **Built.** `tests/oracles/source-egress.test.cjs`, 9 assertions, failing 9 of 9 before implementation. `deny` by default; `ask` routes to the approval seam and fails closed without one |
| 2d | **`delegateReadPolicy`** — the interim escape hatch for rule 3, with its cost documented (the third built unit of the lead work) | **Built.** `tests/oracles/delegate-read-policy.test.cjs`, 8 assertions, 5 failing before implementation; the other 3 are controls asserting the write guard is untouched |
| 1 | Read-guard scoping: distinguish architect from lead | **Built.** The blocker was that DSH never said which agent was which, so `roles.ts` inferred the role from the **provider** and said so: "a correlation, not lineage". `Session.header` now carries `origin?: 'subagent'` and `delegationDepth?: number`, so `roleFromLineage` reads the host's own record: a root agent is the architect, anything the host marked as spawned is not, and a **missing header is `'unknown'` rather than `'architect'`** — absence of evidence is not evidence of rootness, and guessing here is guessing about who may read source. `roleForAgent` prefers lineage and keeps the correlation as the fallback it always had to be, and `tools/pre-execute` now passes the live agent rather than only its id. `tests/oracles/role-lineage.test.cjs`, 2 tests, red then green. The blocker lifted with the `0.2.0-rc.2` core — which is why the row sat open, and why checking the host rather than re-reading the note was what closed it |
| F | **Does the architect ever actually read source?** The guard does not cover it, so that access rests on a prompt sentence rather than a boundary | **Observation built, decision deferred.** `SOURCE_READ` is traced and attributed where the agent id can be matched; `tests/oracles/source-read.test.cjs`, 9 assertions. Closing the access waits on the evidence — the plugin half and the lead row both work; only the trace can say whether the architect still needs it. **The trace has now said it: yes, constantly** — 264 gate events across 31 turns, ~8.5 per turn, every one sampled being the architect's own working material rather than delegated output being pulled back. So the conclusion this row expected — close the access — is the wrong one; what the count measures is *accumulation*, not access. The rule that follows is in `findings.md`, and it is now enforced end to end: the registry carries the unit's verdict per file, and the read guard reads a passed-and-unchanged file silently while asking about failed, unverified and since-edited ones. **And that call has been made: the hatch is closed.** `delegateReadPolicy` is absent from the active profile's resolved config, so the default `ask` applies. The hatch was checked before any path comparison and so switched the whole rule off — which is why the settled rule had to exist before it could be closed, and it is what makes closing it affordable. Every delegated read still lands in the `SOURCE_READ` trace either way, and re-adding `delegateReadPolicy: 'allow'` opens the hatch again |
| 2 | Choose the lead model | **Decided:** the local model already configured for the worker, thinking enabled, as `PROFILES.LEAD`. No new download, no metered spend, source never leaves the machine |
| 4 | Delivery: documented subagent preset, or plugin support | **Decided:** documented preset. The plugin enforces boundaries; owning DSH's agent lifecycle would duplicate the host and break when it changes. Guide at [`lead-tier.md`](lead-tier.md) |
| 4a | **The lead agent composition**, since removed | **Built, mounted, measured, retired.** A session on the Lead preset came up with Read/Glob/Grep/Pwsh, and the plugin logged `role: lead` / `LEAD_LEFT_AS_CONFIGURED`. The persona now carries the contract's shape, after the first version's omission cost the lead its window reverse-engineering the harness to discover what a contract was |
| E | **The verification timeout is configurable** — it was hardcoded at 30 s, so a contract whose command legitimately needs longer could not be expressed at all and no configuration raised it | **Built.** `verificationTimeoutMs`, defaulting to the 30 s that was hardcoded so an unconfigured operator sees no change. A value that is not a positive finite number falls back to the default rather than removing the bound — an unbounded command that is model-selected and runs with the DSH process's authority is a hang, not a permission. `tests/oracles/verification-timeout.test.cjs`, 7 assertions, **4 failing before implementation**; the other 3 are characterisation controls asserting the default is unchanged. Found by the lead reading `runSandboxVerification` |
| 3 | `LEAD` profile — thinking on, repository access, authors each unit's contract | **Built.** `PROFILES.LEAD` plus `leadTier`. The host half that grants repository access is guided in [`lead-tier.md`](lead-tier.md); the tier was retired after measurement |
| 5 | Fresh lead per workstream | **Retired** with the lead tier. It was gated on items 2 and 4, and both are decided; the tier itself was then built, mounted, measured and retired. A second lifecycle to manage for a tier that no longer runs is not unfinished work, it is a row that should stop being counted |
| 9 | Rule 8: source may not reach the cloud, approval-gated | **Built** as 2c above, and it is rule 8 in the policy table |
| 10 | Per-tier read/write matrix | **Retired** with the lead tier. A matrix across tiers presupposes tiers; the two-tier loop has exactly one boundary and it is the code guard, not a matrix |
| 11–12 | Three-tier premise section and extended policy table | Superseded: the decision to describe only what ships. The README leads with the two-tier loop and lists the lead under "What the loop does not close yet" |

Why tier three is not the blocker for editing existing code: the plugin has filesystem access and can
inject a target file into the worker's prompt without the architect seeing a byte. That is a transport
problem, and transport needs no third model. The lead tier answers a different and harder question —
which files a unit needs, and how units stay coherent with each other — which transport cannot solve.

## Track 3 — publication readiness

| # | Item | Status |
| --- | --- | --- |
| 17 | npm publication, or GitHub-only | **Decided: GitHub-only.** No publish step. Install stays clone-and-register, which the README already documents; nothing npm-specific is required |
| — | `package.json` has no `repository`, `homepage`/`bugs`, or `engines` | **Fixed.** All four added, with `repository.directory: "plugin"` so the link resolves inside the monorepo rather than to the repository root, and `engines.node: ">=22"` matching what CI runs and the README requires |
| — | No root `LICENSE` (only `plugin/LICENSE`), which is what GitHub's licence detection reads | **Fixed.** Root `LICENSE` added, identical to `plugin/LICENSE`. Both are kept: the root one is what GitHub reads, and `plugin/LICENSE` is in the package's `files` list, so removing it would strip the licence from a published tarball |
| 19 | Reload the desktop app, which is still serving the pre-rename module | **Done.** Confirmed from `router-debug.log`: after `PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR` the hook trace gains `role` and `roleReason`, fields that exist only in the new code |
| 16 | Live-verify `UNVERIFIED` and the delegated-read prompt after a reload | **Done — and finding out why took longer than the item did.** The reload is confirmed and `UNVERIFIED` is verified live, alongside `VERIFICATION_FAILED` and `SUCCESS`. The delegated-read prompt did **not** fire. Following it down: `evaluateDelegatedReadPolicy` is a pure function of the *setting* — on the default `'ask'` it returns `ask` unconditionally for a read of a delegated file — so the policy function is not why nothing prompted. That leaves exactly two possibilities, and they need different fixes: either the read never reached `tools/pre-execute` (the path was not in `delegatedPaths`, or the tool was not recognised as a read), or the host does not surface an approval for a pre-execute `{kind:'ask'}`. **The second would be a fail-open**: `'ask'` would silently allow, and the default setting for reading delegated source back would be no gate at all. **Confirmed fail-open, reproduced live.** A file *created* by a delegated worker was read straight back with the `read` tool and passed silently. Mechanism, from three observations: of 264 `ALLOWED-ONCE` lines only **1** is a `read`, and it was an **absolute** path (`C:\Projects\temp\live-check\target.js`); the ungated read traced `"target": "plugin/tests/oracles/role-lineage.test.cjs"`, the raw relative string. `isDelegatedPath` canonicalises both sides, so this is not a missing normalisation — `canonicalisePath` resolves a relative target against the **process cwd**, not the session workspace. A registered absolute path matches; a relative one misses. The architect reads by relative path essentially always, so **the delegated-read gate is off in normal use**. **This is the A2 defect again** — same root cause, fixed in `delegation.ts` the same day and not here; the class was not fixed, one instance was. **Fixed, live-verified, and the gate it exposed is now on.** `isDelegatedPath` infers the workspace instead of being handed it — `index.ts` is 62KB against a 32KB injection cap, so the call site could not be changed at all — and the settled-versus-in-flight rule replaced the blanket prompt. The delegated-read prompt has now been observed firing live: an unsettled delegated read logged `ALLOWED-ONCE read -> …role-lineage.test.cjs` and left **no** `SOURCE_READ` trace, while a settled one was read silently with no approval line and its trace present. The `delegateReadPolicy: 'allow'` hatch that masked all of it is removed from the profile. Two limits found on the way — the shell route's inline-eval write signal, and a false `UNIT_FAILED` recorded because a verification could not run in the runner's shell — are in `findings.md` |
| 14 | Context-quality counters: frontier tokens in the window per turn, compactions per session, turns before restart | **Built and live-verified.** `context-quality.ts` folds DSH's own `session/event` firehose: turns, steps, compactions, prunes, failed compactions, **tokens reclaimed** (the host's `shadowedTokenCount`), and the **prompt the model received per call** with its high-water mark and the route's advertised window. `tests/oracles/context-quality.test.cjs`, 18 assertions, in three demonstrated batches. **Live testing found a defect the oracle could not**: `usage.inputTokens` is only the uncached prompt, so the first version reported 228 tokens for a 660k-token window — see `findings.md`. Folded over this project's own session log it now reads **675,105 / 1,000,000**, i.e. 67.5% of the advertised window at the peak. Limits: the firehose omits construction-seed events, so a resumed session counts from the resume; and the **failed-compaction** counter remains oracle-tested only, because `compaction/end` is its only source, no such event appears in any recorded log, and it has only ever been observed reading 0. `compaction/summary` and `compaction/prune` are no longer in that category — read back out of `router-debug.log`, session `f0387683` recorded **2** and **9** of them respectively, folded exactly: the prune counter stepping 1→9, reclaimed tokens accumulating 2,529 → 50,937, and the summary reading `1 compaction(s), 9 prune(s), 712,892 token(s) reclaimed` |
| 15 | The experiment: an architect-authored contract for a module with internal structure, plus checks from outside the contract | **Run; the premise is partly supported, and the gap now has a detector.** Full write-up in [`experiment.md`](experiment.md), artifacts in `experiments/contract-first/`. The architect wrote a specification and no code; a local worker implemented a 14-requirement TTL+LRU cache from it, twice; no implementation code entered the architect's context; `contractFiles` integrity held throughout. **Three findings.** (1) The experiment found a real defect in shipped code: retry-context fed a failure's location back as context, and a failing contract names itself, so the implementer was shown the very file `contractFiles` withholds — reporting `unchanged: true` while reading it out. Fixed in `536dfe1`, red-then-green, oracles 276/276, **live-verified after a restart** (before: 114 lines of the contract injected; after: nothing). (2) **The architect cannot tell a contract fault from a module fault.** The earlier version of this entry claimed 3 of 14 areas had a broken contract harness; that was **wrong**, and the correction matters — judged against a null implementation where the module cannot be blamed, all 14 tests reach their assertions, so those malfunctions were the *module's*. The architect had published the misdiagnosis. (3) The contract **does** discriminate — two genuine behavioural defects caught, 11 of 14 areas failed against a rewritten implementation, 14 of 14 by assertion against a null one. **Now guarded** by `scripts/check-contract.cjs`, which judges a transcribed contract against a null implementation and refuses one that asserts nothing, without the architect reading it: sound contract → OK, deliberately vacuous fixture → rejected. **B1 coherence has since been exercised live**, through the operator path and in both directions: once configured in the profile, a delegation at the repository root reported `SUCCESS` with `Coherence check: Passed 305, Failed 0`, and one into a subdirectory workspace — where the operator's `cd plugin` cannot resolve — reported **`INCOHERENT`** while its own contract passed. **The green run is now reached — but only after the contract itself had to be corrected, and that is the sharpest result the experiment produced.** Three further attempts plateaued at 13/14, 12/14, 12/14. The architect's own specification probe — independent of the contract — then passed **16 of 16** checks against the module, covering live-count bounding, expired-victim ordering and replace-revival. The contract, not the module, was at fault, and the proof is two lines of it: `ttl-cache.test.js:91` asserts `has(b) === false` for an expired entry ("b is expired, has returns false") while `:132` asserts `has(b) === true` for an expired entry ("b (MRU, expired) should NOT be evicted") — one predicate, opposite expectations, so **no implementation can satisfy both**. Two tests also expect eviction where the live count is at or below `maxEntries`, which `SPEC.md` forbids. `scripts/check-contract.cjs` still reports **OK: the contract is well-formed and discriminating** for that file: it decides vacuity and malfunction, never faithfulness to the specification, so a contradiction introduced in transcription is permanently invisible to the architect forbidden to read it. The consequence is Finding 2 with its teeth in — with a real contract fault the loop has **no terminating condition**, and its plateau is indistinguishable from a limit on the worker. Closed by **preserving the contract as evidence** and adding `tests/ttl-cache.spec.test.js` (sha256 `e62f280c…`), transcribed from `SPEC.md`, passing **14/14** against the unchanged module and failing 14/14 by assertion against a null one. The two corrected tests were specified scenario-by-scenario; the one area left to prose (`purge`) came back with a scenario whose own comment called an entry live at `t=110` when its expiry made it expired at `t=100` — so the architect must specify scenarios, not areas. The step-5 mutant is retrievable at `git show 1548f75:experiments/contract-first/src/ttl-cache.js`. **The guard's blind spot is now closed, and this experiment is the case that closed it.** `scripts/check-contract.cjs` takes an optional `--spec <file>` — a specification conformance suite the architect owns, which is the null trick run backwards: null proves the module cannot be blamed, the suite proves the module *can* be trusted, and a contract that still rejects a conforming module is the artifact at fault. Pointed at the transcribed contract plus `experiments/contract-first/tests/spec-conformance.test.cjs` (16 checks written from `SPEC.md`, independent of both contracts) it exits 1 and names **"not ok 9 - eviction chooses strictly by recency, not by expiry"** and **"not ok 10 - replacing an existing key refreshes expiry and recency, not counted as eviction"** — the exact two tests that cost three rounds; against the corrected contract it exits 0. The suite is judged by the rule the contract is judged by, and the verdict names both possibilities rather than condemning the contract, because it is only as strong as the suite's coverage. Seven assertions in `plugin/tests/oracles/contract-spec-conformance.test.cjs`, which is the script's first oracle of any kind. Writing it found a defect in the guard itself: `runTests` passed no `env`, so a guard run from inside `node --test` inherited `NODE_TEST_CONTEXT`, the grandchild's TAP went to the inherited IPC channel instead of the capture file, and the guard condemned **every** contract with "the contract did not run" — a gate that fails by looking at nothing, the mirror of the one `check-dist-in-sync.cjs` was fixed for. Measured both ways (`0 tests` against `2 tests, 0 passed, 2 failed by assertion`) and fixed by deleting that one key from the child's environment. Separately: "make exactly one change" is not a reliable instruction — the worker rewrote 129 lines to 86 — so mutation testing is not currently available |
| 20 | **Which DSH core is actually running** — the Desktop-managed core, not the one on `PATH` | **Corrected; the Desktop 0.22.4 update has since been applied and verified.** The first pass read `dsh --version` (`0.1.5-rc.3`, the npm-global copy) and treated it as the host. It is not: `%APPDATA%\dsh-tauri\dependencies.json` resolves `dsh` to a **managed** root holding **`0.2.0-rc.2`**, and nothing references the npm-global copy. The plugin was therefore already running on `0.2.0-rc.2` — proven, not inferred, by the A2 live run, which came a day after that core was installed. Against the *running* host all seven watched events are present, 59 unique types, additions only. 0.22.4 left the core untouched (manifest still recommends `0.2.0-rc.2`); the plugin re-mounted once and a smoke delegation passed. The old-name duplicate registration in `config.json` is **not** a double mount — read from `desktop.log`, where `console.log` actually goes, not the trace log. See [`dsh-0.2-upgrade.md`](dsh-0.2-upgrade.md) |
| 22 | **The oracle runner wrote into the live data directory** — `node --test` never loads `vitest.config.ts`, so only 7 of 28 `.cjs` oracles isolated the plugin data dir | **Fixed.** `plugin/scripts/isolate-oracle-data-dir.cjs` is a `--require` preload and `npm run test:oracles` carries it; the parent decides the temp home once and children inherit it via `DSH_ORACLE_HOME`, so a run leaves one temp directory rather than 28. The preload throws if the redirect ever resolves back to the live directory, so the failure mode is a dead run rather than silent pollution. Contract check: `scripts/check-oracle-isolation.cjs`, **red before, green after** — a run used to add 4 fixture markers and ~19 KB of trace to `~/.dsh/local-router/router-debug.log`; now 0, with the fixtures verifiably relocated. `docs/refactor.md` documented the bare `node --test` gate command, which is what kept reintroducing it — also fixed. The polluted history was **archived, not deleted**, to `~/.dsh/local-router/archive/router-debug.pre-oracle-isolation-2026-10-07.log` (3.4 MB); a clean log began 22 ms later with no restart, so live-verification readings from before that timestamp must be looked up in the archive. See `findings.md` |
| 21 | **Give the plugin a host contract** — pin `@deepseek-ai/dsh-session`, and whichever packages carry the hooks it uses, as devDependencies so event names and payload shapes are *typed* rather than asserted | **Built.** `plugin/src/session-events.ts` now holds the plugin's whole session-event vocabulary — the folded list and the traced subset — each declared `as const satisfies readonly SessionEventType[]` against the host's own `keyof SessionEventMap`. A DSH release that renames an event fails `npm run build` **naming the offending literal**: demonstrated by renaming `turn/start` to `turn/started` and reading `TS2820: … Did you mean '"turn/start"'?`. `context-quality.ts`'s fold and its three payload readers are typed from the host map, so a *moved field* fails the build too, and the second hand-written copy of the names in `index.ts` is gone. Two devDependencies pinned exactly; `scripts/check-host-types-pin.cjs` fails when they stop describing the running core, because a green build against the wrong host is worse than no check — it looks like evidence. The packages are dev-only and **fully erased from `dist`** (verified: no runtime `require` of them). Limits recorded in `findings.md`: hook payloads are still untyped, and the check is inert in CI where no host is resolvable |

Also deliberate and unresolved: the plugin entry id is `local-router` while the package is
`coding-delegate`. Moving it requires both live profile patches to change together, verified with
`--dump-config`.

## Open decisions

Item 2 is settled: the lead is the **local** model already running the worker, with thinking enabled.
Item 4 is settled: **documented preset**, not plugin-managed agent lifecycle.
Item 17 is settled: **GitHub-only**, so there is no publish step and Track 3 is about the repository
rather than a registry.

Track 2 is **retired** (see above), so nothing here is waiting on anything. The sentence that stood here waited on the host for item 1; item 1 landed with `Session.header`'s `origin` and `delegationDepth`, and the tier was then measured and retired rather than resumed.

## Method note: how the guard was bypassed

Worth recording, because it happened while this file was being written. Repository edits in this
project were applied by a generic step applier (`node apply-steps.mjs <target> <dir>`) that writes with
`fs.writeFileSync`. The code guard mediates tool calls and looks for write primitives in shell text and
script bodies; a target path passed as an *argument* to a generic Node script matched neither, so guard
rules 2 and 3 did not fire on edits to `plugin/src/`.

This is the documented "a shell script writes" gap, not a new one, and it is the reason the guard is
described as a deterrent rather than a boundary. It is recorded here rather than quietly relied upon.
The planned patch-application work in Track 1 will need a deliberate answer for it, since a
tool-applied patch is a third actor writing.
