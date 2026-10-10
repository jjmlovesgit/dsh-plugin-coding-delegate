# Run 3 addendum — the third gate, and the observables that actually exist

Read order (pointer lineage):

```
turn-3-arm-b.md            one line: read and execute run-3-rearm-and-arm-b.md
run-3-rearm-and-arm-b.md   Part 0 baseline check · Part 1 re-arm + restart · Part 2 arm B telemetry · Part 3 restore
run-3-arm-b-addendum.md    this file: the delta to Part 2, and the write target for its results
```

**Scope.** This file changes three things about Part 2 of `run-3-rearm-and-arm-b.md`: it adds a third
gate, it replaces the instruments and observables, and it names the PROTOCOL.md target the results go
into. It does **not** restate or alter Step 0's content check, the task list, the window procedure, the
resets, the acceptance commands, Part 1's re-arm procedure, Part 3's restore, or the
`readsRefused: NOT MEASURABLE` rule.

**Standing rule.** Where this file and `run-3-rearm-and-arm-b.md` disagree, this file wins, and the
disagreement is recorded as a `NOTES:` line in the run's output rather than silently resolved.

---

## 1. Protocol structure and audit target

### 1.1 The target heading is new, and append-only

```
## Run 3 — re-armed, arm B measured
```

PROTOCOL.md is 572 lines and its final section is `## Recording the result` (lines 567–572). Append the
Run 3 block **after the end of the file**, after that closing section. Do not insert it inside
`## Results`, do not renumber anything, and do not retitle an existing heading to accommodate it.

A level-2 heading deliberately sits as a sibling of `## Results` rather than a `###` inside it: Run 3 is
a new record, not an amendment to the block Run 2 lives in. The cost of that choice is accepted and
stated — a reader walking `## Results` will not meet Run 3 there, so 1.3 requires a one-line pointer
instead of a rewrite.

### 1.2 Pointer lineage

| file | role |
| --- | --- |
| `turn-2-arm-a.md` | one line: read and execute `run-2-arm-a.md` |
| `turn-3-arm-b.md` | one line: read and execute `run-3-rearm-and-arm-b.md` |
| `run-2-arm-a.md` | arm A procedure (Step 0 gate, Steps 1–7, output shape, rules) |
| `run-3-rearm-and-arm-b.md` | Part 0 baseline check · Part 1 re-arm + restart · Part 2 arm B telemetry · Part 3 restore |
| `run-3-arm-b-addendum.md` | this file — the delta to Part 2 |
| `run-3-session-gate.cjs` | the session-scoped instrument 2.3 and 4.3 require |

`turn-3-rearm-and-arm-b.md` does not exist. If that name appears in a checklist or a terminal
transcript, it is a broken pointer and the file above is the one meant.

### 1.3 Run 2 stays verbatim

Nothing in this list may be edited, moved, retitled or annotated, including its own admission of
failure:

- `### Run 2 — cold-boot verified (arm A only; arm B not measured)` (line 236)
- `### Arm A — sourceReadEgress: 'source' (the ungated baseline)` (line 419)
- `### Instrument notes discovered during the run` (line 446)
- `### Measured directly, without sessions: what the skeleton actually contains` (line 483)
- `### Arm B — first attempt, voided, superseded by the run tabulated above` (line 525)

Run 2 records that arm B was **not measured** and that its one attempt was **voided**. Filing new arm-B
numbers under a Run 2 heading would assert a measurement the document states was never taken, and
would destroy the void record that makes the gap legible. Run 3 exists so that neither is necessary.

The single permitted touch is a pointer line appended to the Run 3 block: *"Supersedes nothing in Run 2,
which recorded arm B as not measured."*

### 1.4 What Run 3 may claim

Arm B telemetry, for the first time. If arm A is re-taken in the same session, label it `Run 3 arm A`
and say so; those numbers are not Run 2's and must not be compared across run labels without stating
that the boot, the profile state and the session differ.

---

## 2. The third gate — DLP confound isolation

### 2.1 Why a third gate exists

The profile runs `dlpAction: 'local'`, so a credential-shaped payload is pinned to `lm-studio` /
`qwen/qwen3.8-27b` rather than refused. The gate that decides this accumulates **every user-message
text the session has seen** and is sticky by design — the code says so in as many words: *"Accumulating
makes the gate sticky instead"* (`plugin/src/index.ts`, the `sessionPromptCorpus` block, which also caps
the corpus at 200 000 characters, tail-kept). The consequences are exactly the ones the other two gates
cannot see:

- **One trip contaminates the rest of the session.** Not one request: every later request in that
  session is pinned, until the session ends. A trip in task 1 therefore changes the model under
  measurement for tasks 2 and 3 as well.
- **The pin is silent.** It reaches `router-debug.log` and nowhere else — no session-visible marker, no
  error in the conversation. A contaminated arm still looks like a completed run.
- **The failure mode changed on 2026-10-10, and got quieter.** `fcb9340` makes the plugin drop the
  stored `reasoningEffort` when a pin lands on the local worker. Before it, a pinned request was refused
  by the host before any network I/O (`UNSUPPORTED_REASONING_EFFORT`), which at least announced itself.
  After it, the same pin **succeeds** on the local model. Availability improved; measurability did not.

Since `SOURCE_READ` and `SOURCE_DECLARATION_SERVED` count read events inside the control, neither can
detect a route change. Hence a third count, taken in the same windows as the other two.

### 2.2 The two directions, and which is authoritative

| direction | instrument | scope | what it can say | what it cannot |
| --- | --- | --- | --- | --- |
| log | `router-debug.log`, window-bounded counts of `=== DLP_FIREWALL_TRIPPED ===` and `=== HOOK_EXIT: DLP_PINNED_LOCAL (agent/request) ===` | whole host, window-bounded | a pin happened in this window | **whose** — these blocks carry `role`, `roleReason`, `provider`, `model`, `uncappedContextWindow`, `toolsCount` and no session id |
| store | the session's own `request/header` and `turn/end` records, via `run-3-session-gate.cjs` | this session only | the provider and model this session dispatched per request, and how every turn ended | whether a request that was *refused* ever existed (see 4.4) |

Both are required, and they answer different questions. When they disagree, record the disagreement as a
raw `NOTES:` line — do not resolve it by choosing the instrument that gives the cleaner answer.

### 2.3 Pre/post counts, in the same idiom as the existing gate

PRE, at the Step 0 gate, immediately after `$before` is taken (`run-3-rearm-and-arm-b.md`, Part 2 Step 0):

```powershell
$log = "$env:USERPROFILE\.dsh\local-router\router-debug.log"
$before = (Get-Content $log | Measure-Object).Count
# ... existing SOURCE_READ / SOURCE_DECLARATION_SERVED counts here ...
(Get-Content $log | Select-Object -Skip $before | Select-String '=== DLP_FIREWALL_TRIPPED ===' -SimpleMatch).Count
(Get-Content $log | Select-Object -Skip $before | Select-String '=== HOOK_EXIT: DLP_PINNED_LOCAL (agent/request) ===' -SimpleMatch).Count
```

POST, at every window close, using that window's `START_n` exactly as the other two counts already do:

```powershell
(Get-Content $log | Select-Object -Skip START_n | Select-String '=== DLP_FIREWALL_TRIPPED ===' -SimpleMatch).Count
(Get-Content $log | Select-Object -Skip START_n | Select-String '=== HOOK_EXIT: DLP_PINNED_LOCAL (agent/request) ===' -SimpleMatch).Count
```

`-SimpleMatch` is not decoration: the second pattern contains parentheses, which `Select-String` would
otherwise read as regex groups.

### 2.4 Arm A — verbatim tasks, and a zero-pin baseline

**Task text runs 100% verbatim, including the credential regex in `benchmark-tasks.json:78`.** Do not
paraphrase, redact, pre-scan-and-rewrite, or "clean" any instruction. Four reasons, in order of weight:

1. A scrubbed task measures a different task, and the tier deltas in Run 2 were computed from the
   literal texts.
2. `run-2-arm-a.md` Step 1 already requires it: *"Each task's `instruction` field is the literal task
   text — use it verbatim."*
3. The gate's purpose is to **detect** contamination, not to prevent it by editing the input. Editing
   the input destroys the observation and leaves the confound unmeasured.
4. Whether the task-3 regex literal trips the classifier is **not established**. It is a regex source
   containing `sk-[A-Za-z0-9]{16,}` (with `{16,}`, not 16 real characters) and `BEGIN [A-Z ]*PRIVATE
   KEY` (without the `-----` fence), so a strict rule may ignore it. That is a measurement this gate
   takes, not a fact to be assumed in either direction.

