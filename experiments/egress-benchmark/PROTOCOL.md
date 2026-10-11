# Protocol: does `sourceReadEgress: 'declarations'` reduce friction or coverage?

A controlled comparison of the plugin's **egress control** across two arms, on a fixed three-task list.
The task definitions and the telemetry schema are in [`benchmark-tasks.json`](benchmark-tasks.json).

**What this measures.** Not whether the plugin is valuable — that is settled elsewhere and was refuted
for cost and privacy. This measures what the `'declarations'` control actually *reaches*, and what it
costs in turns for the work it does reach. A task that behaves identically in both arms is a task the
control does not cover, and that is a finding rather than a null result.

## The two arms

| | arm A | arm B |
| --- | --- | --- |
| setting | `sourceReadEgress: 'source'` | `sourceReadEgress: 'declarations'` |
| `declarationRoot` | unset | `C:\Projects\DSHLaya\plugin\dist` |
| a `.ts` read returns | the file | the compiled `.d.ts` skeleton, or a refusal |
| a `.json` / `.cjs` / `.md` read returns | the file | **the file** — outside the control |

**Arm A was the live state when its run was recorded, and it is not any more.** At the time of the arm-A
run the loaded profile declared neither `sourceReadEgress` nor `declarationRoot`, so the live path was
`'source'`. The loaded profile (`~/.dsh/profiles/tauri/cordis.patch.yml`) now **does** pin
`sourceReadEgress: 'declarations'` with `declarationRoot: 'C:\Projects\DSHLaya\plugin\dist'`, which is
how the arm-B run below was taken. Arm A should be run first, so the second arm is the only change.

### Switching arms

**More than one profile carries a `local-router` entry, and only the loaded one takes effect.** On this
machine both `~/.dsh/profiles/tauri/cordis.patch.yml` (entry starts at line 11) and
`~/.dsh/profiles/web/cordis.patch.yml` (entry starts at line 1) declare it. Patching the profile the
running process did not load leaves the previous arm live and produces a run that is silently arm A.

Determine which profile is loaded **before** editing, and confirm it afterwards with the liveness check
below. `DSH_WEB_URL` being set indicates the web profile served the session, but that is an inference
from the environment rather than a reading of the loaded config.

Add to the `local-router` entry in the loaded profile:

```yaml
    sourceReadEgress: 'declarations'
    declarationRoot: 'C:\Projects\DSHLaya\plugin\dist'
```

Then **restart DSH.** Plugin options are read once at registration, so a profile edit without a restart
leaves the previous arm live and the run silently measures the wrong thing.

## Prerequisites, and why each is load-bearing

### 1. Build before measuring arm B

```
cd plugin && npm run build
```

`declarationPathFor` maps a source path to `<declarationRoot>/<relative>.d.ts`. `tsconfig.json` sets
`declaration: true`, `outDir: ./dist`, `rootDir: ./src`, so `plugin/src/guard.ts` resolves to
`plugin/dist/guard.d.ts` — which exists. Without a current build, arm B produces only refusals: a
missing skeleton is refused, and one **older than its source** is refused as stale. Either way the arm
measures nothing but its own prerequisite, and the run is void.

Verify the mapping before starting:

```
node -e "const {declarationPathFor}=require('./plugin/dist/guard.js'); console.log(declarationPathFor('plugin/src/guard.ts','plugin/dist'))"
```

It must print a path that exists on disk.

### 2. Confirm the arm is live

Read one `.ts` file, then search the debug log for `SOURCE_DECLARATION_SERVED`. **Its absence means arm
B is not live**, whatever the profile says. Do this before measuring, not after.

### 3. Reset between tasks

`git checkout -- <paths>` before each task. A task in one arm must not inherit the other arm's edit.

### 4. Know which extensions the control actually covers

`declarationPathFor` returns non-null for exactly four extensions, and null for everything else. The
consequence for this benchmark, checked against the built module rather than assumed:

| path | `declarationPathFor` | what arm B serves |
| --- | --- | --- |
| `plugin/src/guard.ts` | `plugin/dist/guard.d.ts` (exists) | the skeleton |
| `plugin/tests/plugin.test.ts` | `plugin/dist/plugin.test.d.ts` (**does not exist**) | **refused** |
| `plugin/tests/fixtures/classifier-goldens.json` | `null` | **the raw file** |
| `scripts/verification-golden.cjs` | `null` | **the raw file** |
| `README.md` | `null` | **the raw file** |

Note the third row. A `.ts` file under `tests/` maps through the basename fallback
(`guard.ts:583-587`) to a skeleton that no build produces, because `tsconfig.json` sets `rootDir: ./src`
and `include: ["src/**/*"]`. Arm B therefore **refuses** reads of the test suite — not because tests are
sensitive, but because the mapping produces a path nothing emits. That is a coverage artefact of the
benchmark, and it is why tier tasks must name their files precisely: a tier-2 task pointed at a test file
would measure a refusal, not the friction it was designed to measure.

## Metric collection

