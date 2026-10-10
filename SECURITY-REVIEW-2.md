# Security review response, second review

Response to the external static review of the plugin that reported **19 findings**. The review document
itself is an external artifact and is not committed here, as with the first response.

This is the second such document. [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) answers a **different,
earlier** review of revision `7c5d635` (5 findings: 2 high, 3 medium) and is unchanged by this one. The
two are not versions of each other, and this file is not a superseding edit of that one.

Audited against the working tree at `66214c7`, with `README.md` modified and uncommitted. Every verdict
below is from reading the current source. The line numbers cited were resolved in that tree.

## How the 19 findings were read

The report's 19 findings are **9 distinct root causes**, and several of the duplicate pairs are far
apart in its numbering. This mapping is stated first because a response that answers 19 headers instead
of 9 causes would triple the document and hide that the same defect was counted two or three times.

| Root cause | Report findings | Report severity | Verdict here |
| --- | --- | --- | --- |
| Cloud-only routing pins a block to the cloud | 1, 5 | high | **Fixed** |
| Model-controlled attestation certifies unrelated files | 2, 4 | high | **Fixed** |
| Caller-selected `workspaceDir` defeats containment | 3 | high | **Fixed** |
| Delegated read guard misses `gc` and scope-free searches | 6, 9 | medium | **Half fixed** — `gc` fixed, scope-free open |
| Context budget checked after whole-file read | 7, 12 | medium | **Confirmed, not fixed** |
| Declarations mode serves raw source by other routes | 8, 10 | medium | **Fixed** |
| Shell guard misses runtime-computed source paths | 11, 14 | medium | **Confirmed, not fixed** — by design |
| Request DLP omits host-assembled content | 13, 15 | medium | **Confirmed, not fixable here** |
| Verification allowlist matches basename, runs full command | 16, 17 | medium | **Confirmed, not fixed** — documented trade |
| Evicting old delegated records removes read protection | 18 | low | **Confirmed, not fixed** |
| Blocked prompt prefixes retained in the debug log | 19 | low | **Confirmed, not fixed** |

## Fixed in the current tree

### Findings 1 and 5 — cloud-only routing defeats DLP and source egress

The reroute was committed on an entropy hit alone. In the documented cloud-only setup — where
`localProvider` and `cloudProvider` are the same id, because a user with no GPU points both at the cloud
— "reroute to local" pinned the payload to the provider it was supposed to be kept away from, and the
trace labelled that egress local.

**Fixed** by `classifyDestination` (`plugin/src/routing.ts`), which takes `provider`, `localProvider`,
`cloudProvider`, `dlpTripped`, `entropyOnly` and `dlpAction` as explicit inputs and returns the
destination. Provider-**id equality** is no longer the test; the policy is. A reroute requested with no
distinct local provider is **refused** rather than pinned to the cloud.

The predicate is asserted by `plugin/tests/oracles/routing-locality.test.cjs` (13 behavioural
assertions, 5 structural). Commits: `c92888a` (classifier, unwired), `ca2ec3a` (wired),
`30e9725` (cloud-only path refuses rather than pins).

### Findings 2 and 4 — model-controlled attestation certifies arbitrary files

`attestTargets` was model-supplied and applied without checking that the unit had written the files it
was attesting. A unit could attach `OPERATOR_ATTESTED` to files it had never touched.

**Fixed.** `selectAttestableTargets` (`plugin/src/attestation.ts`) restricts attestation to paths the
unit actually wrote, compared as canonicalised paths against `verdict.filesWritten`. The gate in
`plugin/src/index.ts` computes the operator identity **before** the scope, requires
`Array.isArray(verdict?.filesWritten)`, and records refusals in `verdict.attestationErrors`.

Asserted by `plugin/tests/oracles/attestation-scope.test.cjs` (6 behavioural, 4 structural). One of the
structural assertions exists because the first wiring applied **the import only** and still reported
`SUCCESS` — an unused import compiles, and build, unit suite, oracles and the `dist` diff were all green.

### Finding 3 — caller-selected `workspaceDir` defeats containment

