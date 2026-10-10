# Run 2 - arm A telemetry (`sourceReadEgress: 'source'`)

Prerequisites, both required:

1. **DSH was restarted** before this session, fully exiting the host process.
2. **Run 1 reported `grew: yes` and `read content: raw source`.** If run 1 reported `grew: no`, stop -
   the plugin is not loaded and this run would produce numbers that look like arm A while measuring
   nothing.

Do not edit any profile. Do not commit anything.

## Step 0 - gate, repeated here so this file stands alone

```
$log = "$env:USERPROFILE\.dsh\local-router\router-debug.log"
$before = (Get-Content $log | Measure-Object).Count
```

Read `plugin/src/declaration-egress.ts` **once** and check the content:

- **raw source** (a real body for `evaluateDeclarationEgress`) -> arm A. Continue.
- **type skeleton** (`export declare function`, stripped bodies, or the banner
  `SERVED AS TYPE DECLARATIONS`) -> arm B. **Stop**, report `STILL ARM B`, run nothing.

Then count, from lines after `$before` only:

```
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_READ ===').Count
(Get-Content $log | Select-Object -Skip $before | Select-String '=== SOURCE_DECLARATION_SERVED ===').Count
```

Arm A is confirmed by **raw source returned AND `SOURCE_READ >= 1` AND
`SOURCE_DECLARATION_SERVED = 0`.** The `SOURCE_READ >= 1` condition is what distinguishes arm A from a
host where the plugin is not loaded - without it, "nothing was served" and "nothing is running" look
identical.

Report `LIVE_BEFORE` and both counts before continuing.

## Step 1 - read the task list

```
experiments/egress-benchmark/benchmark-tasks.json
```

Use the `tasks` array. Each task's `instruction` field is the literal task text - use it verbatim. Do
**not** read the `expected`, `hypothesis`, or `decisionRule` blocks.

## Steps 2-5 - one task at a time

For each of the three tasks:

**Record the window start**

```
(Get-Content $log | Measure-Object).Count      # START_n
(Get-Date -Format o)                            # T_START_n
```

**Run the task**, then its acceptance command:

```
cd plugin
npm run build
node tests/oracles/declaration-egress-scope.test.cjs
```

`node --test` is denied in this sandbox (`spawn EPERM`). Use the direct `node <file>` form above.

**Record the window end and count inside it**

```
(Get-Content $log | Measure-Object).Count      # END_n
(Get-Date -Format o)                            # T_END_n
(Get-Content $log | Select-Object -Skip START_n | Select-String '=== SOURCE_READ ===').Count
(Get-Content $log | Select-Object -Skip START_n | Select-String '=== SOURCE_DECLARATION_SERVED ===').Count
```

**Reset before the next task, every time**

```
git checkout -- plugin/src/declaration-egress.ts
git checkout -- plugin/dist/
git status --short          # must be clean before the next task
```

Tasks 1 and 2 edit the same file. Without the reset, task 2 inherits task 1's edit and is no longer
comparable with the same task in the other arm.

## Step 6 - task 3's answer

State the answer and every matching line number. That file is a wrapper object with an `entries`
array, not a bare array.

## Step 7 - output, and nothing else

```
RUN: source
GATE: LIVE_BEFORE <n> / sourceRead <n> / declarationsServed <n> / contentWas raw
TASK 1
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed
TASK 2
  ...
TASK 3
  ...

NOTES: <anything that prevented a clean measurement, stated verbatim>
```

## Rules

- Report `readsRefused` as **NOT MEASURED**. Do not compute it as attempted minus served: a refused
  read never emits `SOURCE_READ`, so that arithmetic returns 0 no matter how many were refused.
- If a task fails, report the failure and the numbers anyway. Do not retry to make it pass.
- Do not speculate about what the numbers mean. Report them.
- Writing `plugin/src/*.ts` from the cloud context is blocked by the guard, so an edit may have to be
  dispatched to the local worker. That is expected and does not affect the measurement, which counts
  the architect's reads.