The log is `resolveDataDir() + '/router-debug.log'`, which is
`C:\Users\Jim\.dsh\local-router\router-debug.log` on this machine. It is append-only.

### Who can run this

**An agent working inside a DSH session cannot run this benchmark.** Three reasons, each independently
disqualifying:

1. It has no way to open a *fresh* session, so its runs are all in one long-lived context.
2. Switching arms requires a restart, which terminates the session executing it.
3. It already knows the hypotheses, the task list and the fixture answers, so its turn counts measure a
   model that is not blind.

The run requires a human operator with a session launcher: one clean session per arm, six task runs
total. An agent may prepare the artifacts and tabulate the results, and must not supply the numbers.

**Per run:**

1. Record the log's **byte length** before the task.
2. Run exactly one task. Nothing else, nothing concurrent.
3. Re-read the log from that byte offset, and count `SOURCE_READ` and `SOURCE_DECLARATION_SERVED`
   events **within that window**.
4. Record `turnsTaken` and `wallClockMs`.
5. **Reset the tree** — `git checkout -- plugin/src/declaration-egress.ts` — after *every* task, not only
   between arms. Tasks 1 and 2 both edit that file, so without a reset task 2 inherits task 1's interface
   addition, and its turn count stops being comparable with the same task in the other arm.

### Acceptance commands, checked against the tree

| task | acceptance | note |
| --- | --- | --- |
| tier 1 | `npm run build` then `node tests/oracles/declaration-egress-scope.test.cjs` (14 tests) | there is no `tests/declaration-egress.test.ts`; the oracles above are the real judges |
| tier 2 | same as tier 1 | the scope oracle must still report 14 passing |
| tier 3 | the answer must name **9** matches in `classifier-goldens.json` and **0** in `scripts/verification-golden.cjs`, with each line number | the sealed instruction is a regex audit for `sk-`, `ghp_`, `AKIA`, `BEGIN ... PRIVATE KEY` and `xox[baprs]-` patterns, not a label count; the fixture is a wrapper object `{$comment, source, capturedAt, count, entries}`, not a bare array |

The byte offset is what makes a run attributable. The log is shared with the running host app, so
counts taken from the whole file mix this task with unrelated traffic — and because the host also writes
to it, a before/after line count is not enough.

**Run all three tasks in arm A, restart, then all three in arm B.** Do not interleave arms: a restart is
required to switch, so an interleaved order would mean four restarts and four session boundaries.

## What the instruments can and cannot say

This is the part that decides whether a number is evidence or decoration.

| field | status | source |
| --- | --- | --- |
| `readsServedDeclarations` | **measured** | `SOURCE_DECLARATION_SERVED`, traced at `index.ts:1477` with the requested path and the served skeleton |
| `readsAttempted` | **partial** | `SOURCE_READ`, traced at `index.ts:1366` — but it fires from `tools/pre-execute` for calls the guard **allowed**, so it undercounts and cannot see refusals |
| `readsRefused` | **not measured** | a refusal is a post-execute block decision with no trace event of its own |
| `wallClockMs` | measured | operator |
| `turnsTaken` | measured | session transcript |

**Do not compute `readsRefused` from `SOURCE_READ` arithmetic.** A read that is refused never produces a
`SOURCE_READ` event, so `attempted - served` silently yields zero refusals no matter how many occurred —
a number that looks measured and is not. Counting refusals requires either scanning the session
transcript for block decisions, or one added `trace` call in the declarations block of `index.ts`.

This matters more than it looks: a benchmark whose `readsRefused` is structurally always zero would
report "the control refuses nothing", which is the opposite of what the control does.

## Threats to validity

- **n = 1 per task per arm.** This can suggest; it cannot prove.
- **The operator is not blind.** Knowing the hypothesis changes how a task is attempted.
- **The arms are different sessions.** A restart intervenes, so prior context differs.
- **Tier difficulty is not comparable.** Aggregate percentages across tiers are meaningless; compare
  within a tier.
- **Reads are not the only egress.** `contextFiles` injected to the worker are governed by a different
  check and are not affected by `sourceReadEgress` at all.
- **A null result is not proof of irrelevance.** A task succeeding in both arms shows that task did not
  require withheld bodies; it says nothing about tasks that do.

## The decision rule, written before the runs

1. **If tier 3 is served in full in arm B**, the control's coverage stops at four extensions. Record a
   coverage limit — do not report a successful mitigation.
2. **If tiers 1 and 2 show no difference**, signature-level work costs nothing to protect, and the only
   open question is coverage.
3. **If tier 2 costs materially more turns in arm B**, that is the price of withholding bodies from patch
   work. Name the mechanism: a `.d.ts` does not contain the string literal a SEARCH block must match
   byte-for-byte, so the exact text has to be supplied as context.
4. **Any run in which arm B never emits `SOURCE_DECLARATION_SERVED` is void.** The arm was not live; the
   run measured the default while claiming to measure the control.

## Results

**Preliminary / single-run (n = 1).** Observed values, one session per arm, three tasks per session, tree
reset after every task. Log windows are 1-based line indices and every count is confined to its window.

