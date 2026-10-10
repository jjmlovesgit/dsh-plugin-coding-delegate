# Run 3 - re-arm, restart, then arm B telemetry

This file covers two separate sessions and one restart. Follow the order exactly.

Do not commit anything.

---

## Part 0 - check the profile baseline, and do NOT re-copy it

**Corrected.** An earlier version of this file told you to copy `cordis.patch.yml` to
`cordis.patch.yml.pre-benchmark` before re-arming. **Do not do that now.** The premise was stale: the
`.pre-benchmark` and `.bak-egressbench` files on this machine are already byte-identical to each other
(SHA-256 `A58D4506…` for `tauri`, `81642D8D…` for `web`), both written 16:06, and the live profiles are
**already armed for arm B**. Re-running the copy would overwrite the only clean arm-A baseline with the
arm-B file and destroy the thing `-Revert` exists to restore.

Verify the baseline is intact and that no copy is needed - this only reads:

```powershell
foreach ($d in 'tauri','web') {
  $p = "$env:USERPROFILE\.dsh\profiles\$d\cordis.patch.yml"
  "=== $d ==="
  foreach ($f in 'cordis.patch.yml','cordis.patch.yml.pre-benchmark','cordis.patch.yml.bak-egressbench') {
    $fp = Join-Path (Split-Path $p) $f
    if (Test-Path $fp) {
      "  {0,-42} {1}  {2,6}B  {3}" -f $f,
        (Get-FileHash $fp -Algorithm SHA256).Hash.Substring(0,16),
        (Get-Item $fp).Length, (Get-Item $fp).LastWriteTime.ToString('MM-dd HH:mm')
    } else { "  {0,-42} MISSING" -f $f }
  }
  "  ACTIVE sourceReadEgress key: " + (Select-String -Path $p -Pattern '^\s*sourceReadEgress:' -Quiet)
}
```

Expected shape, and what it means:

| observation | meaning |
| --- | --- |
| `.pre-benchmark` and `.bak-egressbench` share a hash | the baseline is intact; **no copy needed** |
| `ACTIVE sourceReadEgress key: True` | the profile is already armed for arm B |
| the two differ, or a file is MISSING | the baseline is damaged - stop and rebuild it from git history before running |

If a `.pre-benchmark` file is ever missing, recover the pre-benchmark state from the arm-A shape in the
commented block inside the profile file rather than copying the live (arm-B) file over it.

---

## Part 1 - re-arm the profiles (run in a PLAIN PowerShell terminal, not in a DSH session)

The profiles are **already armed for arm B** as this is written (both carry an active `sourceReadEgress`
key). Running the script now is therefore expected to report `already patched` and change nothing, which
is the correct and safe outcome - it is idempotent. Run it anyway to confirm the state rather than trust
this paragraph:

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

Rules are the same as run 2, with two corrections established by run 2's direct observation:

- `readsRefused` is **NOT MEASURABLE**, not merely unmeasured. A window containing two refused commands
  was closed under arm B and contained **zero** refusal events - only `HOOK_EXIT` and `CONTEXT_QUALITY`.
  A refusal emits no trace at all, so this number cannot be recovered from the log and must not be
  derived arithmetically from the other columns. Report it as `NOT MEASURABLE`.
- A read of `.json`, `.cjs`, `.md` or `.yml` is served **raw** in both arms - those extensions are
  outside the four the control covers. Do not record such a read as a governance success.
- Expect the guard to refuse commands that merely **name** source files, without reading them. This is a
  known false positive, not a fault in your command: under arm B, a shell command containing a literal
  `.js` path is refused even when it opens nothing. Rephrase to avoid naming source paths, or accept the
  refusal and note it verbatim.

A failed task is reported with its numbers rather than retried; nothing is interpreted.

### Expect this in arm B

A read of a covered `.ts` file returns the compiled type skeleton, not the source. That is the
condition being measured, not an error. Note it and continue.

A read of `.json`, `.cjs`, `.md` or `.yml` returns the **raw file** in both arms - those extensions are
outside the control. If task 3 is satisfied by a search rather than a read, it will emit no read events
at all; that is a fact about the task, not about the control, and should be reported as such.

*For execution gates, DLP confound isolation, and Protocol Run 3 logging standards, refer directly to `run-3-arm-b-addendum.md`.*

---

## Part 3 - restore afterwards

Arm B is not the machine's normal state. When the runs are finished, either:

```
.\enable-egress-declarations.ps1 -Profile tauri -Revert
.\enable-egress-declarations.ps1 -Profile web -Revert
```

which restores the pre-benchmark backups, or re-comment the two key lines in both profile files. Then
restart DSH.
