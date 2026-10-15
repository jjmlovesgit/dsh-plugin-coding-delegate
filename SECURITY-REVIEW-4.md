# Security Review: DSHLaya

## Scope

Whole-repository static security review of the current Git revision.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_eb365aafc1f57b8c54cfecffcf9ecc59b9809adde9df8308d013df48ac399b9b
- Revision: 8cb69708e32445b1dee0503bbaa08ca8a842cffe
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: plugin/src, plugin/dist, scripts, tools, .github/workflows/ci.yml, package manifests, representative tests, docs and experiments for credential exposure

Limitations and exclusions:
- Coverage is partial: product implementation and privileged scripts were prioritized; tests, docs and historical experiments were not all individually audited.
- Deployment-dependent host session retention and workspace search behavior were not reproduced.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 7 |
| Severity mix | medium: 7 |
| Confidence mix | high: 5, medium: 2 |
| Coverage | partial |
| Validation mode | Source-backed static tracing and independent investigator review. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

DSH Cordis plugin loaded from profile bundle; in-process agent/request and tool hooks govern routing, writes, and source reads. delegate_worker sends bounded context to a configured endpoint, emits worker output into workspace, optionally verifies by host-authority shell process, persists verdicts, and can sign Git notes (plugin/src/index.ts:1094-1129,1148-1225,1364-1403,1447-1455,1660-1803; plugin/src/delegation.ts:728-745,855-895,1230-1247).

### Assets

- Workspace source and integrity of target files (plugin/src/emission.ts:156-182,257-277).
- Session prompts, credentials, worker context, verification output, registry and logs (plugin/src/index.ts:1583-1596; plugin/src/delegation.ts:732-745,884-895; plugin/src/logging.ts:12-20).
- DSH process authority for verification, signing keys, Git notes provenance (plugin/src/verification.ts:478-500; scripts/attest-unit.cjs:82-95).

### Trust Boundaries

- Session messages to provider: agent/request scans session corpus; host assembles outbound payload afterward (plugin/src/index.ts:1583-1605,1694-1727; README.md:405).
- Architect tool calls to host: pre-execute write guard and optional post-execute source-read declarations are distinct hooks; host approval service grants exceptions (plugin/src/index.ts:1364-1403,1444-1578).
- Tool caller to delegate_worker: caller supplies instructions, targets, context and command; operator config sets endpoint, policy, key path. Containment checks workspace and target paths (plugin/src/index.ts:1148-1225; plugin/src/containment.ts:25-71; plugin/src/emission.ts:120-182).
- Model-selected verification command runs with DSH process authority after policy/approval using shell=true and cwd workspace (plugin/src/verification.ts:478-500).
- Registry and attestation bind verdicts to file hash, optional signed Git notes; CI can fetch notes for audit (plugin/src/contracts.ts:236-237,341-349; scripts/attest-unit.cjs:243-270; .github/workflows/ci.yml:89-110).

### Attacker Capabilities

- Untrusted user text can influence routing input but does not own host provider config or approval service (plugin/src/index.ts:1583-1605,1661-1725).
- Model/tool caller can propose task, context, target, workspaceDir and verification command but not select endpoint through tool argument (plugin/src/index.ts:1148-1225).
- Worker response can propose file content but emission checks path/scope (plugin/src/emission.ts:120-182).

### Security Objectives

- Keep credential and source-bearing messages away from unauthorized cloud destination, subject to hook visibility and configured provider identity (plugin/src/index.ts:1694-1803).
- Constrain delegated writes and prevent unverified or changed bytes from promotion (plugin/src/containment.ts:25-71; plugin/src/emission.ts:120-182; scripts/check-promotion.cjs:107-141).
- Require approval or explicit policy for host-authority verification (plugin/src/index.ts:1000-1042; plugin/src/verification.ts:478-500).
- Bind provenance to digests, identities and trust roots (scripts/attest-unit.cjs:243-270,377-402).

### Assumptions