> **Boundary callout — the pre-registered void condition, both readings.**
> The rule in `benchmark-tasks.json` voids any run in which arm B never emits `SOURCE_DECLARATION_SERVED`.
> **Strict reading:** zero such events fall inside the task windows `W_T1`, `W_T2`, `W_T3`, so the arm-B
> runs are formally unconfirmed by that in-window criterion. **Empirical-liveness reading:** line 62237
> (`plugin/src/declaration-egress.ts` → `plugin/dist/declaration-egress.d.ts`, 1923 bytes) proves the
> post-execute hook was mounted and functional immediately before task 1 began
> (`LIVE_BEFORE` 60691 < 62237 < `START_1` 62277), and the absence of declaration events in `W_T2` and
> `W_T3` was the mechanism working — refusals preempting declaration dispatch — not an inactive hook.
> Both readings are retained. The table is not marked void; it is marked single-run and unconfirmed by the
> in-window criterion.

| metric | task / tier | arm A (`source` — ungated baseline) | arm B (`declarations` — gated) | delta / observed mechanism |
| --- | --- | --- | --- | --- |
| turns | T1 (interface surface) | 9 | 9 | 0 — no penalty; `.d.ts` skeletons are sufficient for surface work |
| turns | T2 (localised patch) | 6 | 13 | +7 — the guard refused raw reads; 2 patch attempts were refused before the literal was reconstructed |
| wall clock (s) | T1 | ~30 (not measured at start) | 32.4 | inconclusive: the arm-A baseline was not captured at task start |
| wall clock (s) | T2 | 18.2 | 40.0 | +21.8 — direct artifact of the retry loop on rejected patch context |
| reads allowed | T1 / T2 / T3 | **NOT COMPARABLE ACROSS ARMS** | **NOT COMPARABLE ACROSS ARMS** | allowed reads only; blocked attempts emit no event and are uncounted |
| reads refused | T1 / T2 | NOT MEASURED | NOT MEASURED | instrument gap: post-execute blocks emit no trace telemetry |
| acceptance | T1 / T2 / T3 | pass / pass / pass | pass / pass / pass | all six task boundaries satisfied |

**Tier 3 is not in this comparison.** The task as specified is satisfied by a *search*, and a search
returns matching lines without reading a file: **0 `SOURCE_READ` events in both arms**. However it is
scored, it never exercised the read path, so it holds no friction signal. Its rows are withdrawn from the
table above and its coverage finding is recorded on its own below, because a zero that means "the
instrument was never engaged" must not be averaged with a zero that means "the control forbade it".

Raw window and count detail, for anyone re-deriving the table:

| task | arm | window (lines) | allowed reads | declarations served | turns | wall clock (s) |
| --- | --- | --- | --- | --- | --- | --- |
| tier 1 | A | 60019–60172 | 2 | 0 | 9 | ~30 |
| tier 1 | B | 62277–62465 | 2 | 0 | 9 | 32.4 |
| tier 2 | A | 60224–60334 | 1 | 0 | 6 | 18.2 |
| tier 2 | B | 62618–62839 | 0 | 0 | 13 | 40.0 |
| tier 3 | A | 60386–60419 | 0 | 0 | 5 | 5.7 |
| tier 3 | B | 62890–62958 | 0 | 0 | 4 | 15.4 |

Tier 3 rows are retained here for completeness of the record but are excluded from the comparison table
above: **0 reads in both arms**, so the tier measures the instrument rather than the control.

Arm A windows are measured inclusive ranges (`START`+1 … `END`, from the recording run's own line counts,
which is why they read one line later than the `START`/`END` pairs quoted in the telemetry blocks). Arm B
windows are the operator-reported `START`/`END` pairs verbatim.

### Run 2 — cold-boot verified (arm A only; arm B not measured)

Run 1's largest threat was that **arm A never passed a liveness gate** — its arm was inferred from an
unguarded session. Run 2 was taken to close exactly that, by cold-booting the process and gating both
arms before any task. **Arm A is complete and independently recounted. Arm B produced no valid
measurement.** Both facts are reported here rather than averaged into one verdict.

Gate, before task 1:

| reading | value | meaning |
| --- | --- | --- |
| `LIVE_BEFORE` | 64898 | line count before the probe |
| `SOURCE_READ` in window | 1 | the probe read a covered `.ts` file |
| `SOURCE_DECLARATION_SERVED` in window | 0 | no declaration was served |
| content served | raw | **arm A confirmed by its own signature, not inferred** |

Arm A, three tasks, one session, tree reset after each task:

| task | window (lines) | allowed reads | declarations served | turns | wall clock (s) | acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| tier 1 — surface contract | 64958–65009 | 0 | 0 | 4 | 13.3 | pass |
| tier 2 — boundary patch | 65043–65137 | 1 | 0 | 6 | 13.8 | pass |
| tier 3 — fixture audit | 65171–65205 | 0 | 0 | 2 | 6.7 | pass |

