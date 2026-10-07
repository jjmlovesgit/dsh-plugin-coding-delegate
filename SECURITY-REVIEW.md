# Security review response

Response to the external static review of revision `7c5d635` (5 findings: 2 high, 3 medium).
The review document itself is an external artifact and is not committed here.

Every finding was re-verified at source level before any change was made, and then against the
composed DSH host contracts where the review had to leave a question open. The review's line
citations were accurate: each one resolved to the construct it named, quoted verbatim.

## Verdicts

| # | Finding | Severity | Verdict |
| --- | --- | --- | --- |
| 1 | Delegated verification command executes on the DSH host | high | **Valid** — and understated (see below) |
| 2 | Delegated worker can write files outside its workspace | high | **Valid** |
| 3 | Verification failure labels leak local output to the cloud | medium | **Valid** |
| 4 | Cloud shell writes bypass the source write guard | medium | **Valid** |
| 5 | Earlier-conversation secrets bypass the cloud DLP gate | medium | **Effect valid, mechanism incorrect** |

### 1. Delegated verification command — valid, and worse than reported

`runVerification` is a model-supplied argument on the published tool schema, spread into
`delegateWorker`, passed to `runSandboxVerification`, and executed by
`child_process.execSync(cmd, { cwd, timeout: 30000 })`. Nothing mediates it: the write guard's
`SHELL_TOOLS` set matches the *calling* tool, which here is `delegate_worker`.

The review did not report the worse half. On `EPERM` the code called `runInProcessFallback`,
which `require`d the target module **inside the DSH server process**. The sandbox denied a piped
spawn and the response was to remove the sandbox. That path was also the only reason verification
worked at all on a sandboxed Windows host.

**Fixed:** `verificationApproval` (`'ask'` default) routes the command through the real approval
seam before dispatch; `verificationAllowlist` permits named programs; `'deny'` refuses all. No
reachable approval service is a refusal. `allowInProcessFallback` now defaults to `false`, so a
denied spawn fails closed with a non-zero failed count rather than executing in-process.

### 2. Workspace escape on delegated writes — valid

`emitFile` took an absolute path as-is and let `path.resolve` normalise `..` above the base
directory, then `mkdirSync` + `writeFileSync` with server permissions. The only pre-write check
was a clobber guard about file *size*.

**Fixed:** `evaluateEmissionPath` requires the destination to resolve inside the workspace (or an
explicit `emitAllowlist` root). Both sides are canonicalised, so a symlink cannot be used to
escape. Refusals are reported in `errors` and surfaced in the summary rather than being silent.

### 3. Failure labels leak through redaction — valid

`redactVerificationOutput` copied the TAP `not ok` label into `name` and `location:` into
`location` verbatim; only the prose `message` passed through `cleanMessage`, and no field was
secret-scanned.

**Fixed:** every retained field is passed through the same secret rules the DLP gate uses
(entropy included, since these are exactly the strings that leave the machine) and is
length-bounded. An offending value becomes `[redacted: …]`. Counts, names, locations and codes
still travel, so the receipt keeps its diagnostic value.

### 4. Shell write guard bypass — valid

`shellWriteTarget` was a narrow verb regex and `findWriteViaScript` only inspected files named on
the command line *with a script extension*. Inline program text never entered any check, and a
miss returned `null`, which the pre-execute pipeline treats as an allow.

Confirmed bypasses: `python -c "open('src/x.ts','w')"`,
`node -e "...writeFileSync('src/x.ts')"`, `cp`, `git checkout`, `sed -i`, a redirection.

**Fixed:** the command line itself is now checked for a source-extension reference combined with
a write signal (write verbs, copy/move, real redirections, inline eval). Hits are `ask`, not
`deny`, so false positives cost a prompt rather than a blocked command. Read-only commands
(`git diff`, `grep`, `node tests/x.test.cjs`) stay silent.

### 5. Earlier-conversation secrets — effect valid, mechanism incorrect

The review hedged this on host behaviour it could not see. With the host available, the mechanism
is not what was described: `agent/request` receives `payload: { agent, turn, step, signal }` and
returns an `LlmCallConfig`; the agent loop dispatches exactly that payload, and the outbound
conversation is assembled **later** from the session surface. The returned configuration never
contained `messages`, and the plugin transmits nothing itself — DSH does.

The underlying risk is nonetheless real, because neither seam exposes the outbound payload:
`agent/pre-step` receives only the messages claimed for the current turn. A credential from an
earlier turn was therefore never scanned while the host re-sent it on every later request. The
pre-existing block message claimed such a credential "will keep blocking every request", which
was simply false.

**Fixed:** user-message text is accumulated per session and the gate scans the accumulated corpus,
so a credential seen in an earlier turn keeps the gate closed (verified by test). The block
message now states exactly what is and is not scanned. The residual limit is documented: assistant
output and tool results are assembled by the host after the hook and are not scanned.

## Additional issues found while verifying

- **`endpoint` was an undeclared but honoured argument.** The published schema omitted it, yet
  `execute` spread caller arguments into `delegateWorker`, which uses `params.endpoint` as the
  full POST URL for the local worker request. If the host passed undeclared arguments through, a
  caller could redirect that request — carrying the architect's instruction and file contents —
  to any URL. The review filed this as "not applicable" pending host behaviour. It is now dropped
  in both dispatch paths regardless of host behaviour.