`workspaceDir` was intended as an operator boundary but is an argument any caller can supply, so a
caller could hand the plugin a root of its choosing and write anywhere under it.

**Fixed** by `resolveWorkspaceContainment` (`plugin/src/containment.ts`), a four-row policy: omitted →
session root; inside the session root → allowed; under `emitAllowlist` → allowed; outside → approval, or
refusal when no approval service is reachable. The gate is wired in `plugin/src/index.ts` and both
refusal paths return a complete `CONTEXT_REFUSED` verdict with zeroed `testResults` and `tokens` rather
than a partial one.

Asserted by `plugin/tests/oracles/workspace-containment.test.cjs` (11 behavioural, 5 structural).
Commits: `8f8b181` (documentation: the base was caller-chosen), `6876b8b` (wired, with an assertion that
it **is** wired). The second commit exists because an unwired gate that returns the same shape is
indistinguishable from a working one from the outside.

### Finding 6, first half — the read guard did not recognise `gc`

`gc` is PowerShell's alias for `Get-Content`. It was in `CONTENT_READERS` but **not** in the prefilter,
so `gc file.ts` returned before containment was ever considered — the guard read delegated bytes with no
grant, in one of the most common PowerShell spellings.

**Fixed** in `66214c7`. `shellCommandName` (`plugin/src/guard.ts:257`) normalises a token to a bare
program name, stripping `.exe`/`.cmd`/`.bat`/`.ps1`; the prefilter (`:723-729`) is the **wider** of the
two sets (`READ_ONLY_INSPECTORS` ∪ `CONTENT_READERS`) so that a metadata command can still reach
`commandReadsContent` and be correctly reported as not reading bytes. The two questions are different
and the sets are kept separate deliberately: an earlier attempt used the union in **both** places and
`plugin/tests/oracles/control-bypass.test.cjs` failed on the next run, because the union carries `ls`,
`Get-ChildItem`, `Test-Path` and `stat`, and treating those as byte readers re-introduces the false
positive the split was introduced to remove.

### Findings 8 and 10, first half — the `read` route into declarations mode

With `sourceReadEgress: 'declarations'`, the `read` tool is redirected at `tools/post-execute` to the
compiled `.d.ts` skeleton, and a source file with no corresponding declaration is **refused** rather
than served as source — including the staleness check, which refuses a declaration older than its
source. This half is implemented and asserted by
`plugin/tests/oracles/egress-guard.test.cjs` (mapping, pass-through of non-source reads, staleness
refusal, and an assertion that no implementation statement appears in the served artifact).

Both halves are now fixed. The first is described immediately above; the second — the search and shell
routes — is recorded under "Fixed in the current tree" below.

## Not fixed, and why

### Findings 6 and 9, second half — scope-free shell searches

`rg somepattern` with no path argument names no file and no directory. The `SEARCH_TOOLS` branch
(`plugin/src/guard.ts:700-708`) reads the scope from `args.path ?? args.file_path ?? args.target`,
which is empty, and returns `{ target: '(workspace)', matched: [] }`. With `matched` empty the read gate
does not fire, so a scope-free search can surface delegated source to the cloud architect.

This is **not** an oversight in the branch. The shell branch *does* gate an extensionless directory
token (`delegatedUnderDirectory`, `:745`), and the search branch gates a named scope. What cannot be
resolved is the **implicit** scope: the decision is made in `tools/pre-execute`, where the plugin is
handed the tool name and its arguments and **not** the session workspace. A relative token therefore has
no base to resolve against, and `canonicalisePath` falls back to `process.cwd()`, which is not
necessarily the workspace the agent is searching.

The honest verdict is **not fixed, with a concrete blocker rather than an unimplemented idea**. Closing
it needs one of: the host exposing the session workspace on `tools/pre-execute`; or the plugin treating
a scope-free content search as reaching every delegated file (which would gate `rg` in any session that
has ever delegated anything — a fail-closed choice the operator should make explicitly, not a bug fix).