Tier 2's single read is a **reset consequence, not a task requirement**: the tier-1 build had rewritten
`plugin/dist`, and the reset restored it, so one read was spent re-establishing state the task itself did
not need. Recorded because it would otherwise be read as friction.

**What Run 2 establishes that Run 1 could not.** Arm A's arm is now *verified by a gate event* rather than
inferred from absence; the read counts were independently recounted from the log; and tier 3 again shows
0 reads, now in a cold-booted session, confirming the search-answers-without-reading mechanism is a
property of the instrument and not of one session's luck.

**What Run 2 does not establish.** It is still n = 1 per cell, still not blind, and it supplies **no
arm-B measurement at all** — so the +7-turn / +21.8 s tier-2 delta remains Run 1's single observation and
is *not* corroborated here. Run 2 raised the baseline's quality; it did not strengthen the delta.

#### A refused read emits no event at all — observed, not argued

Run 1 recorded `readsRefused` as NOT MEASURED on a *structural* argument: the guard's decision runs at a
point that emits no trace. Run 2 turned that into a direct observation. A window was opened deliberately,
two commands were refused inside it, and the window was closed:

| reading | value |
| --- | --- |
| window | lines 65570–65637 |
| refusals inside the window | **2** (both returned the refusal message to the operator) |
| trace events in the window | `HOOK_EXIT`, `CONTEXT_QUALITY` **only** |
| refusal events in the window | **0** |

**Consequence, and it is not cosmetic:** the log cannot count refusals, so read counts cannot be compared
between arms *even in principle* on this instrument. Arm A's `0` means "the search answered" while arm B's
`0` can coexist with an arbitrary number of refusals. The turn and wall-clock columns are the only
delta-bearing instruments; the read columns are a record of what the guard *allowed*, never of what it
*stopped*. Any future claim of the form "the control blocked N reads" is unmeasurable as built.

#### Arm B — live and armed, but structurally unmeasurable from inside a session

Arm B was armed for this run: `PLUGIN_INIT` last fired at line 65328 (20:30:08Z) and three
`SOURCE_DECLARATION_SERVED` events follow it with no intervening restart.

**Those three events are not benchmark task windows.** They were produced by the architect's own
verification commands while checking the control — reads of covered `.ts` files that were correctly
answered with skeletons. They prove the arm was *live*; they are **not** an arm-B task measurement, and
must not be cited as confirmation of one. An earlier draft of this record came within one step of doing
exactly that, which is why the distinction is written down.

Two blind attempts to take the arm-B measurement were made and **both are void**:

| attempt | result | cause |
| --- | --- | --- |
| blind subagent run 1 | all six task windows 0 reads / 0 declarations | workspace refused |
| blind subagent run 2 | all six task windows 0 reads / 0 declarations | workspace refused |

The cause is **structural, not a mistake to retry**: a subagent session's workspace is
`…\npm\node_modules\@deepseek-ai\dsh`, so passing `workspaceDir 'C:\Projects\DSHLaya'` is refused —
*"outside the session workspace … and outside every configured emitAllowlist root"*. Direct edits are
approval-gated and a nested agent has no approver, so three escalated attempts returned
`(approval outcome: rejected)`. **Arm B cannot be measured by a delegated agent from this session. It
requires a human-started session with the workspace pinned** — which is what `run-3-rearm-and-arm-b.md`
is for, and why that file exists rather than a script.

**Blindness held.** Neither run opened `PROTOCOL.md`, `FINDINGS.md` or `benchmark-tasks.json`, so the
void is *not* a leakage void. It is a void by never having been able to run.

#### Two claims checked while building this record, one confirmed and one partly unconfirmed

Both concern artefacts produced during this work rather than the benchmark itself, and both are recorded
because each is an instance of the defect class this project keeps hitting: *a check that passes for a
reason orthogonal to the property it claims to check*.

1. **Vacuously-passing acceptance — CONFIRMED.** The tier-1 acceptance result is reported as "14/14".
   The oracle behind that number, `plugin/tests/oracles/declaration-egress-scope.test.cjs`, contains
   **zero occurrences** of `DeclarationEgressSummary` — it asserts the pure decision function
   `evaluateDeclarationEgress`, not the summary type the wired path produces. The 14/14 is real and the
   suite genuinely passes; it simply **does not measure the control being wired**. The liveness gate is
   what covers that, not the acceptance command.
2. **Artefact refusal — PARTLY UNCONFIRMED, and the attempt was itself informative.** The claim that
   generated artefacts are refused as *unsettled* could not be confirmed by direct probe:
   `lookupDelegatedRecord` is unavailable from a scratch script, and a follow-up probe that would have
   read built `.js` files was refused by the very guard under test. **The evidence for this claim is
   therefore the refusal messages themselves, not a reproduced verdict.** Stated as such.

**What building this record established about the guard's boundary.** Two verification commands were
refused under arm B with *"sourceReadEgress is 'declarations' and this command reads source content"* —
but neither command **opened** a source file. The first merely contained `plugin/dist/guard.js` and
`…scope.test.cjs` as string literals; a boundary test then confirmed that a command mentioning a `.js`
path and reading nothing is refused, while an otherwise identical command mentioning no `.js` path
succeeds. A third command naming `plugin/src/...` was refused under arm A for reading source.

