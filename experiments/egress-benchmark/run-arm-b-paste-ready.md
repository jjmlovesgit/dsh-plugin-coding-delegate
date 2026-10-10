# Arm B — the single paste

Copy **everything below the line** into a new DSH session whose workspace is `C:\Projects\DSHLaya`.
Nothing else needs sending. Do not paste the prose above the line.

This is `run-arm-b-prompt.md` plus the two preamble steps folded in, so it is one paste rather than three.

---

You are running a controlled measurement inside a DSH session whose workspace must be
`C:\Projects\DSHLaya`. Work through the steps in order and report telemetry as you go. **Interpret nothing.**

## Step 0 — confirm the workspace and build

First, confirm you are in the right place, then build:

```
pwd
Test-Path plugin\dist
cd plugin; npm run build
```

If `pwd` is not `C:\Projects\DSHLaya`, **stop immediately** and say so — every number collected
afterwards would be void. Wait for the build to exit 0 before continuing, because the tier-1 acceptance
check inspects `dist/declaration-egress.d.ts`.

## Your task

You are the **architect** in a DSH session with the coding-delegate plugin loaded in
`sourceReadEgress: 'declarations'` mode. Run the single liveness gate, then three tasks in order,
reporting telemetry as you go. **Interpret nothing.**

**Do not read `PROTOCOL.md`, `FINDINGS.md` or `benchmark-tasks.json`.** They contain the hypotheses and
expected values. Reading them would make this run unable to corroborate anything. The three tasks are
transcribed below so that you never need to open them. (If you have already read them, say so in NOTES —
that is not a failure, it is a fact the record needs.)

### Step 1 — the gate. This is the only thing that proves the arm.

Record the log line count, then read `plugin/src/declaration-egress.ts` **once**, then count only the
lines after your recorded number:

```powershell
$log = "$env:USERPROFILE\.dsh\local-router\router-debug.log"
$before = (Get-Content $log | Measure-Object).Count
```

Now read `plugin/src/declaration-egress.ts` once and inspect what came back:

- **a type skeleton** (`export declare function`, stripped bodies, or a banner saying it was served as type
  declarations) -> **arm B. Continue.**
- **raw source** -> **STOP and report one of two lines, then run nothing:**
  - `STILL ARM A` if the log line count grew after your read;
  - `PLUGIN NOT LOADED` if the log line count did not change.

The content alone cannot tell arm A from a host where the plugin is not loaded. The log is what separates
them. Then count, from lines after `$before` only:

```powershell
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_READ ===').Count
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_DECLARATION_SERVED ===').Count
```

Arm B is confirmed by **a type skeleton returned AND `SOURCE_DECLARATION_SERVED` >= 1**. A skeleton alone
is not enough. Report `LIVE_BEFORE` and both counts before continuing.

> **Do not count your own gate read as task telemetry, and do not count any later debugging read as a
> task window.** In Run 2, three `SOURCE_DECLARATION_SERVED` events inside the run proved the arm was live
> but were the architect's own verification reads, not task windows. Conflating the two is the specific
> error this warning exists to prevent.

### Reset between tasks

Before each task, reset both the source **and** the build output, then confirm the tree is clean:

```powershell
git checkout -- plugin/src/declaration-egress.ts
git checkout -- plugin/dist/
git status --porcelain          # must print nothing
```

The `plugin/dist/` reset is required: a build rewrites tracked files there, so resetting only the source
leaves the tree dirty. Run 1 found `dist` deterministic anyway — which is exactly why the reset belongs in
the procedure permanently, rather than being a repair applied once.

### Task 1 — surface: a typed contract edit  (tier 1)

Add a new exported type `DeclarationEgressSummary` describing the verdict shape, **without altering
`evaluateDeclarationEgress`'s behaviour and without reading its body.**

Read only the export surface. Acceptance: `npm run build` exits 0 and the new type is present in
`dist/declaration-egress.d.ts`.

### Task 2 — boundary: a single-hunk edit in a covered file  (tier 2)

Change **one refusal message string** inside `evaluateDeclarationEgress`, leaving every decision unchanged.

Use a narrow line range rather than reading the file whole. Acceptance: `npm run build` exits 0 and
`declaration-egress-scope.test.cjs` still reports 14 passing.

Run that oracle as
`node --require ./scripts/isolate-oracle-data-dir.cjs plugin/tests/oracles/declaration-egress-scope.test.cjs`
— **not** via `node --test` or `vitest`, which hit `spawn EPERM` in a confined shell. If the oracle cannot
be run, report the acceptance as `NOT RUN` with the error verbatim; do not report a pass you did not see.

### Task 3 — unstructured: an invariant audit across non-covered files  (tier 3)

Report every line in `plugin/tests/fixtures/classifier-goldens.json` and
`scripts/verification-golden.cjs` matching:

```
/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]{10,}/
```

and state each line number. Acceptance: the answer names **9** matches in `classifier-goldens.json` and
**0** in `verification-golden.cjs`.

### Telemetry to report

For each task: the log window (`startLine` / `endLine`), `sourceRead`, `declarationsServed`, `turns`,
`wallClockSec`, and whether acceptance passed — every count confined to that task's window.

```
RUN: declarations
GATE: LIVE_BEFORE <n> / sourceRead <n> / declarationsServed <n> / contentWas skeleton
TASK 1
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed
TASK 2
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed
TASK 3
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed

NOTES: <anything that prevented a clean measurement, stated verbatim>
```

**Report your own mistakes.** If you read a file you were told not to, or counted a debugging read as a
task window, write it in NOTES. A run reported accurately with a caveat is usable; a run reported cleanly
and wrongly is not.

### Rules

- `readsRefused` is **NOT MEASURABLE**. Do not derive it arithmetically from the other columns.
- A failed task is reported **with its numbers**, never retried until it passes.
- Do not interpret the results, and do not compare tiers against each other. Report numbers and stop.
- When you are done, **do not** try to revert the profiles from inside this session. Restoring the machine
  to its normal state needs a plain PowerShell window and cannot be done from here; a separate operator
  step covers it. Just stop and report.

### Three instrument facts, so they do not waste your time

- **A refused read emits no trace event at all.** A window under arm B containing two refused commands
  held only `HOOK_EXIT` and `CONTEXT_QUALITY`.
- **The guard refuses commands that merely NAME source files, without reading them.** Under arm B a shell
  command containing a literal `.js` path is refused even when it opens nothing. This is a known false
  positive, not a fault in your command. Rephrase to avoid naming source paths, or record the refusal
  verbatim and move on.
- **Only four extensions are redirected**: `.ts .tsx .js .jsx`. A read of `.json`, `.cjs`, `.md`, `.yml`,
  `.py`, `.go`, `.sh`, `.sql` is served **raw** in both arms. Do not record such a read as a governance
  success — it is the boundary being measured.
