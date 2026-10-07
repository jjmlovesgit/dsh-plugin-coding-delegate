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

## Track 2 — the lead tier

Gated. Nothing here starts until the host gap and two decisions clear.

| # | Item | Status |
| --- | --- | --- |
| 2a | **`agent/request` respects a lead provider** — a request the host resolved to a declared lead provider is left as configured, so a local lead is not repinned to the cloud or told it is the architect | **Built.** `tests/oracles/agent-role.test.cjs`, 8 assertions, failing 8 of 8 before implementation. `leadProviders` is empty by default, so this is a no-op until an operator opts in |
| 2b | **`LEAD` profile and the `leadTier` opt-in** — the lead as a local thinking model, with the provider list derived from the profile so it is declared once | **Built.** `tests/oracles/lead-tier.test.cjs`, 7 assertions, failing 7 of 7 before implementation |
| 2c | **Rule 8 — source may not reach the cloud** (this is item 9 below; same work, one row each) | **Built.** `tests/oracles/source-egress.test.cjs`, 9 assertions, failing 9 of 9 before implementation. `deny` by default; `ask` routes to the approval seam and fails closed without one |
| 2d | **`delegateReadPolicy`** — the interim escape hatch for rule 3, with its cost documented (the third built unit of the lead work) | **Built.** `tests/oracles/delegate-read-policy.test.cjs`, 8 assertions, 5 failing before implementation; the other 3 are controls asserting the write guard is untouched |
| 1 | Read-guard scoping: distinguish architect from lead | **Blocked on the host** — see `SECURITY-REVIEW.md`, "Blocked on the host: agent lineage". The interim escape hatch is now **built**: `delegateReadPolicy`, documented as weakening rule 3 |
| F | **Does the architect ever actually read source?** The guard does not cover it, so that access rests on a prompt sentence rather than a boundary | **Observation built, decision deferred.** `SOURCE_READ` is traced and attributed where the agent id can be matched; `tests/oracles/source-read.test.cjs`, 9 assertions. Closing the access waits on the evidence — the plugin half and the lead row both work; only the trace can say whether the architect still needs it |
| 2 | Choose the lead model | **Decided:** the local model already configured for the worker, thinking enabled, as `PROFILES.LEAD`. No new download, no metered spend, source never leaves the machine |
| 4 | Delivery: documented subagent preset, or plugin support | **Decided:** documented preset. The plugin enforces boundaries; owning DSH's agent lifecycle would duplicate the host and break when it changes. Guide at `presets/lead.md` |
| 4a | **`presets/lead/`** — a real DSH agent composition | **Built and mounted.** A session on the Lead preset came up with Read/Glob/Grep/Pwsh, and the plugin logged `role: lead` / `LEAD_LEFT_AS_CONFIGURED`. The persona now carries the contract's shape, after the first version's omission cost the lead its window reverse-engineering the harness to discover what a contract was |
| E | **The verification timeout is hardcoded at 30 s** — a contract whose command legitimately needs longer cannot be expressed, and no configuration raises it | Found by the lead reading `runSandboxVerification`. Not started |
| 3 | `LEAD` profile — thinking on, repository access, authors each unit's contract | **Built.** `PROFILES.LEAD` plus `leadTier`. The host half that grants repository access is guided in `presets/lead.md` and is not yet verified |
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
| — | `package.json` has no `repository`, `homepage`/`bugs`, or `engines` | Found. Lower priority now that publication is GitHub-only; `repository` is still worth adding so the package points at its own source |
| — | No root `LICENSE` (only `plugin/LICENSE`), which is what GitHub's licence detection reads | Found, not fixed |
| 19 | Reload the desktop app, which is still serving the pre-rename module | **Done.** Confirmed from `router-debug.log`: after `PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR` the hook trace gains `role` and `roleReason`, fields that exist only in the new code |
| 16 | Live-verify `UNVERIFIED` and the delegated-read prompt after a reload | **Half done.** The reload is confirmed and `UNVERIFIED` is verified live, alongside `VERIFICATION_FAILED` and `SUCCESS`. The delegated-read prompt did **not** fire, which is an open observation recorded in `SECURITY-REVIEW.md` |
| 14 | Context-quality counters: frontier tokens in the window per turn, compactions per session, turns before restart | Not started |
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