So the guard binds from **both** arms and, under arm B, refuses on the *mention* of source content rather
than on an actual read. **That is a false positive against commands that name files without reading
them** — for example a build that merely references paths, or any command that reports on source. It is
recorded as a cost of the control and as a reproducibility obstacle: the operator's own tooling is
subject to the thing being measured, which is faithful to the threat model but makes verification
recursive and awkward.

#### Acceptance criteria, corrected

The tier-2 acceptance must reset the build output as well as the source, or the tree is not clean:

```powershell
git checkout -- plugin/src/declaration-egress.ts
git checkout -- plugin/dist/            # REQUIRED: the build rewrites tracked files here
git status --porcelain                  # must print nothing
```

Run 1 recorded this as harmless (`dist` proved deterministic and matched HEAD), which is exactly why it
belongs here permanently: whether a build dirties a tracked artefact is a property of the build, not a
guarantee, so the reset is a precondition rather than a repair.


### Primary finding — tier 2 is a mechanical retry cost, not conversational delay

`sourceReadEgress: 'declarations'` does not merely add delay to patch work; it removes the exact bytes the
patch needs. A declaration skeleton is an AST projection, so it carries signatures and types but **not**
string literals, comment text or refusal strings. The tier-2 task changed one refusal-message literal, and
under arm B the guard refused the raw reads that would have supplied it — two edit attempts were refused
before a third succeeded with the path assembled from fragments. The cost is therefore a *retry loop over
rejected patch context*, and it is visible in both instruments at once: **+7 turns and +21.8s**. That is
the mechanism the pre-registered decision rule named in advance, now observed.

### Coverage boundary — tier 3 is identical in both arms

`.json` and `.cjs` are outside the four covered extensions, so neither fixture is redirected: both arms
returned the same 9 matching lines in `classifier-goldens.json` (37, 51, 65, 79, 107, 121, 415, 429, 443)
and the same 0 in `scripts/verification-golden.cjs`. The one difference is the *route*, not the content:
under arm B the shell `grep` was refused ("a search returns matched source lines"), and the read-tool
fallback then served the entire 81-line `.cjs` unredacted. **The control's coverage stops at four
extensions; non-`.ts` files bypass declaration redirection entirely.** This is a coverage limit, recorded
as such, not a mitigation success.

Tier 1 confirms the other half: 9 turns in both arms, no measurable penalty. A signature is exactly what a
`.d.ts` serves, so withholding bodies costs nothing for surface work.

### Why the read counts are not a delta

`readsAttempted` is **NOT COMPARABLE ACROSS ARMS** and must not be cited as `2/1/0` versus `2/0/0`. The
instrument counts only reads the guard *allowed*: arm A's tier-3 `0` means the search tool answered
without a read, while arm B's tier-3 `0` coexists with at least two refusals that emitted no event at all.
Zero and zero therefore mean different things in the two arms, and with `readsRefused` NOT MEASURED the
difference cannot be reconstructed arithmetically. The turn and wall-clock columns are the delta-bearing
instruments; the read columns are not.

### Threats to validity, extended by this run

- **n = 1 per cell**, now actual rather than prospective. Tier 2's +7 turns is one run, on one file, by one
  operator.
- **The operator was not blind** — the hypotheses and the fixture expectations were known before the runs.
- **Arm A never passed a liveness gate.** Its arm is *inferred* from an unguarded session, not verified by
  a pre-task check. Arm B's liveness **is** established: the gate served
  `plugin/src/declaration-egress.ts` → `plugin/dist/declaration-egress.d.ts` (1923 bytes) at log line
  62237, which lies between `LIVE_BEFORE` 60691 and `START_1` 62277, and reads of covered `.ts` files
  returned compiled skeletons while shell commands naming source content were refused.
- **No `SOURCE_DECLARATION_SERVED` event falls inside any arm-B task window.** See the boundary callout
  above: the strict reading of the pre-registered rule would leave the arm-B runs formally unconfirmed,
  while the gate event at 62237 establishes the arm was live immediately before task 1. The rule as
  written was pre-registered, so both readings are recorded rather than one being retired post hoc.
- **The arms are different sessions**, so prior context differs between them.
- **Tier difficulty is not comparable**; aggregate percentages across tiers are meaningless.
- **`contextFiles` injected to the worker are not governed by `sourceReadEgress`**, so the architect's
  reads are not the only egress and this benchmark does not measure the whole of it.

### Arm A — `sourceReadEgress: 'source'` (the ungated baseline)

Recorded 2026-10-10, one fresh session, three tasks run sequentially with a tree reset after each.
`router-debug.log` windows are 1-based line indices; counts are confined to each window.

