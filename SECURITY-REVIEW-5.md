# Security Review: DSHLaya

## Scope

Focused security delta from 8cb69708 to 3063ec7, covering seven original findings and schema drift.

- Scan mode: branch_diff
- Target kind: git_diff
- Target ID: target_sha256_eb365aafc1f57b8c54cfecffcf9ecc59b9809adde9df8308d013df48ac399b9b
- Revision range: 8cb69708e32445b1dee0503bbaa08ca8a842cffe...3063ec7a40ac0c4fbc1a0cc821be508c10eec056
- Snapshot digest: codex-security-snapshot/v1:sha256:383940a6eeed5b53fbaf5f81f47b346452fdf8233f7cb72213797c69173e7f13
- Inventory strategy: diff
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: plugin/src, plugin/dist, scripts/check-contract.cjs, plugin/tests/oracles, SECURITY-REVIEW-4.md

Limitations and exclusions:
- Host search-root behavior is deployment-dependent.
- Cross-drive test skipped due no free drive letter.
- Nonregular context-file edge untested on Windows.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 3 |
| Severity mix | medium: 3 |
| Confidence mix | high: 3 |
| Coverage | complete |
| Validation mode | Static source trace, shipped-dist read-only reproductions, focused oracle tests |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

The DSH Cordis plugin registers delegate_worker and in-process agent/request, tools/pre-execute, and tools/post-execute hooks. The request hook classifies provider destination and gates credential/source egress; the post-execute hook controls source returned by tools. delegate_worker sends selected workspace context to a configured worker, emits files, and may run operator-configured verification. Contract and promotion scripts provide local CI gates (plugin/src/index.ts:1173,1339-1340,1427,1644,1709,1793; plugin/src/delegation.ts:657,891-920; scripts/check-contract.cjs:196-234).

### Assets

- Workspace source and file integrity governed by egress, delegation and contract gates (plugin/src/index.ts:1427,1793; scripts/check-contract.cjs:196-234).
- Session credentials and source that must not reach an unintended cloud provider (plugin/src/index.ts:1644,1709,1793).
- Provenance of human review and promotion records (plugin/src/index.ts:149; scripts/check-promotion.cjs:107-136).

### Trust Boundaries

- Model-visible delegate_worker arguments to file/context operations and verification authority (plugin/src/index.ts:1173; plugin/src/delegation.ts:657,891-920).
- Host session messages to provider selection and outbound source/credential egress (plugin/src/index.ts:1644,1709,1793).
- Tool output to cloud model through post-execute declarations filter (plugin/src/index.ts:1427).
- Contract checker to OS temporary filesystem (scripts/check-contract.cjs:196-234).

### Attacker Capabilities

- Cloud architect can supply prompt, tool arguments, relative search scopes and shell searches but not operator configuration or private signing keys.
- Local process may interact with shared temporary paths where OS permissions allow; CI gate authority may differ.

### Security Objectives

- Human attestation must require an operator action separate from model delegation.
- Unverified workspace resolution and source-reading directory commands must not release raw implementation output in declarations mode.
- Context file size limits must apply before allocation; provider destination must be classified consistently; credential state must survive corpus truncation.
- Null-test stubs must remain inside their unique temporary mirror; registered tool parameters must match an immutable canonical schema.

### Assumptions

