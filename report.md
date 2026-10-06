# Security Review: DSHPlugin

## Scope

Static repository-wide security review of the current Git revision and all 36 tracked files.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_1df3560a15b447454b9b7415e3b0e6eb007999bee766ba18276c3b02a76ac1aa
- Revision: 7c5d6352c2e310279ab05639a589b76f210d9681
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: plugin/src/\*.ts, plugin/dist/\*.js, daemon/laya_server.py, scripts/\*.ps1, plugin tests, configuration, package metadata, documentation, and archive

Limitations and exclusions:
- External DSH host serialization, tool-schema enforcement, and deployed provider configuration are not present in this repository.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 5 |
| Severity mix | high: 2, medium: 3 |
| Confidence mix | high: 4, medium: 1 |
| Coverage | partial |
| Validation mode | Static source trace with independent baseline, architecture review, and focused investigation. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

The packaged Cordis plugin routes DSH agent requests through an in-process `agent/request` hook. It selects the configured cloud provider unless its DLP scan blocks or pins the request locally. It also registers `delegate_worker`, which sends a task to an OpenAI-compatible endpoint, writes returned code blocks to disk, and optionally runs a verification command (`plugin/package.json:6`, `plugin/src/index.ts:1527-1636`, `plugin/src/index.ts:1701-1825`). A separately launchable FastAPI daemon remains in the repository but is not called by current plugin routing (`scripts/start-daemon.ps1:39-46`, `plugin/src/index.ts:1064-1067`).

### Assets

- Conversation prompts, credentials, private source, and verification output (`plugin/src/index.ts:1683-1759`, `plugin/src/index.ts:696-705`).
- DSH provider selection and API-key configuration held by the host and profile (`plugin/src/index.ts:1771-1782`, `plugin/cordis.patch.yml:8-15`).
- Workspace files and host process authority used by worker file emission and verification (`plugin/src/index.ts:229-268`, `plugin/src/index.ts:652-704`, `plugin/src/index.ts:823-846`).
- Local router log and usage ledger (`plugin/src/index.ts:130-149`, `plugin/src/savings-tracker.ts:89-95`).

### Trust Boundaries

- Agent/request to provider configuration: one extracted prompt is scanned, then the hook blocks, selects local, or selects cloud; DSH owns provider transport (`plugin/src/index.ts:1701-1782`).
- Cloud architect or tool caller to `delegate_worker`: tool inputs include task instructions, target files, and verification command; no plugin-owned authorization or workspace ownership check is visible (`plugin/src/index.ts:1550-1636`).
- Worker response to host filesystem: emitted paths may be absolute or resolved against the selected workspace; writes use host process permissions (`plugin/src/index.ts:229-268`, `plugin/src/index.ts:823-840`).
- Verification command to host process: `execSync` runs with selected cwd and a 30-second timeout; EPERM can trigger an in-process module fallback (`plugin/src/index.ts:583-693`).
- Cloud-authored tool calls to source writes: `tools/pre-execute` checks named write and shell tools and asks approval for detected eligible writes, but does not mediate worker file emission (`plugin/src/index.ts:1293-1304`, `plugin/src/index.ts:1407-1525`, `plugin/src/index.ts:1638-1679`).
- Optional loopback FastAPI daemon accepts `/predict` and returns routing advice without provider dispatch or workspace writes (`daemon/laya_server.py:185-287`, `scripts/start-daemon.ps1:39-46`).

### Attacker Capabilities

- User or lower-trust text can influence agent prompt and DLP input but does not control DSH provider configuration (`plugin/src/index.ts:1683-1735`, `plugin/src/index.ts:1771-1775`).
- A caller permitted to invoke `delegate_worker` can supply task text, target file hints, and a verification command. Whether the DSH host strips undeclared `workspaceDir` or `endpoint` fields is unresolved (`plugin/src/index.ts:1557-1602`, `plugin/src/index.ts:711-728`).
- An untrusted model response can contain file names and code blocks later written by the host (`plugin/src/index.ts:229-292`, `plugin/src/index.ts:803-840`).