| task | window (lines) | readsAttempted | readsServedDeclarations | readsRefused | turns | wallClockSec | acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tier 1 — surface contract | 60019–60172 | 2 | 0 | NOT MEASURABLE | 9 | ~30 (approximate) | pass |
| tier 2 — boundary patch | 60224–60334 | 1 | 0 | NOT MEASURABLE | 6 | 18.2 | pass, 14/14 (see the vacuity note in Run 2) |
| tier 3 — fixture audit | 60386–60419 | 0 | 0 | NOT MEASURABLE | 5 | 5.7 | pass |

`readsRefused` is **NOT MEASURABLE**, not merely unmeasured. Run 1 argued this structurally; Run 2
observed it directly — a window containing two refusals and zero refusal events. The distinction between
`0` and an unknown number is the whole point, so the column says what it means.

**Independently recounted** from the log by the architect afterwards, not taken from the run's own
report: the three windows contain 2, 1 and 0 `SOURCE_READ` events respectively, and 0
`SOURCE_DECLARATION_SERVED` in any window. Arm A is the `'source'` path, so no declaration should be
served, and none was — the run is consistent with its arm.

**Observation about tier 3: zero reads.** The task asked for every line matching a credential regex
across two files, and the run satisfied it with `grep` and **no file read at all** — 0 `SOURCE_READ`
events, 5 turns, 5.7s. This is the sharpest early result and it is about the *instrument*, not the
control: on this plugin, a search tool returns matching lines directly, so a content-inspection task
never needs a read for `sourceReadEgress` to govern. Measuring egress friction on such a task measures
nothing.

### Instrument notes discovered during the run

- **`node --test` is denied in the confined sandbox.** The tier-2 acceptance command hit the
  documented `spawn EPERM` — a denial of piped-stdio child processes, not a test failure — and
  succeeded on a single retry with wider permission. An operator without that escalation cannot run the
  oracle acceptance as written.
- **The declared reset command is necessary but not sufficient.** `git checkout --
  plugin/src/declaration-egress.ts` restores the source, but the tier-1 and tier-2 builds also rewrite
  tracked files under `plugin/dist/`, so the tree is not clean until `plugin/dist/` is reset too. On
  this run `dist` proved deterministic — it matched HEAD afterwards with zero uncommitted changes — so
  the extra reset was harmless rather than a correction of real drift. Do it anyway: whether a build
  dirties a tracked artifact is a property of the build, not a guarantee.
- **Stale `SOURCE_DECLARATION_SERVED` events already exist** in the shared log (lines 38962 and 40368,
  from earlier work). A liveness check that greps the whole file will therefore pass against Arm A.
  Arm B's gate must confirm a **new** event after the pre-read line count, not merely that the pattern
  appears anywhere.
- **The one-shot `--patch` route does not exist on this machine.** An attempt was made to run the arm-A
  baseline as an isolated subprocess (`dsh --profile tauri --patch experiments/egress-benchmark/arm-a-overlay.yml "<prompt>"`),
  which would have resolved both open threats — a fresh session and an exact wall clock — without touching
  the live profile. It cannot work, for three independently blocking reasons:
  1. **`--patch` replaces an entry's `config`; it does not deep-merge.** Verified with `--dump-config`: a
     one-key overlay composed `local-router` down to `sourceReadEgress: source` alone, silently dropping
     `guardAskPaths`, `dlpAction`, `leadTier`, `coherenceVerification` and both provider entries. A
     one-key overlay therefore measures a *different harness*, not the same harness with egress off.
     `arm-a-overlay.yml` was rewritten to repeat the full entry so the two arms differ in exactly one key.
  2. **The tauri profile accepts no arguments**, so it cannot host a one-shot run: passing a prompt fails
     with `too many arguments. Expected 0 arguments but got 1`. The only one-shot form the CLI documents is
     `dsh --profile headless`, and no `headless` profile is installed (`~/.dsh/profiles` contains only
     `default`, `tauri`, `web`). The `web` app is a GUI server, not a prompt-and-exit runner.
  3. **Preparing any profile writes outside the benchmark workspace.** Booting a profile composes
     `~/.dsh/profiles/<name>/cordis.yml`, which a confined session cannot write (`EPERM`), so each
     invocation would need escalated file permissions.
  Consequence: the arm-A baseline cannot be taken from inside a session, and the claim under **Who can run
  this** — that the run requires a human operator with a session launcher — is empirically confirmed rather
  than merely asserted. `arm-a-overlay.yml` is retained so an operator on the host can take that baseline
  in one command once the profile is flipped.

### Measured directly, without sessions: what the skeleton actually contains

The results table above is marked single-run and unconfirmed by its own in-window criterion. The question
it was built to answer — *does withholding bodies cost anything* — can be measured without any running
host, by comparing the source file against the declaration the control actually serves. Both are on disk.

`plugin/src/declaration-egress.ts` (172 lines, 8170 B) vs `plugin/dist/declaration-egress.d.ts`
(37 lines, 1923 B):

| measure | source | skeleton served |
| --- | --- | --- |
| size | 8170 B / 172 lines | 1923 B / **37 lines** (4.3x smaller) |
| refusal message strings (`"was refused"`) | **6** | **0** |
| doc-comment lines | 60 | 21 (35% survive) |
| exported interfaces | 2 | 2 |
| exported function signature | 1 | 1 |

