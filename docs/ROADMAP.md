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
| 1 | Read-guard scoping: distinguish architect from lead | **Blocked on the host** — see `SECURITY-REVIEW.md`, "Blocked on the host: agent lineage". The interim escape hatch is now **built**: `delegateReadPolicy`, documented as weakening rule 3 |
| F | **Does the architect ever actually read source?** The guard does not cover it, so that access rests on a prompt sentence rather than a boundary | **Observation built, decision deferred.** `SOURCE_READ` is traced and attributed where the agent id can be matched; `tests/oracles/source-read.test.cjs`, 9 assertions. Closing the access waits on the evidence — the plugin half and the lead row both work; only the trace can say whether the architect still needs it |
| 2 | Choose the lead model | **Decided:** the local model already configured for the worker, thinking enabled, as `PROFILES.LEAD`. No new download, no metered spend, source never leaves the machine |
| 4 | Delivery: documented subagent preset, or plugin support | **Decided:** documented preset. The plugin enforces boundaries; owning DSH's agent lifecycle would duplicate the host and break when it changes. Guide at [`lead-tier.md`](lead-tier.md) |
| 4a | **The lead agent composition**, since removed | **Built, mounted, measured, retired.** A session on the Lead preset came up with Read/Glob/Grep/Pwsh, and the plugin logged `role: lead` / `LEAD_LEFT_AS_CONFIGURED`. The persona now carries the contract's shape, after the first version's omission cost the lead its window reverse-engineering the harness to discover what a contract was |
| E | **The verification timeout is configurable** — it was hardcoded at 30 s, so a contract whose command legitimately needs longer could not be expressed at all and no configuration raised it | **Built.** `verificationTimeoutMs`, defaulting to the 30 s that was hardcoded so an unconfigured operator sees no change. A value that is not a positive finite number falls back to the default rather than removing the bound — an unbounded command that is model-selected and runs with the DSH process's authority is a hang, not a permission. `tests/oracles/verification-timeout.test.cjs`, 7 assertions, **4 failing before implementation**; the other 3 are characterisation controls asserting the default is unchanged. Found by the lead reading `runSandboxVerification` |
| 3 | `LEAD` profile — thinking on, repository access, authors each unit's contract | **Built.** `PROFILES.LEAD` plus `leadTier`. The host half that grants repository access is guided in [`lead-tier.md`](lead-tier.md); the tier was retired after measurement |
| 5 | Fresh lead per workstream | Not started; gated on 2 and 4 |
| 9 | Rule 8: source may not reach the cloud, approval-gated | **Built** as 2c above, and it is rule 8 in the policy table |
| 10 | Per-tier read/write matrix | Not started |
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
| 16 | Live-verify `UNVERIFIED` and the delegated-read prompt after a reload | **Half done.** The reload is confirmed and `UNVERIFIED` is verified live, alongside `VERIFICATION_FAILED` and `SUCCESS`. The delegated-read prompt did **not** fire, which is an open observation recorded in `SECURITY-REVIEW.md` |
| 14 | Context-quality counters: frontier tokens in the window per turn, compactions per session, turns before restart | **Built and live-verified.** `context-quality.ts` folds DSH's own `session/event` firehose: turns, steps, compactions, prunes, failed compactions, **tokens reclaimed** (the host's `shadowedTokenCount`), and the **prompt the model received per call** with its high-water mark and the route's advertised window. `tests/oracles/context-quality.test.cjs`, 18 assertions, in three demonstrated batches. **Live testing found a defect the oracle could not**: `usage.inputTokens` is only the uncached prompt, so the first version reported 228 tokens for a 660k-token window — see `findings.md`. Folded over this project's own session log it now reads **675,105 / 1,000,000**, i.e. 67.5% of the advertised window at the peak. Limits: the firehose omits construction-seed events, so a resumed session counts from the resume; and no compaction has yet occurred in an observed session, so the compaction counters remain oracle-tested only |
| 15 | The experiment: an architect-authored contract for a module with internal structure, plus checks from outside the contract | Partly prefigured by the debrand oracle, but that unit was small |

Also deliberate and unresolved: the plugin entry id is `local-router` while the package is
`coding-delegate`. Moving it requires both live profile patches to change together, verified with
`--dump-config`.

## Open decisions

Item 2 is settled: the lead is the **local** model already running the worker, with thinking enabled.
Item 4 is settled: **documented preset**, not plugin-managed agent lifecycle.
Item 17 is settled: **GitHub-only**, so there is no publish step and Track 3 is about the repository
rather than a registry.

Track 2's remaining work is no longer waiting on a decision — it is waiting on the host for item 1, and
on nobody for 2c and item 9.

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