This was attempted **six times** during development and reverted twice, each time moving the failure
rather than closing it. The root cause recorded at the time: the pre-existing `delegatedUnder`
over-match gates `cat README.md` in a directory that happens to hold a delegated file. No partial
version of this is committed.

### Findings 7 and 12 — context budget enforced after whole-file loading

`resolveContextFiles` (`plugin/src/context.ts`) reads the whole file at `:72`
(`fs.readFileSync(resolvedPath, 'utf8')`) and splits it at `:78` (`raw.split('\n')`) **before** the
budget comparison at `:104`. A declared context path of arbitrary size is therefore fully materialised
in the DSH server process — and again as a line array — before being refused.

The budget bounds what is **injected** into the worker prompt. It does not bound what is **loaded**. A
pathological declaration can still exhaust the server process's memory.

Not fixed. The shape of the fix is clear (stat before reading, and for a ranged request read only the
range), and it is a real defect rather than an accepted trade — it simply was not in scope for the
remediation that closed the three highs, and it is listed here as open rather than described as
mitigated. The budget refusal itself *is* under test (`context-injection.test.cjs:92`); the ordering is
not, and the existing test cannot detect a regression in it.

### Findings 8 and 10, second half — search, shell and non-TypeScript routes

The declarations redirect was registered on `tools/post-execute` and applied to `READ_TOOLS` only
(`plugin/src/index.ts:1407`). A `grep`, `rg`, `Select-String` or shell `Get-Content` reaching the same
file was not redirected, so with declarations mode on, the file's **source body** was still what came
back through those routes. There were two distinct holes:

- **Search and shell returned before the filter ran at all**, because `if (!READ_TOOLS.has(name)) return
  decision` exits for any other tool.
- **Consumable extensions outside the TypeScript set were served raw.** `declarationPathFor`
  (`guard.ts:571-588`) returns `null` for anything outside `.ts/.tsx/.js/.jsx`, and the old caller read
  `null` as *"not a source file: nothing to strip"*. `CODE_EXTENSIONS` (`paths.ts:38`) lists about thirty
  extensions, so the gap between the two sets was exactly the leak.

**Fixed**, in five commits. The decision is now a pure function with no host dependency, the wiring is a
two-line call site, and neither touches the read path:

| commit | what it does |
| --- | --- |
| `cda4830` | `plugin/src/declaration-egress.ts` — `evaluateDeclarationEgress`, a pure decision over tool kind, target, mode and injected helpers. Returns `allow`, `serve-declaration` or `block` with a reason |
| `0f36f14` | `plugin/tests/oracles/declaration-egress-integration.test.cjs` — the red integration oracle, which mounts the real plugin and drives mock dispatches through the real `tools/post-execute` listener |
| `04d3b21` | exports `SHELL_TOOLS` and `longestCodeReference` from `guard.ts`, so the wiring reuses the existing vocabularies rather than defining a second one; corrects the oracle's shell case, since `cat` is a `READ_TOOLS` member and never reaches the shell branch |
| `0ac0b09` | `plugin/src/declaration-egress-hook.ts` — `handleDeclarationPostExecute`, holding classification, argument extraction and dispatch. `declarationPathFor`'s second parameter became optional, because the evaluator types it `(filePath, root?)` and a required parameter is not assignable |
| `04d222c` | the call site in `index.ts`, 7 lines |

**What the fix deliberately does not do.** `handleDeclarationPostExecute` returns `null` for reads, so
direct reads continue into the branch that already handled them. That branch is the only place the
**staleness check** (`staleDeclarationReason`) runs and the only place the *"SERVED AS TYPE
DECLARATIONS, NOT SOURCE"* banner is emitted, and both are pinned by `egress-guard.test.cjs`. Serving
reads from the new module would have replaced a tested control with an untested one. The hook therefore
handles precisely the two routes that can act on nothing except by refusing:

- **Search** — a search returns matched *lines*, so there is no whole file to substitute a skeleton for.
  The scope decides: a search confined to a non-code path is allowed, and an unstated scope is refused
  because it cannot be shown to avoid source.