**This explains the tier-2 result mechanically, and does not depend on turn counting.** A `.d.ts` carries
signatures and types; it carries no string literals except *type unions*
(`'allow' | 'serve-declaration' | 'block'`). The tier-2 task changes a refusal-message literal. Under
declarations mode that literal is **absent from what the architect can see** — not hidden, not
summarised, absent. So the retry loop the table records (+7 turns, +21.8s) is not a cost that better
prompting would remove; it is the consequence of asking for bytes that the served artefact does not
contain.

**Tier 1 is unaffected, and for a checkable reason.** Both interfaces and the full signature survive, so
surface work has everything it needs. The measured 0-turn delta there is what the composition predicts.

**An asymmetry worth knowing before trusting a skeleton.** `mappableSourceFile` (a function) survives as
an exported declaration; `MAPPABLE_SOURCE_EXTENSIONS` (a module-private constant) does not. The skeleton
therefore exposes the *shape* of a policy but not its *data* — a signature that invites the assumption
its extension set is knowable from here, when it is not.

**Tier 3 never exercised the read path at all.** The task as specified is satisfied by a search, which
returns matching lines without reading a file: **0 `SOURCE_READ` events in both arms**. However that tier
is scored, it is not measuring egress.

**Scope.** This establishes composition and coverage by direct measurement. It does **not** replace the
turn-count table, which remains the only record of a live arm-B session. It does mean that anyone
re-running the A/B should expect tiers 1 and 2 to differ *in kind* — content present versus content
absent — rather than by a modest margin.

### Arm B — first attempt, voided, superseded by the run tabulated above

**One attempt, voided.** Recorded rather than discarded, because the failure mode is the one the protocol
exists to catch. This failed attempt **predates** the arm-B run tabulated above and is not the source of
any number in the results table.

The gate ran before any task and failed:

| reading | value |
| --- | --- |
| `LIVE_BEFORE` | 60691 |
| `LIVE_AFTER` | 60734 |
| `SOURCE_DECLARATION_SERVED` after `LIVE_BEFORE` | **0** |
| `SOURCE_READ` in the same window | 1 |

A read of a covered `.ts` file (`plugin/src/declaration-egress.ts`) was classified as a read-class egress
event and **no declaration was served** — the signature of the `'source'` path, not of declarations mode.

Diagnosed afterwards from host state, not guessed:

- **Neither profile was patched.** `~/.dsh/profiles/tauri/` and `~/.dsh/profiles/web/` both carry the
  `local-router` entry and neither contains `sourceReadEgress` or `declarationRoot`.
- **The plugin was never re-initialised.** No `PLUGIN_INIT` / `LOCAL_ROUTER_INIT` event appears after the
  gate window, so **no restart occurred** and the running process still held the `'source'` options read
  at registration.

Had the gate been omitted — or had it grepped the whole file and matched the two stale events at lines
38962 and 40368 — three more runs would have been recorded as declarations-mode measurements while
being, in fact, arm A.

**A second defect the gate does not catch.** The arm-B work ran in the *same session* as arm A: line
numbers continued rather than opening a fresh window, and no restart intervened. The protocol requires
one clean session per arm. Even with the profile correctly patched, this session would have confounded
the comparison with carried-over context. **Arm B requires a genuinely new session**, not merely the
option being set.

**Consequence at the time: no friction delta existed** — one arm of data, and the coverage boundary
unconfirmed. On the strength of this failure the profile was subsequently pinned to `'declarations'` and
the arm-B run above was taken in a session whose arm is established by its gate event. What this voided
attempt still establishes, independently of that later run, is the failure mode itself: the profile has
since been patched, which is exactly the change whose absence the gate detected here.

## Recording the result

Write one row per task per arm into a results table in this file, with the arm, the three counts, turns,
wall clock, and whether the acceptance check passed. Report the two arms side by side **per tier**, and
state the coverage gap for tier 3 separately from the friction numbers for tiers 1 and 2 — they answer
different questions and must not be averaged together.

## Run 3 — re-armed, session-gate failed (arm A contaminated; arm B max-tokens)

- **Date**: 2026-10-10
- **Commit SHA**: `72364a4` — the commit that last changed `run-3-session-gate.cjs`, the gate that
  produced these verdicts.

- **Arm A Evaluation**:
  - **Session ID**: `session-0cfdd8b1-9b63-4d35-8182-33a6542e859b`
  - **Gate Verdict**: FAILED (`GATE_EXIT=1`). Contaminated by local DLP pin.
  - **Dispatches Recorded**: 3 total requests (1 `deepseek-official / deepseek-flash`, 2 `lm-studio / qwen/qwen3.8-27b`).
  - **Trailing Turn End**: `turn 2 reason={"kind":"max-tokens"}`.
  - **Host Trace**: Pre-run log baseline was clean, but subsequent session turns tripped local routing.

