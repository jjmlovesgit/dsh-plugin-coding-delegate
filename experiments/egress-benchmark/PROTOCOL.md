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

**Arm A is the current live state.** The profile patch at
`~/.dsh/profiles/tauri/cordis.patch.yml` sets neither `sourceReadEgress` nor `declarationRoot`, so the
default path is `'source'`. Arm A should be run first, so the second arm is the only change.

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
| tier 3 | the answer must name **1** entry labelled `api key assignment`, out of 34 in `entries` | the file is a wrapper object `{$comment, source, capturedAt, count, entries}`, not a bare array |

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

### Arm A — `sourceReadEgress: 'source'` (the live default)

Recorded 2026-10-10, one fresh session, three tasks run sequentially with a tree reset after each.
`router-debug.log` windows are 1-based line indices; counts are confined to each window.

| task | window (lines) | readsAttempted | readsServedDeclarations | readsRefused | turns | wallClockSec | acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tier 1 — surface contract | 60019–60172 | 2 | 0 | NOT MEASURED | 9 | ~30 (approximate) | pass |
| tier 2 — boundary patch | 60224–60334 | 1 | 0 | NOT MEASURED | 6 | 18.2 | pass, 14/14 |
| tier 3 — fixture audit | 60386–60419 | 0 | 0 | NOT MEASURED | 5 | 5.7 | pass |

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

### Arm B — attempted, LIVENESS GATE FAILED, no data

**One attempt, voided.** Recorded rather than discarded, because the failure mode is the one the protocol
exists to catch.

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

**Consequence: no friction delta exists.** There is one arm of data. The coverage boundary is likewise
unconfirmed. What arm A does show is narrower and about the instrument: a *search*-based inspection never
reads at all, so a task like tier 3 never exercises the read path that `sourceReadEgress` governs.

## Recording the result

Write one row per task per arm into a results table in this file, with the arm, the three counts, turns,
wall clock, and whether the acceptance check passed. Report the two arms side by side **per tier**, and
state the coverage gap for tier 3 separately from the friction numbers for tiers 1 and 2 — they answer
different questions and must not be averaged together.