- Review concerns the changed revision and source-backed paths; installed DSH host behavior is not reproduced.
- Operator config, actual provider endpoints, session retention and process cwd can affect exploitability.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Pre-role destination classification allows source on a cloud-bound architect request](#finding-1) | medium | high | inline below |
| [Quoted directory searches bypass declarations filtering](#finding-2) | medium | high | inline below |
| [Unverified workspace fallback still raw-allows a directory search](#finding-3) | medium | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Pre-role destination classification allows source on a cloud-bound architect request

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Shipped-dist reproduction: host lm-studio, localProvider lm-studio, cloudProvider deepseek-official =\> classification local; final provider deepseek-official. |
| Category | Source egress bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/index.ts:1788, plugin/src/index.ts:1709, plugin/src/index.ts:1767, plugin/src/roles.ts:72 |

#### Summary

The source gate trusts a local classification computed before architect role pinning changes the actual provider to cloudProvider.

#### Root Cause

The source gate trusts a local classification computed before architect role pinning changes the actual provider to cloudProvider.

#### Validation

Shipped-dist reproduction: host lm-studio, localProvider lm-studio, cloudProvider deepseek-official =\> classification local; final provider deepseek-official.

Validation method: Static source trace and read-only shipped-dist reproduction

Limitations:
- Installed host integration was not exercised.

#### Dataflow

The canonical finding records the affected path at plugin/src/index.ts:1788, plugin/src/index.ts:1709, plugin/src/index.ts:1767, plugin/src/roles.ts:72, but no expanded source-to-sink narrative was recorded.

#### Reachability

The source gate trusts a local classification computed before architect role pinning changes the actual provider to cloudProvider.

- **Attacker:** model or session content author

- **Entry point:** post-execute or agent/request hook

- **Outcome:** source egress control allows raw implementation

Preconditions:
- architect role
- host provider is localProvider
- distinct cloudProvider
- detectable source
- no DLP block

#### Severity

**Medium** — The flaw bypasses a source egress boundary and can expose implementation text to a cloud model.

architect role; host provider is localProvider; distinct cloudProvider; detectable source; no DLP block

#### Remediation

Evaluate source egress against final mutated provider while preserving cloud-only alias behavior.

Tests:
- Add a focused regression oracle for the stated preconditions.

<a id="finding-2"></a>

### [2] Quoted directory searches bypass declarations filtering

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Shipped-dist reproduction: rg SECRET "code space" with code space/secret.ts returns null (raw allow); rg SECRET src blocks. |
| Category | Source egress bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/declaration-egress-hook.ts:144, plugin/src/declaration-egress.ts:471 |

#### Summary

The shell directory detector splits quoted paths on spaces, so a source directory with whitespace is raw-allowed.

#### Root Cause

The shell directory detector splits quoted paths on spaces, so a source directory with whitespace is raw-allowed.

#### Validation

Shipped-dist reproduction: rg SECRET "code space" with code space/secret.ts returns null (raw allow); rg SECRET src blocks.

Validation method: Static source trace and read-only shipped-dist reproduction

Limitations:
- Installed host integration was not exercised.

#### Dataflow

The canonical finding records the affected path at plugin/src/declaration-egress-hook.ts:144, plugin/src/declaration-egress.ts:471, but no expanded source-to-sink narrative was recorded.

#### Reachability

The shell directory detector splits quoted paths on spaces, so a source directory with whitespace is raw-allowed.

- **Attacker:** model or session content author

- **Entry point:** post-execute or agent/request hook

- **Outcome:** source egress control allows raw implementation

Preconditions:
- declarations mode
- content-reading shell command
- quoted source directory name

#### Severity

**Medium** — The flaw bypasses a source egress boundary and can expose implementation text to a cloud model.

declarations mode; content-reading shell command; quoted source directory name

#### Remediation

Use quote-aware command parsing or fail closed when a content-reading command's scope cannot be resolved.

Tests:
- Add a focused regression oracle for the stated preconditions.

<a id="finding-3"></a>

### [3] Unverified workspace fallback still raw-allows a directory search

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Shipped-dist reproduction: real/src has source, guessed/src empty, workspaceVerified false, grep path src returns null (raw allow). |
| Category | Source egress bypass |
| CWE | CWE-201 |
| Affected lines | plugin/src/declaration-egress.ts:353, plugin/src/declaration-egress.ts:410, plugin/src/declaration-egress-hook.ts:228 |

#### Summary

An unrelated cwd with an empty same-named directory makes declarations mode pass raw search results from the real workspace.

#### Root Cause

An unrelated cwd with an empty same-named directory makes declarations mode pass raw search results from the real workspace.

#### Validation

Shipped-dist reproduction: real/src has source, guessed/src empty, workspaceVerified false, grep path src returns null (raw allow).

Validation method: Static source trace and read-only shipped-dist reproduction

Limitations:
- Installed host integration was not exercised.

#### Dataflow

The canonical finding records the affected path at plugin/src/declaration-egress.ts:353, plugin/src/declaration-egress.ts:410, plugin/src/declaration-egress-hook.ts:228, but no expanded source-to-sink narrative was recorded.

#### Reachability

An unrelated cwd with an empty same-named directory makes declarations mode pass raw search results from the real workspace.

- **Attacker:** model or session content author

- **Entry point:** post-execute or agent/request hook

- **Outcome:** source egress control allows raw implementation

Preconditions:
- declarations mode
- host search root differs from cwd fallback
- same-named empty directory in cwd

#### Severity

**Medium** — The flaw bypasses a source egress boundary and can expose implementation text to a cloud model.

declarations mode; host search root differs from cwd fallback; same-named empty directory in cwd

#### Remediation

Check unverified workspace provenance before every relative-scope allow; block if unknown.

Tests:
- Add a focused regression oracle for the stated preconditions.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| plugin/src/context.ts | Changed security-sensitive source | No issue found | Focused delta source review completed. |
| plugin/src/contracts.ts | Changed security-sensitive source | No issue found | Focused delta source review completed. |
| plugin/src/declaration-egress-hook.ts | Changed security-sensitive source | Reported | Focused delta source review completed. |
| plugin/src/declaration-egress.ts | Changed security-sensitive source | Reported | Focused delta source review completed. |
| plugin/src/delegation.ts | Changed security-sensitive source | No issue found | Focused delta source review completed. |
| plugin/src/index.ts | Changed security-sensitive source | Reported | Focused delta source review completed. |
| scripts/check-contract.cjs | Changed security-sensitive source | No issue found | Focused delta source review completed. |

## Open Questions And Follow Up

- Nonregular context paths may bypass a proven read bound; reachability depends on host filesystem.