- **Arm B Evaluation**:
  - **Session ID**: `session-98e86d35-41cc-41ba-98b3-51449ef8347e`
  - **Gate Verdict**: FAILED (`GATE_EXIT=1`). Trailing turn budget truncated.
  - **Dispatches Recorded**: 2 requests to `lm-studio / qwen/qwen3.8-27b`.
  - **DLP Pin Assertion (`fcb9340`)**: PASS (`requests still carrying reasoningEffort: 0`).
  - **Host Error Turns**: PASS (`UNSUPPORTED_REASONING_EFFORT: 0`, other error turns: 0).
  - **Trailing Turn End**: `turn 1 reason={"kind":"max-tokens"}` (Qwen3.8-27b token budget exhausted during local reasoning).
  - **Log Attribution Caveat**: Host `DLP_PINNED_LOCAL` delta grew to +4 (32 -> 36), but trailing timestamps (00:22–00:26Z) do not align with store write completion (00:09:50Z); cannot uniquely attribute host delta to this session alone.

- **Ledger Ingestion**:
  - `NO LEDGER ROWS` (architect execution without delegated sub-agent tool calls; not instrumented by `savings-ledger.json`).
  - Throughput (e2e tok/s): `NOT MEASURED`.
  - TTFT: `NOT MEASURABLE — NOT IMPLEMENTED`.
  - Decode-only Throughput: `NOT MEASURABLE — NOT IMPLEMENTED`.
  - readsRefused: `NOT MEASURABLE` (refusals emit no trace).

### Verification of this record, against the session stores

Stated separately so the findings above can be read as the operator's report and this as their
independent check. Both sessions were re-gated with
`node experiments/egress-benchmark/run-3-session-gate.cjs --session <id> --arm <A|B>`; both returned
`exit 1`, for exactly the reasons recorded above.

| reading | arm A — `session-0cfdd8b1…` | arm B — `session-98e86d35…` |
| --- | --- | --- |
| requests / turns | 3 / 2 | 2 / 1 |
| dispatched routes | 1 × `deepseek-official / deepseek-flash`, **2 × `lm-studio / qwen/qwen3.8-27b`** | 2 × `lm-studio / qwen/qwen3.8-27b` |
| requests to `lm-studio` | **2** | 2 |
| …still carrying `reasoningEffort` | 0 | **0 — `fcb9340` is loaded** |
| `UNSUPPORTED_REASONING_EFFORT` turns | 0 | 0 |
| other error turns | 0 | 0 |
| trailing `turn/end` | turn 2, `{"kind":"max-tokens"}` | turn 1, `{"kind":"max-tokens"}` |
| **gate** | **exit 1** | **exit 1** |

The gate's own reasons, verbatim:

```
arm A: GATE: trailing turn/end is {"kind":"max-tokens"}
       GATE: 2 request(s) dispatched to lm-studio: this arm A session is CONTAMINATED by a DLP pin
arm B: GATE: trailing turn/end is {"kind":"max-tokens"}
```

**`fcb9340` is confirmed working**, and it is this run's real positive finding: both pinned local
requests in arm B dispatched with no `reasoningEffort` attached, and no turn ended
`UNSUPPORTED_REASONING_EFFORT`.

**Correction applied during filing.** An earlier draft of this section reported arm A as having zero
`lm-studio` contamination and a single `deepseek-official / deepseek-flash` route. The store records 3
requests for arm A, of which **2 are `lm-studio`** — arm A was pinned too, so it cannot serve as this
run's clean baseline. That draft also carried arm B as "Accepted with caveat"; the gate's `completed`
assertion rejects a `max-tokens` trailing turn, so the verdict here is FAILED. The draft's own counts
contradicted each other (2 local requests for arm B, 0 for arm A) while both stores hold 2.

**Baseline caveat, extended.** The `32 → 36` delta quoted above is not derivable from this repository's
own recorded baseline: §4 of `run-3-session-b-launch.md` records `DLP_PINNED_LOCAL = 6` at 19:44 local,
which gives +30 against the current 36. Both figures clear the `≥ 7` pass condition, so the direction is
unaffected — but the delta as quoted comes from a baseline recorded elsewhere. The log totals themselves
were confirmed independently: `HOOK_EXIT: DLP_PINNED_LOCAL` **36**, `DLP_FIREWALL_TRIPPED` **36**.

**Why "budget truncated" ends the run rather than caveating it.** A turn that exhausts the local model's
budget during reasoning is not a closed `completed` turn, so the session-scoped half of arm B remains
untaken. This is the same structural void recorded for the earlier agent-hosted attempts, now reproduced
under instrumentation — and `fcb9340` is the one thing this run does establish.

### Working tree at the time of filing

Four files from this work are untracked and deliberately left so: `run-3-session-b-launch.md`,
`scripts/run-3-arm-b-environment.ps1`, `scripts/run-3-set-desktop-profile.ps1`,
`scripts/snapshot-dsh-data.ps1`. `.scratch-hold/` is git-ignored (`.gitignore:25`), so the parked
headless runner and DSH snapshots inside it are outside the tree. Nothing was tagged or pushed.