- **Shell** — refused when the command both reads content and names a source path. A listing or existence
  test reads no bytes and is allowed through. When either inspector is missing the branch **blocks**,
  because an egress filter that cannot evaluate must not wave the read through.

Fail-closed on unmappable code extensions is retained: under declarations mode a `.py`, `.go`, `.rs` or
`.sh` read is **refused**, since no build can produce a skeleton for it and serving the body is the leak
the setting exists to prevent. The reason string says so and points at the two remedies.

### Findings 11 and 14 — shell write guard misses runtime-computed paths

The shell branch of `evaluateCodeWriteGuard` (`plugin/src/guard.ts:831-884`) is entirely lexical. It
checks, in order: `shellWriteTarget(command)` (`:834`), `findWriteViaScript` (`:847`, which reads an
invoked script file and scans its **text**, depth 2), `longestCodeReference(command)` (`:866`), then
`hasCommandWriteSignal` and `hasCommandDeleteSignal` (`:868-869`). Nothing evaluates anything.

A path computed at runtime — `node -e "fs.writeFileSync(p, ...)"` where `p` is assembled from pieces, a
loop over a directory listing, a base64 or otherwise obfuscated literal — names no source file on the
command line, so no stage matches. The code says so itself, in the reason string at `:879-881`:
*"Command-line inspection cannot prove otherwise, so this requires explicit approval."*

Not fixed, and **not fixable by static inspection**. Any check here is lexical by construction. The
available remedies are all operator decisions rather than bug fixes: deny shell tools outright in a
cloud context, remove shell tools from the architect's surface, or accept the gap and rely on the
approval prompt for the cases the scanner can see. The current design asks rather than denies on a hit,
which is the correct fail-open-for-usability choice only if the operator knows the scanner is partial.

### Findings 13 and 15 — request DLP cannot see the outbound payload

The DLP gate scans `sessionPromptCorpus` — text the plugin's own hooks accumulated from user messages
(`plugin/src/index.ts:1629-1635`). The comment there is accurate about what it covers: what this session
has *said*, not what is about to be *sent*.

The host assembles the outbound conversation **after** the plugin's seam, from the session surface. The
plugin has no hook that exposes the bytes about to leave, so assistant output and tool results are not
scanned, and a credential that appears in either is re-sent on every later request without the gate
seeing it. The block message states this limit rather than implying total coverage.

Not fixed, and **not fixable at this layer**. This is a host boundary, not a plugin defect: no
`tools/post-execute` or `agent/pre-step` hook sees the outbound payload. Closing it needs a host seam
that exposes the request body (or the assembled message list) to a plugin before transmission. Until
then the honest statement is the one in the message: the gate scans every **user message** it has seen.

### Findings 16 and 17 — verification allowlist matches a basename, executes a shell string

`commandProgram` (`plugin/src/verification.ts:353-362`) takes the first token of the command, strips a
quoting pair, applies `path.basename`, lowercases and strips `.exe`/`.cmd`/`.bat`/`.ps1`.
`evaluateVerificationPolicy` compares **program names** (`:386`). `runSandboxVerification` then executes
the **whole string** with `shell: true` (`:507-512`).

So an allowlist entry of `node` permits `node -e "<anything>"`, and `python` permits `python -c` of
equivalent reach. The allowlist authorises a **program**, not a command.

Not fixed, and this one is a **deliberate, documented trade rather than a defect**:
`plugin/README.md` states that the allowlist matches the program rather than its arguments, and the
delegation A/B record says the same and names it as the operator's to accept. It is listed here because
the report is right that the capability gap is real: with `shell: true` the plugin cannot distinguish a
test runner from an interpreter invocation, and no basename comparison ever will. Narrowing it would
need argument-aware policy, which the current `VerificationPolicy` shape does not model.

### Finding 18 — a bounded registry drops read protection for the entries it evicts

Two bounds exist, and neither considers the verdict.

