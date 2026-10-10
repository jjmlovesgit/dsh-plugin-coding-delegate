# Run 1 - plugin registration check (do this first, in a fresh session)

**Before this session: restart DSH, fully exiting the host process.** A plugin's options are read
once at registration, so nothing you change outside is live until the host restarts.

Purpose: determine whether the `local-router` plugin is **loaded at all** in this host. A previous run
produced raw source and zero log lines, which is consistent with *both* the ungated arm and *the plugin
being absent*. Those look identical from a file read, and telling them apart is the whole point of this
run.

Do not run any benchmark task. Do not edit any profile. Do not commit anything.

## Step 1 - is the trace log being written?

```
$log = "$env:USERPROFILE\.dsh\local-router\router-debug.log"
"mtime : " + (Get-Item $log).LastWriteTime.ToString('HH:mm:ss')
"lines : " + (Get-Content $log | Measure-Object).Count
"now   : " + (Get-Date -Format 'HH:mm:ss')
```

Record all three.

## Step 2 - do a covered read, then re-check the log

Read `plugin/src/declaration-egress.ts` **once**, with the read tool.

Then re-run the Step 1 command block. Compare the line count to before.

**The line count must have grown.** If it did not, the plugin is not writing traces and this run ends
at Step 3.

## Step 3 - report, and stop

Output exactly this block and nothing else:

```
PLUGIN CHECK
mtime before / lines before
lines after the read
grew: yes|no
read content: raw source | type skeleton
tree clean: yes|no
NOTES: <verbatim, anything unexpected>
```

Then stop. Do not proceed to any task.

## How the result is read

| line count grew | read content | meaning |
| --- | --- | --- |
| yes | raw source | **arm A is live** - proceed to run 2 |
| yes | type skeleton | **arm B is live** - the profiles were not parked in the arm-A shape; report and stop |
| **no** | either | **the plugin is not loaded.** This is a configuration problem, not a benchmark result. Nothing further can be measured until it is fixed |

If the count did not grow, check DSH's own plugin or settings surface and confirm
`dsh-plugin-coding-delegate` (bundle entry id `local-router`) is **enabled** for the profile this host
booted. That surface is outside this repository and outside what an agent in this session can inspect.
