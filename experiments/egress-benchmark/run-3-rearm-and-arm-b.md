# Run 3 - re-arm, restart, then arm B telemetry

This file covers two separate sessions and one restart. Follow the order exactly.

Do not commit anything.

---

## Part 1 - re-arm the profiles (run in a PLAIN PowerShell terminal, not in a DSH session)

Both profiles currently have the egress keys **commented out** (the arm-A shape). The switch script
detects an *active* key, so it will patch correctly over the comments.

```
cd C:\Projects\DSHLaya\experiments\egress-benchmark
.\enable-egress-declarations.ps1 -Profile tauri
.\enable-egress-declarations.ps1 -Profile web
```

Both are patched because which profile the host loads could not be determined from inside a session.
Only the loaded one takes effect, and both now pin the same arm, so either boot lands in arm B.

Each run must end with `OK: both keys are inside local-router.config and the original keys survive`.
If either reports `already patched`, the keys are still active from a previous run - that is fine.

**Then restart DSH, fully exiting the host process.** Plugin options are read once at registration.

---

## Part 2 - arm B telemetry (fresh session)

### Step 0 - gate. This is the only thing that proves the arm.

```
$log = "$env:USERPROFILE\.dsh\local-router\router-debug.log"
$before = (Get-Content $log | Measure-Object).Count
```

Read `plugin/src/declaration-egress.ts` **once** and check the content:

- **type skeleton** (`export declare function`, stripped bodies, or the banner
  `SERVED AS TYPE DECLARATIONS`) -> arm B. Continue.
- **raw source** -> **STOP.** Report one of two things and run nothing:
  - `STILL ARM A` if the log grew, or
  - `PLUGIN NOT LOADED` if the log line count did not change.

The content alone cannot distinguish arm A from a host where the plugin is not loaded. The log is what
separates them.

Then count, from lines after `$before` only:

```
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_READ ===').Count
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_DECLARATION_SERVED ===').Count
```

Arm B is confirmed by **a type skeleton returned AND `SOURCE_DECLARATION_SERVED >= 1`.** A skeleton
alone is not enough: confirm the served event as well.

Report `LIVE_BEFORE` and both counts before continuing.

### Steps 1-7

Identical to run 2, with one change to the output heading. Everything else - the task list, the window
counting, the acceptance commands, the resets - is the same procedure.

```
RUN: declarations
GATE: LIVE_BEFORE <n> / sourceRead <n> / declarationsServed <n> / contentWas skeleton
TASK 1
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed
TASK 2
  ...
TASK 3
  ...

NOTES: <anything that prevented a clean measurement, stated verbatim>
```

Rules are the same as run 2: `readsRefused` is **NOT MEASURED** and must not be derived
arithmetically; a failed task is reported with its numbers rather than retried; nothing is interpreted.

### Expect this in arm B

A read of a covered `.ts` file returns the compiled type skeleton, not the source. That is the
condition being measured, not an error. Note it and continue.

A read of `.json`, `.cjs`, `.md` or `.yml` returns the **raw file** in both arms - those extensions are
outside the control. If task 3 is satisfied by a search rather than a read, it will emit no read events
at all; that is a fact about the task, not about the control, and should be reported as such.

---

## Part 3 - restore afterwards

Arm B is not the machine's normal state. When the runs are finished, either:

```
.\enable-egress-declarations.ps1 -Profile tauri -Revert
.\enable-egress-declarations.ps1 -Profile web -Revert
```

which restores the pre-benchmark backups, or re-comment the two key lines in both profile files. Then
restart DSH.