`mergeDelegatedRecords` (`plugin/src/contracts.ts:307-322`) dedups by canonical path newest-first
(`entry.at`) and keeps `DELEGATED_PATH_LIMIT` (**500**, `:74`) — so a record can fall out of the
persisted registry purely for being old. `indexDelegated` (`:94-108`) then evicts from the in-memory
index by **Set insertion order** (`delegatedPaths.values().next().value`, `:102-107`) — which is a
*different* ordering from `at`, so which files lose protection depends on registry rebuild history, not
only on age.

The guard's read decision depends on the record **existing**: `lookupDelegatedRecord` returns
`undefined` for an evicted path, and `evaluateSettledFile` (`plugin/src/guard.ts:493`) answers a missing
record with *"the registry holds no verdict for it."* But the read gate only reaches
`evaluateSettledFile` for paths that `isDelegatedPath` still recognises, and that is a membership test
against `delegatedPaths` (`plugin/src/contracts.ts:73`). An evicted path is therefore **no longer
recognised as delegated at all** — the read is not refused, it is not gated, and the fail-closed
sentence above is never consulted.

Not fixed. A bounded registry cannot both cap its entries and retain protection for the ones it drops.
The honest options are: fail closed on unknown paths, which would gate every read of every non-delegated
file in the session; or persist verdicts separately from the path index, so eviction from the cap does
not imply forgetting the verdict. Both are design changes rather than fixes, and neither was made.

No test covers eviction. `plugin/tests/oracles/durable-registry.test.cjs` asserts that entries whose
file **no longer exists** are pruned, which is a different property with a different cause.

### Finding 19 — prompt prefixes are retained in the debug log

`trace` (`plugin/src/logging.ts:22-31`) writes `JSON.stringify(data)` verbatim to
`router-debug.log` under the plugin data directory. Two call sites pass prompt text:

- **`index.ts:1679`**, inside `DLP_FIREWALL_TRIPPED`, records `prompt: prompt.slice(0, 100)`.
- **`index.ts:664`**, on `ROUTER_DECISION`, records `prompt: fullText.slice(0, 100)` for **every routed
  turn**, whether or not the gate tripped. This second site is the wider exposure and the report does
  not mention it.

One correction to the report's framing. The record at `:1679` is reached only on the
`rerouteLocal` path: when the policy is to **block**, the gate throws at `:1664` and execution never
reaches the trace. So what is persisted is the prefix of a payload that was **rerouted to the local
worker**, not one that was refused. The distinction changes the risk rather than removing it — the
credential still lands on disk in plaintext, and the 100-character prefix may or may not be the part
containing it.

Not fixed. `trace` applies no redaction and neither call site passes through the DLP rules or
`cleanMessage`. No test covers it.

## Retractions and corrections

Corrections to claims made **in this repository's own record**, not to the external review.

1. **`README.md:18` claimed the architect "does not read source back."** That was false as written and
   conflicted with `plugin/README.md:583`, which says the architect **can** read source and that this is
   "the one boundary in this plugin that is not a boundary." `sourceReadEgress` is only ever tested as
   `=== 'declarations'` (`plugin/src/index.ts:1394`), so serving source is the default path. Corrected
   in the working tree; the correction is uncommitted as of this document.

2. **A `.mjs` harness cannot be written from a cloud context.** Stated in this session, then acted on
   and refused by the guard: `.mjs`, `.cjs` and `.js` are all in `CODE_EXTENSIONS`. The correct plan for
   any such harness is a delegated unit with its oracle as `contractFiles`.

3. **A preflight measurement was run without `enable_thinking`.** The production request body sends
   `enable_thinking: PROFILES.WORKER.enable_thinking` (`false`) and `reasoning_effort: 'none'`
   (`plugin/src/delegation.ts:591-592`). A model comparison was run with neither field. Re-run with the
   real parameter set, the conclusion was unchanged, but the first run did not test the production
   configuration and should not be cited as though it had.

4. **An apparent throughput figure was quoted as a decode rate.** `savings-ledger.json` computes
   `tokens / total elapsed`, which includes prefill and time-to-first-token. It is an *apparent* rate.
   Measured decode-only, the same model ran at 218.7 tok/s against an apparent 98.8 tok/s. Quote the
   decode figure only when it was measured as one.