### Security Objectives

- Detected credentials must not be sent to cloud; local rerouting requires a trusted local endpoint (`plugin/src/index.ts:1726-1775`, `plugin/README.md:81-88`).
- Worker writes must stay inside an authorized workspace, and verification must execute with only intended authority (`plugin/src/index.ts:96-119`, `plugin/src/index.ts:229-268`, `plugin/src/index.ts:652-693`).
- Cloud-authored source writes require denial or explicit valid approval (`plugin/src/index.ts:1427-1479`, `plugin/src/index.ts:1496-1525`, `plugin/src/index.ts:1640-1679`).
- Raw verification output should stay local unless the operator disables redaction (`plugin/src/index.ts:700-705`, `plugin/src/index.ts:843-846`).

### Assumptions

- The active `apply()` hook does not call exported `LocalRouter.predictRoute` or `handleBeforeRequest`; the README's three-layer routing description differs from the cloud-default active hook (`plugin/src/index.ts:1026-1079`, `plugin/src/index.ts:1701-1775`, `plugin/README.md:98-109`).
- The README describes whole-conversation DLP, but the active hook extracts one message. Final host serialization is unknown (`plugin/README.md:116-130`, `plugin/src/index.ts:905-985`, `plugin/src/index.ts:1243-1262`, `plugin/src/index.ts:1683-1724`).
- Legacy spec and setup script describe a Laya daemon dependency, but current packaged routing is in-process (`spec.md:10-28`, `scripts/setup.ps1:59-60`, `plugin/src/index.ts:1064-1067`).
- Provider URLs, host authentication, `ctx.tools` validation, approval behavior, and workspace ownership depend on DSH components outside this repository (`plugin/src/index.ts:96-119`, `plugin/src/index.ts:1496-1525`, `plugin/src/index.ts:1550-1636`).

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [A delegated verification command can execute on the DSH host](#finding-1) | high | high | inline below |
| [A delegated worker can write files outside its workspace](#finding-2) | high | high | inline below |
| [Verification failure labels can leak local output to the cloud model](#finding-3) | medium | high | inline below |
| [Cloud shell writes can bypass the source write guard](#finding-4) | medium | high | inline below |
| [Earlier conversation secrets can bypass the cloud DLP gate](#finding-5) | medium | medium | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] A delegated verification command can execute on the DSH host

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | The advertised tool argument flows directly to `execSync` with no command allowlist or isolation. |
| Category | command-injection |
| CWE | CWE-78 |
| Affected lines | plugin/src/index.ts:1573, plugin/src/index.ts:667, plugin/src/index.ts:843 |

#### Summary

The cloud callable `delegate_worker` tool accepts `runVerification` and passes it to a shell command executed with DSH server privileges.

#### Root Cause

`runVerification` is model supplied, is forwarded without approval or command selection, and `runSandboxVerification` executes its raw string. The code write guard does not mediate `delegate_worker`.

**Tool accepts command** — `plugin/src/index.ts:1573`

The cloud callable tool exposes an unrestricted verification command string.

```typescript
runVerification: {
  type: 'string',
  description: 'Optional shell command to verify the output',
}
```

**Command reaches verification** — `plugin/src/index.ts:843`

`delegateWorker` forwards the caller's command after receiving a local worker response.

```typescript
if (params.runVerification) {
  testResults = runSandboxVerification(params.runVerification, workspaceBase, {
```

**Shell executes command** — `plugin/src/index.ts:667`

The command executes with the DSH server's process authority; the timeout does not restrict filesystem or network access.

```typescript
output = child_process.execSync(cmd, {
  cwd: workspaceDir,
  timeout: 30000,
```

#### Validation

The tool schema, handler, and `execSync` sink form a direct source to sink path. Successful worker response and the optional argument are required.

Validation method: static source trace

**Tool accepts command** — `plugin/src/index.ts:1573`

The cloud callable tool exposes an unrestricted verification command string.

```typescript
runVerification: {
  type: 'string',
  description: 'Optional shell command to verify the output',
}
```

**Command reaches verification** — `plugin/src/index.ts:843`

`delegateWorker` forwards the caller's command after receiving a local worker response.

```typescript
if (params.runVerification) {
  testResults = runSandboxVerification(params.runVerification, workspaceBase, {
```

**Shell executes command** — `plugin/src/index.ts:667`

The command executes with the DSH server's process authority; the timeout does not restrict filesystem or network access.

```typescript
output = child_process.execSync(cmd, {
  cwd: workspaceDir,
  timeout: 30000,
```

Limitations:
- No live DSH host reproduction was performed.

#### Dataflow

A cloud architect influenced by untrusted task content calls `delegate_worker` with `runVerification`; after the local worker responds, the plugin executes that command on the host.

**Tool accepts command** — `plugin/src/index.ts:1573`

The cloud callable tool exposes an unrestricted verification command string.

```typescript
runVerification: {
  type: 'string',
  description: 'Optional shell command to verify the output',
}
```

**Command reaches verification** — `plugin/src/index.ts:843`

`delegateWorker` forwards the caller's command after receiving a local worker response.

```typescript
if (params.runVerification) {
  testResults = runSandboxVerification(params.runVerification, workspaceBase, {
```

**Shell executes command** — `plugin/src/index.ts:667`

The command executes with the DSH server's process authority; the timeout does not restrict filesystem or network access.

```typescript
output = child_process.execSync(cmd, {
  cwd: workspaceDir,
  timeout: 30000,
```

#### Reachability

The `delegate_worker` tool is registered for the agent; the cloud model can choose its advertised verification argument. The local worker must respond successfully.

#### Severity

**High** — A caller of the delegated tool can obtain host command execution and access files or network available to the DSH process. The optional verification step and successful local worker response are prerequisites.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Why:** A caller of the delegated tool can obtain host command execution and access files or network available to the DSH process. The optional verification step and successful local worker response are prerequisites.

#### Remediation

Replace model selected command strings with operator configured verification IDs and run selected commands in an isolated process with restricted filesystem and network access.

Tests:
- Verify arbitrary `runVerification` strings are rejected before shell execution.
- Verify each allowed verification ID maps to a fixed isolated command.

Preventive controls:
- Do not load generated test modules into the DSH server process on spawn failure.

<a id="finding-2"></a>

### [2] A delegated worker can write files outside its workspace

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | The emitter accepts absolute paths and resolves relative paths without a containment check before writing. |
| Category | path-traversal |
| CWE | CWE-22 |
| Affected lines | plugin/src/index.ts:243, plugin/src/index.ts:266, plugin/src/index.ts:1594 |

#### Summary

Absolute and parent relative paths in worker output or target hints reach `fs.writeFileSync` without workspace containment.

#### Root Cause

The emitter treats model output paths as valid destinations, allowing absolute paths and `..` segments. It creates parent directories and writes with server permissions; the size check only limits some overwrites.

**Worker path input** — `plugin/src/index.ts:285`

The worker's returned fence header supplies the destination path.

````typescript
const fileAttrRegex = /```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
````

**Absolute paths and traversal accepted** — `plugin/src/index.ts:243`

Absolute paths bypass the base directory, and parent segments can resolve above it.

```typescript
const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath)
```

**Host filesystem write** — `plugin/src/index.ts:266`

No containment or symlink check occurs before the host process writes the selected file.

```typescript
fs.writeFileSync(resolvedPath, fileCode, 'utf8')
```

#### Validation

A path named by a worker response can resolve outside `baseDir` and reaches `fs.writeFileSync`. Existing file size checks do not enforce a workspace boundary.

Validation method: static source trace

**Worker path input** — `plugin/src/index.ts:285`

The worker's returned fence header supplies the destination path.

````typescript
const fileAttrRegex = /```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
````

**Absolute paths and traversal accepted** — `plugin/src/index.ts:243`

Absolute paths bypass the base directory, and parent segments can resolve above it.

```typescript
const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath)
```

**Host filesystem write** — `plugin/src/index.ts:266`

No containment or symlink check occurs before the host process writes the selected file.

```typescript
fs.writeFileSync(resolvedPath, fileCode, 'utf8')
```

Limitations:
- No live DSH host reproduction was performed.

#### Dataflow

The cloud callable worker asks for a file or the local model returns a fenced file path outside the workspace; `emitFile` resolves and writes it.

**Worker path input** — `plugin/src/index.ts:285`

The worker's returned fence header supplies the destination path.

````typescript
const fileAttrRegex = /```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
````

**Absolute paths and traversal accepted** — `plugin/src/index.ts:243`

Absolute paths bypass the base directory, and parent segments can resolve above it.

```typescript
const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath)
```

**Host filesystem write** — `plugin/src/index.ts:266`

No containment or symlink check occurs before the host process writes the selected file.

```typescript
fs.writeFileSync(resolvedPath, fileCode, 'utf8')
```

#### Reachability

A caller can supply target file hints and the model can supply fenced paths. The write occurs after a successful local worker response.

#### Severity

**High** — A cloud callable worker can overwrite files accessible to the server outside the selected workspace; the path can be selected directly or induced in generated output.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Why:** A cloud callable worker can overwrite files accessible to the server outside the selected workspace; the path can be selected directly or induced in generated output.

#### Remediation

Fix the workspace from trusted session state, reject absolute paths and traversal, resolve symlinks, and require the final destination to remain within an explicit target allowlist.

Tests:
- Reject `../` and absolute output paths.
- Reject destinations that escape through a symlink.

Preventive controls:
- Centralize all delegated file writes behind a workspace containment helper.

<a id="finding-3"></a>

### [3] Verification failure labels can leak local output to the cloud model

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The parsing and receipt formatting copy the fields verbatim, while raw output is otherwise redacted by default. |
| Category | sensitive-data-exposure |
| CWE | CWE-201 |
| Affected lines | plugin/src/index.ts:431, plugin/src/index.ts:439, plugin/src/index.ts:556 |

#### Summary

The redactor copies TAP failure names, locations, and codes into the returned tool receipt without sanitizing their contents.

#### Root Cause

The redaction routine omits most raw output but treats test name, location, and code fields as safe. It copies attacker influenced text from those fields into a cloud visible receipt.

**Failure name copied** — `plugin/src/index.ts:431`

Arbitrary failure text becomes a returned failure name.

```typescript
const notOk = /^not ok\s+(\d+)\s*-\s*(.*)$/i.exec(t)
if (notOk) {
  current = { kind: 'assertion', name: `${notOk[1]}. ${notOk[2]}`.replace(/\s+/g, ' ').trim() }
```

**Location and code copied** — `plugin/src/index.ts:439`

Failure metadata is copied without a structural path or code validator.

```typescript
const loc = /^location:\s*(.+)$/.exec(t)
if (loc) current.location = loc[1].replace(/^["']|["']$/g, '').trim()
```

**Copied fields enter receipt** — `plugin/src/index.ts:555`

The supposedly redacted output includes the copied fields in the result and summary.

```typescript
const failures = redact ? redactVerificationOutput(output) : []
const described = describeFailures(failures)
```

#### Validation

The parser stores arbitrary TAP failure text and `describeFailures` includes those fields; the redacted result returns them. No secret check is applied.

Validation method: static source trace

**Failure name copied** — `plugin/src/index.ts:431`

Arbitrary failure text becomes a returned failure name.

```typescript
const notOk = /^not ok\s+(\d+)\s*-\s*(.*)$/i.exec(t)
if (notOk) {
  current = { kind: 'assertion', name: `${notOk[1]}. ${notOk[2]}`.replace(/\s+/g, ' ').trim() }
```

**Location and code copied** — `plugin/src/index.ts:439`

Failure metadata is copied without a structural path or code validator.

```typescript
const loc = /^location:\s*(.+)$/.exec(t)
if (loc) current.location = loc[1].replace(/^["']|["']$/g, '').trim()
```

**Copied fields enter receipt** — `plugin/src/index.ts:555`

The supposedly redacted output includes the copied fields in the result and summary.

```typescript
const failures = redact ? redactVerificationOutput(output) : []
const described = describeFailures(failures)
```

Limitations:
- No live DSH host reproduction was performed.

#### Dataflow

A local verification step prints a secret as a TAP failure label or metadata; the tool result includes it in the cloud conversation.

**Failure name copied** — `plugin/src/index.ts:431`

Arbitrary failure text becomes a returned failure name.

```typescript
const notOk = /^not ok\s+(\d+)\s*-\s*(.*)$/i.exec(t)
if (notOk) {
  current = { kind: 'assertion', name: `${notOk[1]}. ${notOk[2]}`.replace(/\s+/g, ' ').trim() }
```

**Location and code copied** — `plugin/src/index.ts:439`

Failure metadata is copied without a structural path or code validator.

```typescript
const loc = /^location:\s*(.+)$/.exec(t)
if (loc) current.location = loc[1].replace(/^["']|["']$/g, '').trim()
```

**Copied fields enter receipt** — `plugin/src/index.ts:555`

The supposedly redacted output includes the copied fields in the result and summary.

```typescript
const failures = redact ? redactVerificationOutput(output) : []
const described = describeFailures(failures)
```

#### Reachability

A `delegate_worker` call must run verification and produce structured failure output; default redaction does not strip these fields.

#### Severity

**Medium** — Secret or source content printed in a verification failure label can reach the cloud tool result despite default redaction; exploitation requires a verification step that emits such output.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** low
- **Why:** A local test that prints a secret in a failure label can expose it through the cloud tool result; the attacker must control or influence verification output.

#### Remediation

Return only bounded counts and validated error categories, or apply strict structural validation and DLP to every copied field.

Tests:
- Feed a TAP failure label containing a synthetic secret and assert it is absent from all returned fields.

Preventive controls:
- Treat test output as untrusted data at the local to cloud boundary.

<a id="finding-4"></a>

### [4] Cloud shell writes can bypass the source write guard

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The guard's finite command patterns and allow on null path are explicit in the active hook. |
| Category | authorization-bypass |
| CWE | CWE-863 |
| Affected lines | plugin/src/index.ts:1444, plugin/src/index.ts:1476, plugin/src/index.ts:1645 |

#### Summary

The `tools/pre-execute` guard allows shell calls when its narrow write and script patterns miss a source write.

#### Root Cause

The source write guard treats its finite tool-name and regex matches as an enforcement boundary. Unrecognized shell write forms return null, so the pre-execute hook has no denial to apply.

**Named shell calls inspected** — `plugin/src/index.ts:1444`

Only named shell tools and two argument keys enter the shell inspection path.

```typescript
if (SHELL_TOOLS.has(name)) {
  const command = args?.command ?? args?.script ?? ''
```

**Direct writes use a narrow regex** — `plugin/src/index.ts:1323`

A source write through other shell syntax does not match this direct-write check.

```typescript
const match = /(?:Set-Content|Add-Content|Out-File|New-Item|tee|>>?)\s+(?:-Path\s+)?["']?([^\s"'|;>)]+\.[A-Za-z0-9]{1,6})["']?/.exec(command)
```

**Unrecognized commands pass** — `plugin/src/index.ts:1476`

If direct and script checks miss, the guard returns no verdict and the active hook permits the call.

```typescript
return null
```

#### Validation

The active guard handles only enumerated write and shell tool names, selected argument fields, and selected command text patterns. A shell call outside these patterns returns null and proceeds.

Validation method: static source trace

**Named shell calls inspected** — `plugin/src/index.ts:1444`

Only named shell tools and two argument keys enter the shell inspection path.

```typescript
if (SHELL_TOOLS.has(name)) {
  const command = args?.command ?? args?.script ?? ''
```

**Direct writes use a narrow regex** — `plugin/src/index.ts:1323`

A source write through other shell syntax does not match this direct-write check.

```typescript
const match = /(?:Set-Content|Add-Content|Out-File|New-Item|tee|>>?)\s+(?:-Path\s+)?["']?([^\s"'|;>)]+\.[A-Za-z0-9]{1,6})["']?/.exec(command)
```

**Unrecognized commands pass** — `plugin/src/index.ts:1476`

If direct and script checks miss, the guard returns no verdict and the active hook permits the call.

```typescript
return null
```

Limitations:
- The DSH host's available shell tools and any additional host permissions are outside this repository.

#### Dataflow

cloud tool arguments -\> evaluateCodeWriteGuard -\> null verdict -\> allowed tool execution

**Named shell calls inspected** — `plugin/src/index.ts:1444`

Only named shell tools and two argument keys enter the shell inspection path.

```typescript
if (SHELL_TOOLS.has(name)) {
  const command = args?.command ?? args?.script ?? ''
```

**Direct writes use a narrow regex** — `plugin/src/index.ts:1323`

A source write through other shell syntax does not match this direct-write check.

```typescript
const match = /(?:Set-Content|Add-Content|Out-File|New-Item|tee|>>?)\s+(?:-Path\s+)?["']?([^\s"'|;>)]+\.[A-Za-z0-9]{1,6})["']?/.exec(command)
```

**Unrecognized commands pass** — `plugin/src/index.ts:1476`

If direct and script checks miss, the guard returns no verdict and the active hook permits the call.

```typescript
return null
```

#### Reachability

Requires a named shell tool to be available to the cloud agent.

#### Severity

**Medium** — A cloud model with a shell tool can write source files without the guard's denial or approval. This requires a shell tool to be available in DSH.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Enforce source write permissions at the filesystem or tool capability layer for every cloud callable operation, and treat command inspection as advisory.

Tests:
- Assert source writes through alternate shell syntax are denied or require approval.

Preventive controls:
- Apply one scoped write capability to every tool and delegated worker write path.

<a id="finding-5"></a>

### [5] Earlier conversation secrets can bypass the cloud DLP gate

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | The one-message scan and retained request configuration are explicit; final host serialization is outside this repository. |
| Category | sensitive-data-exposure |
| CWE | CWE-201 |
| Affected lines | plugin/src/index.ts:1243, plugin/src/index.ts:1730, plugin/src/index.ts:1771 |

#### Summary

The request hook scans one extracted message but can select a cloud provider while retaining the full request configuration.

#### Root Cause

The enforcing DLP hook selects one message for scanning, then spreads the existing request configuration into a cloud pinned result. It does not inspect all content that the provider may transmit.

**One message selected** — `plugin/src/index.ts:1243`

The pre-step capture picks one recent message instead of aggregating the outbound conversation.

```typescript
function extractTextFromClaimedMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
```

**DLP scans selected prompt** — `plugin/src/index.ts:1730`

Only `prompt` is inspected for secret patterns and entropy.

```typescript
const dlpResult = scanDLP(prompt, {
  entropyCheck: options?.entropyCheck,
```

**Request retains other fields** — `plugin/src/index.ts:1771`

A clean selected prompt leads to cloud selection while other request fields, including messages, remain in the configuration.

```typescript
const mutatedConfig: Record<string, any> = {
  ...resolvedConfig,
  provider: rerouteLocal ? config.localProvider : config.cloudProvider,
```

#### Validation

The source proves the scan receives one extracted string while the returned configuration retains other fields. Exposure requires DSH to serialize earlier messages into the provider request.

Validation method: static source trace

**One message selected** — `plugin/src/index.ts:1243`

The pre-step capture picks one recent message instead of aggregating the outbound conversation.

```typescript
function extractTextFromClaimedMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
```

**DLP scans selected prompt** — `plugin/src/index.ts:1730`

Only `prompt` is inspected for secret patterns and entropy.

```typescript
const dlpResult = scanDLP(prompt, {
  entropyCheck: options?.entropyCheck,
```

**Request retains other fields** — `plugin/src/index.ts:1771`

A clean selected prompt leads to cloud selection while other request fields, including messages, remain in the configuration.

```typescript
const mutatedConfig: Record<string, any> = {
  ...resolvedConfig,
  provider: rerouteLocal ? config.localProvider : config.cloudProvider,
```

Limitations:
- No live DSH host reproduction was performed.

#### Dataflow

A credential appears in an earlier message, followed by a clean latest message; the DLP scan sees the latest message and selects the cloud provider.

**One message selected** — `plugin/src/index.ts:1243`

The pre-step capture picks one recent message instead of aggregating the outbound conversation.

```typescript
function extractTextFromClaimedMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
```

**DLP scans selected prompt** — `plugin/src/index.ts:1730`

Only `prompt` is inspected for secret patterns and entropy.

```typescript
const dlpResult = scanDLP(prompt, {
  entropyCheck: options?.entropyCheck,
```

**Request retains other fields** — `plugin/src/index.ts:1771`

A clean selected prompt leads to cloud selection while other request fields, including messages, remain in the configuration.

```typescript
const mutatedConfig: Record<string, any> = {
  ...resolvedConfig,
  provider: rerouteLocal ? config.localProvider : config.cloudProvider,
```

#### Reachability

The active `agent/request` hook runs before provider dispatch. Actual message assembly is implemented outside this repository.

#### Severity

**Medium** — A prior credential or private material may be sent to a cloud provider when the selected latest message is clean. The exact serialized outbound body depends on the external DSH host.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Why:** A prior credential or private material may be sent to a cloud provider when the selected latest message is clean. The exact serialized outbound body depends on the external DSH host.

#### Remediation

Scan the finalized outbound provider payload, including earlier conversation messages and tool content, and fail closed if it cannot be inspected.

Tests:
- Keep a credential in an earlier message and assert cloud dispatch is blocked or rerouted when the latest message is clean.

Preventive controls:
- Define an explicit policy for confidential source and noncredential private data.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Agent request DLP and provider routing | not recorded | Reported | One-message DLP leaves earlier conversation content outside the gate; active hook reviewed in TypeScript and packaged JavaScript. |
| Delegated verification command | not recorded | Reported | Cloud callable `runVerification` reaches host shell execution after worker response. |
| Delegated file emission | not recorded | Reported | Absolute and parent relative paths reach host file writes without workspace containment. |
| Verification output redaction | not recorded | Reported | TAP failure name, location, and code fields enter returned result without validation. |
| Cloud source write guard | not recorded | Reported | The guard denies recognized writes but permits shell write forms its patterns miss. |
| Optional Laya daemon | not recorded | No issue found | Separately launched loopback classifier; no current plugin caller. It does not dispatch a provider or write workspace files. |
| Package, scripts, tests, distribution and documentation | not recorded | No issue found | All 36 tracked files were statically reviewed. Packaged JavaScript has the same security-relevant sinks as TypeScript; no runtime code or tests executed. |
| Optional delegated endpoint override | not recorded | Not applicable | Not reported as a vulnerability: the `endpoint` parameter is absent from the published tool schema, and this repository cannot establish that DSH permits undeclared fields. Host behavior remains an open question. |
| Delegated worker command and file authority | not recorded | Reported | Command execution and file containment validated in plugin/src/index.ts. |
| Outbound privacy gate and verification receipt | not recorded | Reported | Single-message DLP and verification label disclosure validated in plugin/src/index.ts. |

## Open Questions And Follow Up

- Whether DSH includes earlier conversation and tool messages in each final provider payload.
- Whether DSH strips undeclared tool fields such as `endpoint` and `workspaceDir`.
- Installed dependency advisory status was not checked offline.
- Host schema handling of undeclared tool arguments is unavailable in this repository.
  - Follow-up prompt: Review deferred unit investigator-endpoint and close its stated proof gap.