- Actual DSH host profile/provider registration and approval semantics are outside repository (plugin/src/index.ts:1015-1042,1694-1703).
- Package bundle patch only registers plugin while manual registration script adds providers and dlpAction local; default installation needs separately configured providers (plugin/cordis.patch.yml:1-14; scripts/register-plugin.ps1:106-143).
- Configured local endpoint can be remote and differ from provider registry baseURL (plugin/README.md:125-151; plugin/src/delegation.ts:583-585).
- DLP cannot inspect final assembled outbound request (plugin/src/index.ts:1698-1703; README.md:405).
- Data root can be relative and derived paths then relative to process cwd (plugin/src/logging.ts:12-20).
- check-promotion is optional and is not invoked by root npm gate (scripts/check-promotion.cjs:3-25; package.json:35-39).

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Model-controlled tool arguments forge a human attestation](#finding-1) | medium | high | inline below |
| [Wrong workspace fallback permits raw directory search results](#finding-2) | medium | medium | inline below |
| [Contract check writes its stub outside its unique temporary directory](#finding-3) | medium | high | inline below |
| [Ranged context requests read entire files before enforcing the byte budget](#finding-4) | medium | high | inline below |
| [Cloud-only provider aliases bypass source-egress denial](#finding-5) | medium | high | inline below |
| [Credential history can be evicted before a retained cloud request](#finding-6) | medium | medium | inline below |
| [Directory-scoped shell searches expose source in declarations mode](#finding-7) | medium | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Model-controlled tool arguments forge a human attestation

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The model-visible schema, handler precedence, registry write and promotion consumer directly establish the path. |
| Category | Attestation and provenance forgery |
| CWE | CWE-345 |
| Affected lines | plugin/src/index.ts:1250, plugin/src/delegation.ts:163, plugin/src/contracts.ts:595, scripts/check-promotion.cjs:120 |

#### Summary

A model can provide the human name and evidence for OPERATOR_ATTESTED, causing a passing unit to be recorded as human reviewed without an operator action.

#### Root Cause

The attestation identity and evidence are accepted from the same model-controlled tool call that requests delegation. SUCCESS and file-scope checks prove a machine result and affected bytes, but no human review or approval is bound to the label.

**Model may name a human** — `plugin/src/delegation.ts:163`

The model-visible tool schema exposes the identity to be recorded as the human reviewer.

```typescript
attestOperator: {
  type: 'string',
  description:
```

**Caller identity and evidence are preferred** — `plugin/src/index.ts:1250`

The caller's string overrides the configured operator identity.

```typescript
const operator = String(attestOperator || options?.operatorIdentity || '').trim()
```

**Handler records attestation without separate review** — `plugin/src/index.ts:1274`

The evidence can also be supplied by the caller or fabricated from a default phrase before recordOperatorAttestation is called.

```typescript
const evidence =
  String(attestEvidence || '').trim() ||
  'operator reviewed the passing unit from delegation ' + String(verdict.taskName || '')
```

**Registry becomes operator-attested** — `plugin/src/contracts.ts:593`

The registry labels the passing file as human attested using the unverified name/evidence.

```typescript
const entry: DelegatedRecord = existing ?? { path: canonical, sha256: hash, at, mode: 'created' }
entry.sha256 = hash
entry.outcome = 'OPERATOR_ATTESTED'
```

**Promotion trusts attested status** — `scripts/check-promotion.cjs:120`

The promotion socket treats this provenance label as an acceptable result if bytes still match.

```javascript
if (record.outcome === 'OPERATOR_ATTESTED') {
  const current = sha256File(target)
```

#### Validation

The schema exposes attestOperator and attestEvidence; the handler prefers those arguments, records OPERATOR_ATTESTED, and check-promotion accepts that record. The verification approval prompt concerns the command, not attestation.

Validation method: Static source trace

**Model may name a human** — `plugin/src/delegation.ts:163`

The model-visible tool schema exposes the identity to be recorded as the human reviewer.

```typescript
attestOperator: {
  type: 'string',
  description:
```

**Caller identity and evidence are preferred** — `plugin/src/index.ts:1250`

The caller's string overrides the configured operator identity.

```typescript
const operator = String(attestOperator || options?.operatorIdentity || '').trim()
```

**Registry becomes operator-attested** — `plugin/src/contracts.ts:593`

The registry labels the passing file as human attested using the unverified name/evidence.

```typescript
const entry: DelegatedRecord = existing ?? { path: canonical, sha256: hash, at, mode: 'created' }
entry.sha256 = hash
entry.outcome = 'OPERATOR_ATTESTED'
```

**Promotion trusts attested status** — `scripts/check-promotion.cjs:120`

The promotion socket treats this provenance label as an acceptable result if bytes still match.

```javascript
if (record.outcome === 'OPERATOR_ATTESTED') {
  const current = sha256File(target)
```

Limitations:
- A unit must pass and the file must be in filesWritten.

#### Dataflow

model tool arguments -\> operator/evidence selection -\> recordOperatorAttestation -\> registry outcome -\> promotion

**Model may name a human** — `plugin/src/delegation.ts:163`

The model-visible tool schema exposes the identity to be recorded as the human reviewer.

```typescript
attestOperator: {
  type: 'string',
  description:
```

**Caller identity and evidence are preferred** — `plugin/src/index.ts:1250`

The caller's string overrides the configured operator identity.

```typescript
const operator = String(attestOperator || options?.operatorIdentity || '').trim()
```

**Registry becomes operator-attested** — `plugin/src/contracts.ts:593`

The registry labels the passing file as human attested using the unverified name/evidence.

```typescript
const entry: DelegatedRecord = existing ?? { path: canonical, sha256: hash, at, mode: 'created' }
entry.sha256 = hash
entry.outcome = 'OPERATOR_ATTESTED'
```

**Promotion trusts attested status** — `scripts/check-promotion.cjs:120`

The promotion socket treats this provenance label as an acceptable result if bytes still match.

```javascript
if (record.outcome === 'OPERATOR_ATTESTED') {
  const current = sha256File(target)
```

#### Reachability

Any architect agent able to call delegate_worker and produce a passing unit can request the label for files that unit wrote.

- **Attacker:** model controlling delegate_worker arguments

- **Entry point:** delegate_worker

- **Outcome:** false human-review provenance and an attested promotion result

Preconditions:
- unit status SUCCESS
- target appears in filesWritten

#### Severity

**Medium** — The false human-review record compromises provenance and may satisfy a promotion gate, although the affected file must first come from a successful machine-verified unit.

Severity rises where OPERATOR_ATTESTED is treated as a required human approval; it falls when consumers rely only on UNIT_PASSED and ignore attestation.

#### Remediation

Move attestation to an operator-controlled review action that binds the person's identity, evidence and exact file hashes; remove the fields from model-visible tool arguments.

Tests:
- Assert a model-supplied attestOperator cannot create OPERATOR_ATTESTED without a separate operator approval.

Preventive controls:
- Separate machine verification from human review in the tool and registry APIs.

<a id="finding-2"></a>

### [2] Wrong workspace fallback permits raw directory search results

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | The fallback and allow branch are direct; production host search behavior under a cwd mismatch was not reproduced. |
| Category | Source egress policy bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/index.ts:501, plugin/src/declaration-egress-hook.ts:118, plugin/src/declaration-egress.ts:375, plugin/dist/index.js:155 |

#### Summary

When the host process cwd differs from the session workspace, a relative source search may be treated as an unresolved prose scope and its raw result returned in declarations mode.

#### Root Cause

The workspace resolver silently substitutes process.cwd when it cannot prove the session workspace. The declarations search filter uses that path to classify a relative directory and treats a missing bare directory name as harmless prose.

**Unverified process cwd becomes workspace** — `plugin/src/index.ts:501`

The resolver returns a non-session path as if it were a valid workspace root.

```typescript
return { dir: process.cwd(), source: 'process.cwd() FALLBACK (not a Session workspace)' }
```

**Hook passes fallback as workspace** — `plugin/src/index.ts:1474`

The post-execute search check receives the fallback root without a confidence flag.

```typescript
const egressDecision = handleDeclarationPostExecute(
  exec,
  Object.assign({}, options, { workspaceRoot: sessionWorkspace })
)
```

**Relative scope is resolved under supplied root** — `plugin/src/declaration-egress-hook.ts:118`

A relative source directory is inspected under process cwd rather than the actual session workspace.

```typescript
const resolveScope = (scope: string): string =>
  resolveScopePath(scope, options?.workspaceRoot) || scope
```

**Unresolved one-segment scope is allowed** — `plugin/src/declaration-egress.ts:375`

The path-shaped fail-closed branch misses a bare directory name such as src; the later return allows it.

```typescript
if (input.workspaceRoot && looksLikePath(scope)) {
```

**Unresolved scope permitted** — `plugin/src/declaration-egress.ts:388`

After the bare scope misses looksLikePath, the evaluator allows the unmodified search output.

```typescript
return { action: 'allow' }
```

#### Validation

The fallback always returns a directory, so the hook's exception warning does not run. Under a cwd mismatch, directoryScope misses the real source directory and a bare scope is allowed.

Validation method: Static source trace

**Unverified process cwd becomes workspace** — `plugin/src/index.ts:501`

The resolver returns a non-session path as if it were a valid workspace root.

```typescript
return { dir: process.cwd(), source: 'process.cwd() FALLBACK (not a Session workspace)' }
```

**Hook passes fallback as workspace** — `plugin/src/index.ts:1474`

The post-execute search check receives the fallback root without a confidence flag.

```typescript
const egressDecision = handleDeclarationPostExecute(
  exec,
  Object.assign({}, options, { workspaceRoot: sessionWorkspace })
)
```

**Relative scope is resolved under supplied root** — `plugin/src/declaration-egress-hook.ts:118`

A relative source directory is inspected under process cwd rather than the actual session workspace.

```typescript
const resolveScope = (scope: string): string =>
  resolveScopePath(scope, options?.workspaceRoot) || scope
```

**Unresolved one-segment scope is allowed** — `plugin/src/declaration-egress.ts:375`

The path-shaped fail-closed branch misses a bare directory name such as src; the later return allows it.

```typescript
if (input.workspaceRoot && looksLikePath(scope)) {
```

**Unresolved scope permitted** — `plugin/src/declaration-egress.ts:388`

After the bare scope misses looksLikePath, the evaluator allows the unmodified search output.

```typescript
return { action: 'allow' }
```

Limitations:
- Requires a host search tool that resolves its relative scope against the session workspace while this plugin falls back to a different process cwd.

#### Dataflow

relative search scope -\> wrong workspace fallback -\> failed directory check -\> prose allow -\> raw result

**Unverified process cwd becomes workspace** — `plugin/src/index.ts:501`

The resolver returns a non-session path as if it were a valid workspace root.

```typescript
return { dir: process.cwd(), source: 'process.cwd() FALLBACK (not a Session workspace)' }
```

**Relative scope is resolved under supplied root** — `plugin/src/declaration-egress-hook.ts:118`

A relative source directory is inspected under process cwd rather than the actual session workspace.

```typescript
const resolveScope = (scope: string): string =>
  resolveScopePath(scope, options?.workspaceRoot) || scope
```

**Unresolved one-segment scope is allowed** — `plugin/src/declaration-egress.ts:375`

The path-shaped fail-closed branch misses a bare directory name such as src; the later return allows it.

```typescript
if (input.workspaceRoot && looksLikePath(scope)) {
```

**Unresolved scope permitted** — `plugin/src/declaration-egress.ts:388`

After the bare scope misses looksLikePath, the evaluator allows the unmodified search output.

```typescript
return { action: 'allow' }
```

#### Reachability

A cloud agent with a dedicated search tool can reach this path when no explicit session workspace is available to the plugin.

- **Attacker:** cloud agent controlling search scope

- **Entry point:** tools/post-execute search result

- **Outcome:** source search lines enter cloud context

Preconditions:
- declarations mode
- host/session cwd mismatch
- no resolved workspace env or service

#### Severity

**Medium** — The path can disclose source to a cloud agent in declarations mode, but requires a host/session cwd mismatch and no resolved workspace environment or service.

Severity rises if the supported host often has a separate process cwd and session workspace; it falls if workspace resolution is always explicit.

#### Remediation

Require a verified session workspace before permitting relative search output, or refuse unresolved relative scopes when workspace resolution uses process.cwd.

Tests:
- Simulate a session workspace different from process cwd and assert a bare source directory search is refused or substituted.

Preventive controls:
- Carry workspace resolution provenance to every source-egress decision.

<a id="finding-3"></a>

### [3] Contract check writes its stub outside its unique temporary directory

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | For the repository's normal contract/module layout, path.resolve deterministically lands outside mirrorRoot. |
| Category | Temporary path escape and unsafe file write |
| CWE | CWE-22 |
| Affected lines | scripts/check-contract.cjs:151, scripts/check-contract.cjs:153 |

#### Summary

The contract null-test flattens the mirrored test path but reuses the original relative module path, causing the stub write to escape into a shared temporary path.

#### Root Cause

The mirror changes the test's directory depth but reuses a relative module path computed in the original tree. The resolved stub path can leave mirrorRoot before writeFileSync.

**Unique root and flattened mirror** — `scripts/check-contract.cjs:139`

A unique temporary directory is created for the null test.

```javascript
const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-null-'))
```

**Only immediate parent name is retained** — `scripts/check-contract.cjs:142`

The mirrored test loses its original directory depth.

```javascript
const mirrorPath = path.join(
  mirrorRoot,
  path.basename(path.dirname(testFile)),
  path.basename(testFile)
)
```

**Original relative module path escapes mirror** — `scripts/check-contract.cjs:150`

For tests/contracts/x.contract.cjs to tools/x.ts, the ../../tools path resolves to a shared temp/tools/x.ts outside mirrorRoot and is written.

```javascript
const relative = path.relative(path.dirname(testFile), modulePath)
const mirrorModule = path.resolve(path.dirname(mirrorPath), relative)
fs.mkdirSync(path.dirname(mirrorModule), { recursive: true })
fs.writeFileSync(mirrorModule, NULL_IMPLEMENTATION, 'utf8')
```

#### Validation

The standard tests/contracts to tools relative path is ../../tools/x.ts. From mirrorRoot/contracts this resolves to the parent temp directory's tools/x.ts. The script writes that path without a containment check.

Validation method: Static path calculation

**Unique root and flattened mirror** — `scripts/check-contract.cjs:139`

A unique temporary directory is created for the null test.

```javascript
const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-null-'))
```

**Only immediate parent name is retained** — `scripts/check-contract.cjs:142`

The mirrored test loses its original directory depth.

```javascript
const mirrorPath = path.join(
  mirrorRoot,
  path.basename(path.dirname(testFile)),
  path.basename(testFile)
)
```

**Original relative module path escapes mirror** — `scripts/check-contract.cjs:150`

For tests/contracts/x.contract.cjs to tools/x.ts, the ../../tools path resolves to a shared temp/tools/x.ts outside mirrorRoot and is written.

```javascript
const relative = path.relative(path.dirname(testFile), modulePath)
const mirrorModule = path.resolve(path.dirname(mirrorPath), relative)
fs.mkdirSync(path.dirname(mirrorModule), { recursive: true })
fs.writeFileSync(mirrorModule, NULL_IMPLEMENTATION, 'utf8')
```

Limitations:
- A redirected write to another target requires a preplaced local link or file at the shared temporary path.

#### Dataflow

contract/module paths -\> flattened mirror path -\> original ../../ module path -\> writeFileSync outside mirrorRoot

**Only immediate parent name is retained** — `scripts/check-contract.cjs:142`

The mirrored test loses its original directory depth.

```javascript
const mirrorPath = path.join(
  mirrorRoot,
  path.basename(path.dirname(testFile)),
  path.basename(testFile)
)
```

**Original relative module path escapes mirror** — `scripts/check-contract.cjs:150`

For tests/contracts/x.contract.cjs to tools/x.ts, the ../../tools path resolves to a shared temp/tools/x.ts outside mirrorRoot and is written.

```javascript
const relative = path.relative(path.dirname(testFile), modulePath)
const mirrorModule = path.resolve(path.dirname(mirrorPath), relative)
fs.mkdirSync(path.dirname(mirrorModule), { recursive: true })
fs.writeFileSync(mirrorModule, NULL_IMPLEMENTATION, 'utf8')
```

#### Reachability

The repository's standard contract layout triggers the out-of-root write whenever check-contract runs; cross-target redirection requires local temp-path control.

- **Attacker:** local process with access to shared temp path

- **Entry point:** contract gate invocation

- **Outcome:** gate writes under its authority outside owned temporary tree

Preconditions:
- gate runner can write to temp/tools path
- attacker can preplace a suitable link for cross-target redirection

#### Severity

**Medium** — The gate performs an unintended write outside its unique temporary directory. A local process that can preplace a link at that predictable path may redirect it under the gate runner's authority; the path requires local filesystem access.

Severity rises if the gate runs with elevated or shared CI authority and the temporary directory is writable by another actor; it falls in a private single-user temp directory without link redirection.

#### Remediation

Mirror the full relative test directory inside mirrorRoot, resolve the stub path from that layout, and verify containment before writing.

Tests:
- For tests/contracts/x.contract.cjs and tools/x.ts, assert the stub path remains inside mirrorRoot and no file is written in the shared temp parent.

Preventive controls:
- Resolve and containment-check every generated path before filesystem mutation.

<a id="finding-4"></a>

### [4] Ranged context requests read entire files before enforcing the byte budget

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The range conditional skips statSync and the readFileSync/split occur before the byte check. |
| Category | Resource exhaustion |
| CWE | CWE-400 |
| Affected lines | plugin/src/context.ts:70, plugin/src/context.ts:88, plugin/src/delegation.ts:620, plugin/dist/context.js:71 |

#### Summary

A caller can request one line of a large workspace file, causing the plugin to load and split the entire file before applying its 32 KiB context limit.

#### Root Cause

The code exempts ranged requests from the file-size precheck but still reads and splits the whole file. The byte budget applies only to the selected output after allocation.

**Model-selected context files** — `plugin/src/delegation.ts:620`

Caller-controlled line ranges reach resolveContextFiles.

```typescript
const declaredContext = Array.isArray(params.contextFiles) ? params.contextFiles : []
let context = resolveContextFiles(declaredContext, workspaceBase)
```

**Range bypasses size precheck** — `plugin/src/context.ts:70`

Any line-range field skips the pre-read file-size check.

```typescript
const declaresRange = request.startLine !== undefined || request.endLine !== undefined
if (!declaresRange) {
```

**Whole file allocated before budget** — `plugin/src/context.ts:88`

The full file and line array are allocated before the selected slice is measured.

```typescript
raw = fs.readFileSync(resolvedPath, 'utf8')
```

**Full content split into lines** — `plugin/src/context.ts:94`

The full string is copied into a line array before a requested slice or output budget is calculated.

```typescript
const allLines = raw.split('\n')
```

#### Validation

A range causes the stat guard to be skipped and readFileSync plus split to process the whole file before the budget check. Containment limits path, not size.

Validation method: Static source trace

**Model-selected context files** — `plugin/src/delegation.ts:620`

Caller-controlled line ranges reach resolveContextFiles.

```typescript
const declaredContext = Array.isArray(params.contextFiles) ? params.contextFiles : []
let context = resolveContextFiles(declaredContext, workspaceBase)
```

**Range bypasses size precheck** — `plugin/src/context.ts:70`

Any line-range field skips the pre-read file-size check.

```typescript
const declaresRange = request.startLine !== undefined || request.endLine !== undefined
if (!declaresRange) {
```

**Whole file allocated before budget** — `plugin/src/context.ts:88`

The full file and line array are allocated before the selected slice is measured.

```typescript
raw = fs.readFileSync(resolvedPath, 'utf8')
```

**Full content split into lines** — `plugin/src/context.ts:94`

The full string is copied into a line array before a requested slice or output budget is calculated.

```typescript
const allLines = raw.split('\n')
```

Limitations:
- No large-file runtime reproduction was run.

#### Dataflow

contextFiles -\> resolveContextFiles -\> skipped stat guard -\> readFileSync and split -\> late byte check

**Model-selected context files** — `plugin/src/delegation.ts:620`

Caller-controlled line ranges reach resolveContextFiles.

```typescript
const declaredContext = Array.isArray(params.contextFiles) ? params.contextFiles : []
let context = resolveContextFiles(declaredContext, workspaceBase)
```

**Range bypasses size precheck** — `plugin/src/context.ts:70`

Any line-range field skips the pre-read file-size check.

```typescript
const declaresRange = request.startLine !== undefined || request.endLine !== undefined
if (!declaresRange) {
```

**Whole file allocated before budget** — `plugin/src/context.ts:88`

The full file and line array are allocated before the selected slice is measured.

```typescript
raw = fs.readFileSync(resolvedPath, 'utf8')
```

**Full content split into lines** — `plugin/src/context.ts:94`

The full string is copied into a line array before a requested slice or output budget is calculated.

```typescript
const allLines = raw.split('\n')
```

#### Reachability

An architect agent can choose contextFiles on delegate_worker when a large workspace file is present.

- **Attacker:** model controlling delegate_worker contextFiles

- **Entry point:** delegate_worker

- **Outcome:** DSH process memory or responsiveness is exhausted

Preconditions:
- a sufficiently large readable file exists within allowed roots

#### Severity

**Medium** — A model able to select contextFiles can stall or exhaust the DSH process when a sufficiently large workspace file exists; path containment and final output limits do not constrain temporary allocation.

Severity rises in workspaces with very large generated files or a shared DSH process; it falls if the host already limits readable file sizes.

#### Remediation

Stream line ranges with bounded buffering and enforce a maximum read size before allocating the full file.

Tests:
- Request one line of an oversized file and assert the request is rejected without loading the whole file.

Preventive controls:
- Apply read-size limits before file allocation on every context path.

<a id="finding-5"></a>

### [5] Cloud-only provider aliases bypass source-egress denial

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The classification and second destination calculation disagree directly in source and in the shipped dist build. |
| Category | Source egress policy bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/index.ts:1789, plugin/src/routing.ts:105, plugin/src/roles.ts:72, plugin/dist/index.js:1278 |

#### Summary

When localProvider and cloudProvider are the same ID, a cloud-bound request with detected source is relabeled local and bypasses sourceEgress: deny.

#### Root Cause

The hook discards the already-calculated effective destination and infers locality from provider ID equality. When localProvider equals cloudProvider, that inference contradicts classifyDestination and disables the deny policy.

**Aliased providers are cloud** — `plugin/src/routing.ts:105`

The classifier correctly treats an aliased local provider as cloud.

```typescript
const effectiveDestination: 'cloud' | 'local' = !isCloudOnly && dest === local ? 'local' : 'cloud'
```

**Hook recomputes destination** — `plugin/src/index.ts:1789`

The second comparison drops the classifier's isCloudOnly condition, relabeling the same provider local.

```typescript
const destination: 'cloud' | 'local' =
  rerouteLocal ||
  String(mutatedConfig.provider || '').toLowerCase() ===
    String(config.localProvider || '').toLowerCase()
    ? 'local'
    : 'cloud'
```

**Source policy trusts local label** — `plugin/src/roles.ts:72`

The erroneous local label causes source-egress evaluation to allow the request.

```typescript
if (destination === 'local') {
  return {
    kind: 'allow',
    reason: 'the request is bound for the local worker, so nothing is leaving the machine',
  }
}
```

#### Validation

The cloud-only alias is identified by classifyDestination, then index.ts recomputes local and evaluateSourceEgress allows it. Credential DLP may still block a credential-bearing request.

Validation method: Static source trace and shipped build comparison

**Aliased providers are cloud** — `plugin/src/routing.ts:105`

The classifier correctly treats an aliased local provider as cloud.

```typescript
const effectiveDestination: 'cloud' | 'local' = !isCloudOnly && dest === local ? 'local' : 'cloud'
```

**Hook recomputes destination** — `plugin/src/index.ts:1789`

The second comparison drops the classifier's isCloudOnly condition, relabeling the same provider local.

```typescript
const destination: 'cloud' | 'local' =
  rerouteLocal ||
  String(mutatedConfig.provider || '').toLowerCase() ===
    String(config.localProvider || '').toLowerCase()
    ? 'local'
    : 'cloud'
```

**Source policy trusts local label** — `plugin/src/roles.ts:72`

The erroneous local label causes source-egress evaluation to allow the request.

```typescript
if (destination === 'local') {
  return {
    kind: 'allow',
    reason: 'the request is bound for the local worker, so nothing is leaving the machine',
  }
}
```

Limitations:
- Requires an aliased provider configuration and a source-bearing request without a credential DLP hit.

#### Dataflow

provider config -\> classifyDestination cloud -\> second provider equality local -\> evaluateSourceEgress allow -\> outbound cloud request

**Aliased providers are cloud** — `plugin/src/routing.ts:105`

The classifier correctly treats an aliased local provider as cloud.

```typescript
const effectiveDestination: 'cloud' | 'local' = !isCloudOnly && dest === local ? 'local' : 'cloud'
```

**Hook recomputes destination** — `plugin/src/index.ts:1789`

The second comparison drops the classifier's isCloudOnly condition, relabeling the same provider local.

```typescript
const destination: 'cloud' | 'local' =
  rerouteLocal ||
  String(mutatedConfig.provider || '').toLowerCase() ===
    String(config.localProvider || '').toLowerCase()
    ? 'local'
    : 'cloud'
```

**Source policy trusts local label** — `plugin/src/roles.ts:72`

The erroneous local label causes source-egress evaluation to allow the request.

```typescript
if (destination === 'local') {
  return {
    kind: 'allow',
    reason: 'the request is bound for the local worker, so nothing is leaving the machine',
  }
}
```

#### Reachability

A cloud architect session with aliased provider IDs can trigger the path by sending detected source in a prompt.

- **Attacker:** agent or user controlling prompt text

- **Entry point:** agent/request hook

- **Outcome:** detected source reaches cloud provider

Preconditions:
- localProvider and cloudProvider use the same ID
- credential DLP does not block the request

#### Severity

**Medium** — The bypass can disclose implementation source to a cloud provider, but requires a cloud-only provider alias and source-bearing request that does not trip credential DLP.

Severity rises if cloud-only aliases are common in deployment and private source is routinely included in prompts; it falls if distinct provider IDs are enforced.

#### Remediation

Pass classification.destination to source-egress evaluation, changing it only when an actual local reroute occurs.

Tests:
- With aliased provider IDs and sourceEgress deny, assert that a detected source prompt is refused.

Preventive controls:
- Centralize destination classification and use its result for both DLP and source-egress decisions.

<a id="finding-6"></a>

### [6] Credential history can be evicted before a retained cloud request

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | The bounded corpus and DLP input are clear, but exact host retention after that threshold was not observed. |
| Category | Credential egress policy bypass |
| CWE | CWE-200 |
| Affected lines | plugin/src/index.ts:878, plugin/src/index.ts:1701, plugin/dist/index.js:443 |

#### Summary

After more than 200,000 later characters, the DLP corpus forgets an earlier credential even if the host still includes that turn in a cloud request.

#### Root Cause

The gate uses a bounded suffix of session user text as a proxy for all content the host may resend. It does not retain a sticky sensitive-data state when old text is truncated.

**DLP history is truncated** — `plugin/src/index.ts:875`

Earlier credential-bearing text is discarded once later distinct text exceeds the cap.

```typescript
const combined = existing ? `${existing}\n${text}` : text
sessionPromptCorpus.set(
  target,
  combined.length > SESSION_CORPUS_MAX_CHARS
    ? combined.slice(combined.length - SESSION_CORPUS_MAX_CHARS)
    : combined
)
```

**Request gate scans only retained corpus or latest prompt** — `plugin/src/index.ts:1701`

The DLP scan cannot detect an earlier credential that neither selected string contains.

```typescript
const corpus = sessionPromptCorpus.get(corpusKeyFor(payload)) || ''
const dlpSubject = corpus.length > prompt.length ? corpus : prompt
const dlpResult = scanDLP(dlpSubject, {
```

#### Validation

The corpus drops its prefix after 200,000 characters and the request hook scans only that suffix or the current prompt. Exposure additionally depends on host retaining the earlier turn.

Validation method: Static source trace

**DLP history is truncated** — `plugin/src/index.ts:875`

Earlier credential-bearing text is discarded once later distinct text exceeds the cap.

```typescript
const combined = existing ? `${existing}\n${text}` : text
sessionPromptCorpus.set(
  target,
  combined.length > SESSION_CORPUS_MAX_CHARS
    ? combined.slice(combined.length - SESSION_CORPUS_MAX_CHARS)
    : combined
)
```

**Request gate scans only retained corpus or latest prompt** — `plugin/src/index.ts:1701`

The DLP scan cannot detect an earlier credential that neither selected string contains.

```typescript
const corpus = sessionPromptCorpus.get(corpusKeyFor(payload)) || ''
const dlpSubject = corpus.length > prompt.length ? corpus : prompt
const dlpResult = scanDLP(dlpSubject, {
```

Limitations:
- The host's real compaction behavior at this length was not measured.

#### Dataflow

session messages -\> bounded corpus suffix -\> DLP no hit -\> host outbound request

**DLP history is truncated** — `plugin/src/index.ts:875`

Earlier credential-bearing text is discarded once later distinct text exceeds the cap.

```typescript
const combined = existing ? `${existing}\n${text}` : text
sessionPromptCorpus.set(
  target,
  combined.length > SESSION_CORPUS_MAX_CHARS
    ? combined.slice(combined.length - SESSION_CORPUS_MAX_CHARS)
    : combined
)
```

**Request gate scans only retained corpus or latest prompt** — `plugin/src/index.ts:1701`

The DLP scan cannot detect an earlier credential that neither selected string contains.

```typescript
const corpus = sessionPromptCorpus.get(corpusKeyFor(payload)) || ''
const dlpSubject = corpus.length > prompt.length ? corpus : prompt
const dlpResult = scanDLP(dlpSubject, {
```

#### Reachability

A session participant can append enough benign text after a credential-bearing turn if the host keeps that turn in outbound context.

- **Attacker:** session participant able to extend conversation

- **Entry point:** agent/request

- **Outcome:** earlier credential reaches cloud provider

Preconditions:
- earlier credential remains in host outbound history
- more than 200,000 later corpus characters

#### Severity

**Medium** — A credential can be exposed to a cloud provider, but the path requires a long session where host context retains the earlier turn after the plugin evicts it.

Severity rises if the host routinely retains more than 200,000 characters of history; it falls if compaction always removes the credential-bearing turn first.

#### Remediation

Keep a per-session sticky DLP verdict independent of the bounded corpus and clear it only when the host proves the sensitive turn is absent from outbound history.

Tests:
- Retain a credential-bearing turn beyond corpus eviction and assert a later cloud request remains blocked.

Preventive controls:
- Track sensitive-history state separately from bounded text caches.

<a id="finding-7"></a>

### [7] Directory-scoped shell searches expose source in declarations mode

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The shell branch and filename predicate directly allow a content-reading command without a source extension. |
| Category | Source egress policy bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/declaration-egress.ts:406, plugin/src/declaration-egress-hook.ts:112, plugin/src/index.ts:1474, plugin/dist/declaration-egress.js:338 |

#### Summary

A shell content search over a directory can return implementation lines to the cloud agent because the declarations filter blocks only commands that name a source filename.

#### Root Cause

The shell egress guard uses the presence of a source filename as a proxy for whether the command can read source. Directory-scoped commands can read source without naming an extension.

**Shell command is evaluated** — `plugin/src/declaration-egress-hook.ts:100`

The model-controlled shell command becomes the target for the egress evaluator.

```typescript
const target =
  toolKind === 'search'
    ? String(args.path ?? args.directory ?? args.target ?? '')
    : String(args.command ?? args.cmd ?? '')
```

**Only literal code-looking token counts** — `plugin/src/declaration-egress-hook.ts:112`

A directory-only search command has no code-extension token and fails this test.

```typescript
const commandNamesSource = (cmd: string): boolean => longestCodeReference(cmd) !== undefined
```

**Content search is allowed unless both predicates match** — `plugin/src/declaration-egress.ts:406`

A content-reading command over a directory evaluates reads true and names false, so original output is allowed.

```typescript
const reads = input.commandReadsContent(target) === true
const names = input.commandNamesSource(target) === true
if (reads && names) {
```

**Shell result permitted** — `plugin/src/declaration-egress.ts:418`

With reads true and names false, execution falls through to allow and the original tool result is returned.

```typescript
return { action: 'allow' }
```

#### Validation

The shell output route checks commandReadsContent and commandNamesSource; a directory-scoped rg command passes the first and fails the second, producing allow. Dedicated search tools have a separate directory-aware route.

Validation method: Static source trace

**Shell command is evaluated** — `plugin/src/declaration-egress-hook.ts:100`

The model-controlled shell command becomes the target for the egress evaluator.

```typescript
const target =
  toolKind === 'search'
    ? String(args.path ?? args.directory ?? args.target ?? '')
    : String(args.command ?? args.cmd ?? '')
```

**Only literal code-looking token counts** — `plugin/src/declaration-egress-hook.ts:112`

A directory-only search command has no code-extension token and fails this test.

```typescript
const commandNamesSource = (cmd: string): boolean => longestCodeReference(cmd) !== undefined
```

**Content search is allowed unless both predicates match** — `plugin/src/declaration-egress.ts:406`

A content-reading command over a directory evaluates reads true and names false, so original output is allowed.

```typescript
const reads = input.commandReadsContent(target) === true
const names = input.commandNamesSource(target) === true
if (reads && names) {
```

**Shell result permitted** — `plugin/src/declaration-egress.ts:418`

With reads true and names false, execution falls through to allow and the original tool result is returned.

```typescript
return { action: 'allow' }
```

Limitations:
- No live DSH shell execution was performed.

#### Dataflow

shell arguments -\> filename predicate -\> allow verdict -\> raw tool result to cloud agent

**Shell command is evaluated** — `plugin/src/declaration-egress-hook.ts:100`

The model-controlled shell command becomes the target for the egress evaluator.

```typescript
const target =
  toolKind === 'search'
    ? String(args.path ?? args.directory ?? args.target ?? '')
    : String(args.command ?? args.cmd ?? '')
```

**Only literal code-looking token counts** — `plugin/src/declaration-egress-hook.ts:112`

A directory-only search command has no code-extension token and fails this test.

```typescript
const commandNamesSource = (cmd: string): boolean => longestCodeReference(cmd) !== undefined
```

**Content search is allowed unless both predicates match** — `plugin/src/declaration-egress.ts:406`

A content-reading command over a directory evaluates reads true and names false, so original output is allowed.

```typescript
const reads = input.commandReadsContent(target) === true
const names = input.commandNamesSource(target) === true
if (reads && names) {
```

**Shell result permitted** — `plugin/src/declaration-egress.ts:418`

With reads true and names false, execution falls through to allow and the original tool result is returned.

```typescript
return { action: 'allow' }
```

#### Reachability

A cloud architect with shell tool access can search a source directory in a declarations-mode session.

- **Attacker:** cloud architect controlling shell tool arguments

- **Entry point:** tools/post-execute

- **Outcome:** implementation lines enter model context

Preconditions:
- sourceReadEgress is declarations
- shell tool available

#### Severity

**Medium** — The leak requires declarations mode, shell tool access and a directory-scoped content search; it exposes source that the mode promises to replace with declarations.

Severity rises when shell search is commonly available to cloud agents and source is sensitive; it falls when shell tools are unavailable.

#### Remediation

Resolve the files a shell content search may read before releasing its output, or refuse content-reading shell commands whose source reach cannot be established.

Tests:
- Assert a directory-scoped shell search over source is refused or substituted in declarations mode.

Preventive controls:
- Use one file-scope evaluator for dedicated search and shell search routes.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Baseline source review | Source egress and context handling | Reported | Fully reviewed context, containment, paths, declaration egress, classifier, logging and patch scripts. Source egress and context budget findings confirmed. |
| Delegation, emission and provenance | Host command, workspace and attestation authority | Reported | Reviewed delegation, context, verification, emission, containment, contracts, cryptographic attestation and promotion. Model-supplied human attestation confirmed; command approval and file containment held under stated attacker capabilities. |
| Routing and source egress | Cloud destination and source output controls | Reported | Reviewed routing, classifier, source egress, roles, index hook and shipped dist controls. Provider alias, shell directory, workspace fallback and long-session DLP issues confirmed, with deployment prerequisites in findings. |
| Contract gate and CI scripts | Temporary file write and CI integrity | Reported | Reviewed contract gate, fixture gate, promotion, selected ledger and CI scripts. Contract null-test writes outside its unique temporary directory. |
| Promotion check when Git diff fails | Conditional gate fail-open | Rejected | check-promotion --changed can return success with an empty registry after Git diff failure, but this requires a broken Git environment and no attacker path through the normal repository CI workflow was established (scripts/check-promotion.cjs:189-203,239). |

## Open Questions And Follow Up

- Confirm whether the installed DSH host retains session turns after 200,000 later characters and whether its search tool resolves relative paths against a workspace distinct from process cwd.
- Review remaining tests, documentation, and historical experiments individually if exhaustive repository coverage is required.
- Confirm installed provider IDs and sourceReadEgress/sourceEgress settings to prioritize the source exposure findings.
- Product paths were prioritized. Remaining tests, historical experiments, and documentation were searched for credentials and sampled for security behavior but not individually fully audited.
  - Follow-up prompt: Review deferred unit remaining-scope and close its stated proof gap. Paths: plugin/tests, tests, docs, experiments.