5. **There is no `plugin/src/parser.ts`.** The search/replace parser is
   `parseSearchReplaceBlocks` and `applySearchReplaceBlocks` in `plugin/src/delegation.ts:289/332`,
   exported through `plugin/dist/delegation.js`. The invented filename appeared in this session and in
   at least one task description before being corrected.

6. **`isDelegatedPath` was fixed for the delegated-read gate on the day the class was found, and the
   class was not fixed — one instance was** (`docs/ROADMAP.md`, item 16). Recorded here because it is
   the same failure mode as finding 18: a check that passes for a reason orthogonal to the property it
   claims to check.

## Tests

No new tests were written for this audit. It is a source-level reading, and the verdicts above are
restatements of what the code does, not assertions about behaviour under test.

What exists for the fixed findings:

| Finding | Test | Assertions |
| --- | --- | --- |
| 1, 5 | `plugin/tests/oracles/routing-locality.test.cjs` | 13 behavioural, 5 structural |
| 2, 4 | `plugin/tests/oracles/attestation-scope.test.cjs` | 6 behavioural, 4 structural |
| 3 | `plugin/tests/oracles/workspace-containment.test.cjs` | 11 behavioural, 5 structural |
| 6 (`gc`) | `plugin/tests/oracles/control-bypass.test.cjs` | asserts listing/testing commands are **not** gated |
| 8, 10 (`read`) | `plugin/tests/oracles/egress-guard.test.cjs` | mapping, pass-through, staleness refusal, no implementation statements |
| 8, 10 (search, shell) | `plugin/tests/oracles/declaration-egress-scope.test.cjs` | 14 assertions over the pure decision, 5 of them controls so the gate cannot pass by refusing everything |
| 8, 10 (wiring) | `plugin/tests/oracles/declaration-egress-integration.test.cjs` | 6 assertions driven through the real `tools/post-execute` listener: 3 defect cases, 3 controls |

What does **not** exist, and is the largest gap this document exposes:

- No test for **scope-free** search gating (6/9 second half). The defect is known and unasserted.
- No test for eviction at `DELEGATED_PATH_LIMIT` (18). `durable-registry.test.cjs` covers pruning of
  deleted files only.
- No test for log redaction (19). The behaviour is asserted indirectly — redaction lives in
  `redactTracePayload` inside `trace()`, and a test exercising that function directly does not yet exist.
- No test pinning the `cat` classification on the new hook. `cat` is a `READ_TOOLS` member, so a `cat`
  dispatch carrying `command` is classified as a read and allowed; the wiring handles this correctly but
  nothing asserts it.
- No test for the context-budget **ordering** (7/12). A budget refusal *is* asserted —
  `plugin/tests/oracles/context-injection.test.cjs:92`, "exceeding the byte budget is refused and
  reported, never silently truncated", including that an over-budget injection is not partially applied.
  That test passes for a reason orthogonal to this defect: it checks the *outcome* of the budget
  comparison, not whether the file was loaded before the comparison ran. It would stay green if
  `readFileSync` moved a hundred lines earlier. This is the failure mode named in Retractions item 6,
  occurring in a live test.
- **No test for the short-anchor refusal in `applySearchReplaceBlocks`** — the
  `MIN_SEARCH_CHARS` guard that rejected every one-character anchor in a model comparison. Only two
  `MIN_SEARCH_CHARS` export-surface entries exist in `plugin/tests/oracles/public-surface.test.cjs`.

A security response whose remaining findings are all unasserted is worth less than one where each is
pinned by a failing test first. That is the work this document identifies and does not do.

## What this does not claim

- It does not claim the plugin is secure. Seven confirmed defects are listed above with no fix.
- It does not claim the three highs are unfixable-in-principle, only that the fixes were verified by
  reading and by the named oracles, not by an external re-review.
- It does not claim the report's severities were re-derived. Finding 18 is recorded above as low rather
  than medium on the grounds that the eviction requires more than 500 delegated files in one registry;
  that is a judgement, and it is the only severity changed.
- It does not cover the earlier review's findings, which `SECURITY-REVIEW.md` answers.