Arm A's baseline is clean only when **both** of these are zero, over the whole session:

```
DLP_FIREWALL_TRIPPED = 0        and        HOOK_EXIT: DLP_PINNED_LOCAL = 0
```

and the session-scoped gate reports no `lm-studio` request header and no
`UNSUPPORTED_REASONING_EFFORT` turn (2.2, 4.3). Any non-zero reading means the baseline was
contaminated by a silent local drop: report the window as `CONTAMINATED`, keep its numbers, and do not
retake it to obtain a clean one.

### 2.5 Arm B — the deliberate trigger, and what it must show

The trigger is a **labelled deliberate action**, not an accident: it is the only way to exercise the pin
path on purpose. Announce it, timestamp it, and expect everything after it in that session to run on the
local worker.

Record, per 4.3:

- the triggering prompt's line offset in `router-debug.log`;
- the first `request/header` naming `lm-studio` after it, and whether that config carries
  `reasoningEffort`;
- the `turn/end` that follows it.

### 2.6 Failure handling

A contaminated window is reported with its numbers and its flag. It is not retried (Run 2's rule: *"If a
task fails, report the failure and the numbers anyway. Do not retry to make it pass."*), and its cause is
not speculated about.

---

## 3. Instruments and observables

### 3.1 The ledger is the only source of tokens, cost and rate

```
$env:USERPROFILE\.dsh\local-router\savings-ledger.json
```

Top level: `totalTurns`, `totalTokens`, `localTurns`, `cloudTurns`, `architectTurns`, `workerTurns`,
`failoverTurns`, `totalLocalTokens`, `totalCloudTokens`, `totalSpendUSD`, `totalCostUSD`,
`totalCloudEquivUSD`, `delegations`, `failedDelegations`, `bytesKeptOut`, `recentEvents`, `history`,
`scope`. Each `history` record carries:

```
turn · timestamp · route · provider · model · routingReason · promptTokensEst · completionTokensEst ·
totalTokensEst · cacheHitRateEst · costUSD · cloudEquivUSD · outcome · succeeded · bytesWritten ·
elapsedMs · tokensPerSecond
```

Record **`promptTokensEst`, `completionTokensEst`, `totalTokensEst`, `cloudEquivUSD`, `elapsedMs`,
`tokensPerSecond`** per window, with `timestamp`, `route`, `provider`, `model`, `routingReason`,
`outcome` and `succeeded` for attribution. `cloudEquivUSD` is the avoided plan exposure the run reports;
it is not money saved.

### 3.2 `tokensPerSecond` is end-to-end throughput

It is `completionTokensEst / (elapsedMs / 1000)` — verified on the newest record at the 2026-10-10
audit: `2414 / 20.144 = 119.8`, exactly the recorded value. It therefore includes prefill, queueing and
the whole request round trip.

**Label it `e2e` wherever it is quoted.** Do not write "decode throughput" beside it, do not compare it
with a decode-only figure, and do not present it as a model capability. `SECURITY-REVIEW-2.md:313`
measured decode-only at 218.7 tok/s against an apparent 98.8 tok/s on this same model, so the two
numbers differ by more than 2× and conflating them is a false result, not a rounding difference.

### 3.3 Barred instruments

- **`[WORKER_BENCH]` is a static reference table, not a measurement.** It is `WORKER_BENCHMARKS` in
  `plugin/src/profiles.ts:111-130`, sourced *"measured 2026-10-06 on the author's reference rig /
  LM Studio, temperature 0, single stream"*, printed once at plugin init
  (`plugin/src/index.ts:891-912`). It prints the same values in both arms and cannot report a run's
  throughput. It is also absent from every log on this machine: 0 matches across the eight files in
  `%APPDATA%\dsh-tauri\logs` and 0 in `router-debug.log`. Quoting it as run telemetry would be a
  static table presented as a measurement.
- **TTFT** does not exist in this plugin, in the ledger, or in any log. There is no field for it.
- **Decode-only rate** does not exist either; the only rate is 3.2's e2e figure.

Record both as `NOT MEASURABLE — NOT IMPLEMENTED`. Do not substitute `elapsedMs`, `tokensPerSecond`,
`[WORKER_BENCH]` or anything else for them; a substitute reported under the right label is still a
fabricated number.

### 3.4 Attribution limits of the ledger

Ledger records carry **no session id**. Attribution is by timestamp window plus `route`, `provider`,
`model` and `routingReason`, and it is therefore approximate when more than one session is live — note
that as a limit rather than presenting the window as exact. The `scope` key bounds what the file covers;
state its value with the results.

### 3.5 The session-scoped gate

```powershell
node experiments\egress-benchmark\run-3-session-gate.cjs `
  "$env:USERPROFILE\.dsh\sessions\--C-Projects-DSHLaya--\<session-id>\session.v3.jsonl.zstd" `
  --expect cloud      # arm A;  --expect local for arm B after the trigger
```

`--expect cloud` fails the gate if any request in this session was dispatched to `lm-studio`.
`--expect local` requires at least one such request and requires that none of them still carries
`reasoningEffort` (the `fcb9340` signature). Independently of `--expect`, the script always asserts the
trailing turn completed and that no turn ended `UNSUPPORTED_REASONING_EFFORT`; with no `--expect` it makes
no claim about the route at all. Exit codes: `0` the recorded facts match, `1` they do not, `2` the file
could not be read as a session store.

It asserts over the **whole session**, which is why the arm session must be fresh — the same prerequisite
`run-2-arm-a.md` already imposes ("DSH was restarted before this session"). A session that is not fresh
cannot be gated by this script; that is a stop condition, not something to work around by editing the
store.

Run it as a direct `node <file>`. `node --test` is denied in this sandbox (`spawn EPERM`), the same
limitation `run-2-arm-a.md` records for the acceptance commands.

---

## 4. The trailing `turn/end` assertion

### 4.1 Why the HTTP status check is void

The assertion *"zero 400 Bad Request"* cannot detect the failure it targets. A pinned request carrying
an unsupported effort is refused by the host **before any network I/O** — the plugin's own repair script
records this in its header — so no HTTP request is made and no status exists to count. A run with the bug
fully present reports **zero** 400s and passes the check.

The failure is a session-level record, and that is what gets asserted.

### 4.2 The measured pre-`fcb9340` signature

From the real store of `session-f0387683` (the 2026-10-10 incident), via `run-3-session-gate.cjs`:

```
session      : session-f0387683-dc72-4916-920a-6721daee8aba
frames       : 14197   records: 25087
requests     : 51   turns: 372

dispatched providers (request/header, in order):
    49  deepseek-official / deepseek-chat
     2  deepseek-official / deepseek-flash

DLP pin evidence (session-scoped):
  requests to lm-studio                       : 0
  ...of those still carrying reasoningEffort : 0

turn outcomes:
  UNSUPPORTED_REASONING_EFFORT : 5   <- the fatal pin, pre-fcb9340
  other error turns                : 0
  trailing turn/end                : turn 372  reason={"kind":"completed"}

saved selection (last model/selection governs every later request):
  {"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"}

GATE: 5 turn(s) ended UNSUPPORTED_REASONING_EFFORT          (exit 1)
```

That exit code is the gate working: this store legitimately fails it, because the five failures are
historical and predate `fcb9340`. It is quoted whole so the gate's behaviour on a contaminated session is
visible before the run rather than discovered during it.

Read the first two blocks together: **five pinned turns, zero `lm-studio` request headers.** A refused
request writes no header, because it never reached dispatch. This is measured, not inferred, and it
governs 4.4.

### 4.3 The post-`fcb9340` signature this run asserts

Arm B, after the deliberate trigger, asserts all four:

1. `run-3-session-gate.cjs` reports at least one `request/header` whose `provider` is `lm-studio`;
2. none of those headers carries `reasoningEffort` — the field is absent, not `null`, not renamed;
3. the trailing `turn/end` has `data.reason.kind === 'completed'`;
4. no `turn/end` in the window carries
   `data.reason.error.code === 'UNSUPPORTED_REASONING_EFFORT'`.

Arm A asserts the complements: zero `lm-studio` headers, zero `UNSUPPORTED_REASONING_EFFORT` turns, and
a completed trailing turn.

The prediction in (1) and (2) is a prediction. Before the fix the pin produced *no* header (4.2); it has
never been observed on this machine that a *successful* pin writes one. If arm B shows zero `lm-studio`
headers with a completed trailing turn and no `UNSUPPORTED_REASONING_EFFORT`, report exactly that — the
pin left no trace in this session — and do not report it as "the pin did not happen". The log direction
in 2.2 is what establishes that it did.

### 4.4 What the store can and cannot say

- `request/header` → `data.header.config` carries `provider`, `model`, `reasoningEffort`, `maxTokens`:
  the dispatched route per request.
- `turn/end` → `data.turn` and `data.reason` (`{kind:'completed'}` or
  `{kind:'error', error:{code, message}}`).
- `model/selection` → the saved provider/model/effort. The **last** one governs every later request in
  the session, which is why removing an effort from `settings.yaml` does not clear a session that
  already saved one.

**A `request/header` is positive-only evidence.** Its presence proves a dispatch; its absence proves
nothing, since a refused request never writes one (4.2). Zero local headers must never be reported as
"no pin occurred" on a build without `fcb9340`; on such a build the pin's only session-scoped trace is
the `UNSUPPORTED_REASONING_EFFORT` turn.

Frame note: the store is a concatenation of independent Zstandard frames — one for the header, one per
append batch, descriptor `0x04` (content checksum set). `zlib.zstdDecompressSync` decodes only the first
frame, which is why the gate walks the `28 B5 2F FD` magic offsets. Node's own `zstdCompressSync` writes
descriptor `0x20`; a log carrying those frames is not the byte stream this host produces.

---

## 5. What to append, and in what shape

Append to PROTOCOL.md, after line 572, under the 1.1 heading. Extends `run-2-arm-a.md` Step 7 with the
third count and the ledger fields. `NOT MEASURABLE` lines are part of the record, not omissions.

```
RUN: declarations (arm B, re-armed)
GATE: LIVE_BEFORE <n> / sourceRead <n> / declarationsServed <n> / contentWas skeleton
      dlpTripped <n> / dlpPinned <n> / sessionLocalHeaders <n> / sessionUnsupportedTurns <n>
TASK 1
  startLine / endLine / sourceRead / declarationsServed / turns / wallClockSec / acceptancePassed
  dlpTripped_window / dlpPinned_window / contaminated <yes|no>
  promptTokensEst / completionTokensEst / totalTokensEst / cloudEquivUSD / elapsedMs / tokensPerSecond (e2e)
TASK 2
  ...
TASK 3
  ...
SESSION
  trailingTurnEnd reason=<completed|...> / lmStudioHeaders <n> / headersCarryingReasoningEffort <n>
  ledgerScope <value>

NOTES:
  TTFT: NOT MEASURABLE — NOT IMPLEMENTED
  decode-only throughput: NOT MEASURABLE — NOT IMPLEMENTED
  readsRefused: NOT MEASURABLE (a refusal emits no trace; do not derive it by subtraction)
  <any disagreement between this addendum and run-3-rearm-and-arm-b.md, stated verbatim>
  <anything that prevented a clean measurement, stated verbatim>
```

---

## 6. Rules

Carried unchanged from `run-2-arm-a.md` and `run-3-rearm-and-arm-b.md`:

- Report a failed task with its numbers; do not retry it to make it pass.
- Do not speculate about what the numbers mean. Report them.
- `.json`, `.cjs`, `.md` and `.yml` reads are served **raw in both arms** — outside the four extensions
  the control covers. Do not record such a read as a governance success.
- Expect the guard to refuse commands that merely **name** a source path. That is a known false positive;
  rephrase the command or record the refusal verbatim.
- One fresh session per arm. A session that has been pinned stays pinned for its life.

Added by this addendum:

- **Never scrub or paraphrase a task instruction.** Task text is data, not prompt material to be
  sanitised. Arm A's tier deltas depend on the literal text.
- **A pin is a confound, not an error to absorb.** One trip re-routes every later request in that
  session, so a contaminated window invalidates that window's model-dependent columns — turns, wall
  clock, tokens, `cloudEquivUSD` — even when the acceptance check still passes.
- **No decode, no TTFT, no `[WORKER_BENCH]`.** The only rate this machine produces is e2e.
- **Report the gate's negative space.** Zero local headers is not evidence of a clean session on a build
  without `fcb9340`; say which build was loaded (`git rev-parse --short HEAD` in the repo) beside the
  numbers, because the pin's observable differs between them.