- **`workspaceDir` was also undeclared** while being intentionally honoured. It is now declared in
  the schema, so it is a validated argument rather than an accidental one.
- **The `tool/call` fallback set `endpoint: options.localProvider`**, i.e. the POST URL was the
  provider *id* (`lm-studio`), not a URL. Removed; `delegateWorker`'s own default is correct.
- **`commandProgram` mis-parsed a quoted program path containing a space** (`"C:\Program
  Files\nodejs\node.exe"` read as `program`). Fail-closed, but wrong; found by the new test.

## Defects found after the review

The review covered the state at `7c5d635`. Six further defects surfaced while remediating, and by
testing against the real host rather than the unit suite alone. All are fixed and covered by tests.

- **The in-process fallback inverted a control.** Worse than the report described: a sandbox
  *denial* of a piped spawn was answered by `require`-ing the module into the server process. Now
  opt-in (`allowInProcessFallback`, default `false`), and a refused spawn fails closed.
- **Verification never worked in the default configuration.** Output was captured through a pipe,
  and DSH's confined sandbox modes refuse a piped spawn outright (`spawn EPERM`). That made the
  ordinary subprocess path unusable for sandboxed users and left the dangerous fallback as the only
  path that worked. Capture now goes through file descriptors, so verification needs no opt-in and
  no container runtime.
- **`guardAskPaths` replaces the built-in default rather than extending it.** Setting it to one
  path silently made `tests/` and `tools/` hard denies. Documented in the README; the shipped
  profile lists all three explicitly.
- **The write-verb regex was unanchored.** `Move-Item` matched as a substring of `Remove-Item`, so
  a plain delete was classified as a write signal. Only live testing could find this: the unit
  suite only ever tested the verbs the regex was meant to catch.
- **Deletion was not gated at all.** `Remove-Item src/x.ts` passed silently. Deletion verbs are now
  a second, word-anchored list checked in both the command line and script bodies, and the verdict
  reports deletion as deletion.
- **Reading a file was treated as invoking it.** Any `.js` token made the guard read the whole file
  and — since any sizeable program contains a write primitive — ask for approval to *read* it. The
  body scan now skips tokens that are arguments to a read-only inspector (`Select-String`, `grep`,
  `Get-Content`, `Test-Path`, `diff`, …). A related cosmetic defect went with it: the reported
  target was the *first* source-extension match, so extension-shaped prose displaced the real path;
  it is now the longest match.

## Tests

213 tests pass: 182 in the workspace oracle suites, 31 in the plugin's vitest suite.

The review's own remediation suggestions were implemented as tests, including "feed a TAP failure
label containing a synthetic secret and assert it is absent from all returned fields" and
"reject `../` and absolute output paths".

`tests/security-review-fixes.test.cjs` maps one test group per finding (F1–F5) and fails against
the pre-remediation build. Two existing tests were updated rather than deleted: they drove
verification through the in-process fallback, which is now opt-in, so they enable it explicitly
and a new test asserts the fail-closed default.

## Verification record

Beyond the unit suites, the plugin was exercised against a live DSH host — the desktop app, a
separate profile from the CLI one — with the local worker running:

| Check | Result |
| --- | --- |
| Plugin loads and registers `delegate_worker` | pass |
| Delegation round trip to the local model | pass |
| Guard denies a cloud-authored source write | pass |
| Write containment refuses absolute and `..` escapes | pass — and declines to write the raw blob as a fallback |
| Verification gate prompts, then captures output as a subprocess | pass — no in-process fallback involved |
| Deleting a source path asks; deleting a non-source file does not | pass |
| Reading a `.js` file does not ask; invoking a script does | pass |

Approvals were confirmed to be genuine human decisions rather than auto-admitted: each ask/decision
pair in the session audit is separated by 1.9–3.1 s, and no `permission/preset` event switched the
session to the `auto` preset. That matters, because a fail-closed gate is worth nothing if the
approver is never actually asked.

## Containers are optional

Verification runs as an ordinary child process and **does not require a container runtime**. Most
operators have no Docker, Podman or WSL, and guidance they cannot follow is not a safe default — it
is a feature that silently never runs. Add a container only when execution must be bounded more
tightly than the user account already bounds it; the README gives the flags that matter if you do
have a runtime.

## What this does not claim

The guard remains a deterrent at the tool layer, not an airtight boundary. Still open:

- The guard sees tool calls and shell text, not intent. A target computed at runtime
  (`f = 'src/' + name`) cannot be matched, and a mutation performed inside a library is invisible.
- Config files (`.yaml`, `.json`, `.env`) are out of scope — only source extensions are gated.
- Code in prose is not mediated.
- The DLP gate scans the user messages the plugin has seen, not assistant output or tool results, and
  pattern plus entropy matching cannot recognise confidential material that looks ordinary.
- Provider transport, schema enforcement and session storage live in DSH, outside this repository.

The durable fix for findings 1, 2 and 4 is a capability boundary in the host: one scoped write and
execute capability applied to every tool and delegated worker path, with command inspection
treated as advisory. That is a DSH-level change, not a plugin one.
