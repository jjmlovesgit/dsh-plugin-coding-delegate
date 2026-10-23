# Security Review: DSHLaya

## Scope

Static review of current revision 441f0042d669dbf732945ab322d0c472194360bf.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_eb365aafc1f57b8c54cfecffcf9ecc59b9809adde9df8308d013df48ac399b9b
- Revision: 441f0042d669dbf732945ab322d0c472194360bf
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Artifacts reviewed: plugin/src, scripts, plugin/tests, docs/security

Limitations and exclusions:
- Conditional prerequisites are stated in findings.
- Focused high-risk coverage; not every one of 351 files read line by line.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 9 |
| Severity mix | high: 1, medium: 8 |
| Confidence mix | high: 7, medium: 2 |
| Coverage | partial |
| Validation mode | Read-only source trace |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

DSHLaya is a Cordis plugin that mediates DSH agent requests, tool calls and delegated local-worker jobs. The request hook selects providers and gates credential/source egress; pre/post tool hooks restrict writes and source reads; delegate_worker injects bounded context, emits code and runs policy-governed verification. Separately invoked scripts prepare/approve signed Git-note attestations and gate promotion (plugin/src/index.ts:1151-1203,1430-1473,1674-1832; plugin/src/delegation.ts:880-927,1036-1058; scripts/attest-unit.cjs:234-260).

### Assets

- Workspace source and generated file integrity (plugin/src/emission.ts:62-100; plugin/src/context.ts:45-64).
- Session prompts, credentials and source withheld from unintended cloud destinations (plugin/src/index.ts:1700-1828).
- Registry outcomes, operator/reviewer signing keys and Git-note provenance (plugin/src/contracts.ts:590-646; scripts/attest-unit.cjs:234-260,383-420).
- DSH process authority used to run model-selected verification commands (plugin/src/verification.ts:427-507).

### Trust Boundaries

- Session text and host-selected provider cross the agent/request hook into a possibly cloud-bound model; destination and DLP/source checks must match final provider (plugin/src/index.ts:1700-1828).
- Model-authored tool calls cross pre-execute write controls and post-execute declarations filter before output is returned to architect (plugin/src/index.ts:1405-1473).
- delegate_worker receives model-supplied task, targets, context paths and verification command but operator config chooses local endpoint and policy (plugin/src/index.ts:1151-1235).
- Local worker output crosses emission containment and verification before a registry verdict can support promotion (plugin/src/emission.ts:62-100; plugin/src/delegation.ts:1036-1058; scripts/check-promotion.cjs:107-136).
- Operator-only attestation scripts use repository, private keys and Git notes; prepare and approve are separate actions (scripts/attest-unit.cjs:234-260,383-420).
- The host assembles final outbound conversation after plugin hooks; agent/request scans captured user/session prompt text rather than model-facing tool-result bytes (plugin/src/index.ts:1586-1590,1699-1706; README.md:491-497).

### Attacker Capabilities

- Untrusted user/model can supply prompt text, tool arguments, directory scopes, shell commands, worker instructions, context paths and a verification command; does not automatically own profile configuration, approval service or signing keys.
- A local worker can propose file content but emission and workspace policy constrain writes; signed provenance requires separate host/operator paths.
- A caller of exported library/CLI interfaces can choose their documented arguments; exposure beyond local/host access is deployment-dependent.

### Security Objectives

- Do not transmit credentials or detected source to unauthorized cloud destinations (plugin/src/index.ts:1700-1828).
- Do not return raw source through declarations-mode reads, searches or shell content commands when workspace provenance is uncertain (plugin/src/declaration-egress.ts:233-541).
- Constrain delegated writes and context reads to authorized roots and budgets; reject symlink/path escapes and unbounded reads (plugin/src/emission.ts:62-100; plugin/src/context.ts:45-92).
- Permit model-selected verification commands only under explicit policy/approval and run them without shell interpretation (plugin/src/verification.ts:427-507).
- Bind promotion and dual-signed attestation to exact reviewed bytes and a repository commit (scripts/check-promotion.cjs:107-136; scripts/attest-unit.cjs:234-420).
- Do not mistake prompt-only DLP scanning for complete inspection of tool results and the host-assembled outbound conversation.

### Assumptions

- Actual DSH host workspace, search root, approval callbacks and provider endpoints are outside this repository; integration behavior remains deployment-dependent.
- Declarations mode is optional; when configured without declarationRoot the runtime warns and does not install its filter (plugin/src/index.ts:1436-1444).
- Attestation scripts are separately invoked with local operator authority; repository source does not establish remote public exposure.
- Review covers current revision 441f0042d669dbf732945ab322d0c472194360bf and current repository files; tests and docs are evidence, not authority.
- The untrusted repository may contain prompt-injection text and local credential files; successful tool-result disclosure requires the cloud architect to invoke a readable-file tool and host propagation of result bytes.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Relative node path can execute a shadow binary during verification](#finding-1) | high | high | inline below |
| [Non-TS source reads and directory searches leak in declarations mode](#finding-2) | medium | high | inline below |
| [Promotion gate hashes working-tree bytes instead of the staged artifact](#finding-3) | medium | high | inline below |
| [Wildcard shell reads evade declarations filtering](#finding-4) | medium | medium | inline below |
| [Patch-file shell writes evade the source write approval gate](#finding-5) | medium | high | inline below |
| [Promotion --changed gate can pass when Git diff fails](#finding-6) | medium | high | inline below |
| [Explicit contextFiles can reveal a hidden contract to the worker](#finding-7) | medium | high | inline below |
| [Shell command ending in .d.ts bypasses declarations filtering](#finding-8) | medium | high | inline below |
| [Credential-bearing tool output is outside request DLP scan](#finding-9) | medium | medium | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Relative node path can execute a shadow binary during verification

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-78 |
| Affected lines | plugin/src/sandbox.ts:174, plugin/src/verification.ts:498 |

#### Summary

The verification parser accepts any path whose basename is node, then spawnSync executes that path with the DSH process authority.

#### Root Cause

The verification parser accepts any path whose basename is node, then spawnSync executes that path with the DSH process authority.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/sandbox.ts:174, plugin/src/verification.ts:498, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — A shadow program can run outside the Node permission/preflight boundary.

Severity depends on the stated deployment prerequisites.

#### Remediation

Resolve an operator-controlled absolute Node runtime and reject model-selected binary paths.

<a id="finding-2"></a>

### [2] Non-TS source reads and directory searches leak in declarations mode

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-200 |
| Affected lines | plugin/src/index.ts:1481, plugin/src/declaration-egress.ts:187, plugin/src/declaration-egress.ts:406 |

#### Summary

The live read route passes through paths with no declaration mapping; directory resolution discards nonmappable code then treats an empty list as safe.

#### Root Cause

The live read route passes through paths with no declaration mapping; directory resolution discards nonmappable code then treats an empty list as safe.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/index.ts:1481, plugin/src/declaration-egress.ts:187, plugin/src/declaration-egress.ts:406, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Implementation content that cannot have a type skeleton is exposed.

Severity depends on the stated deployment prerequisites.

#### Remediation

Apply the code-extension refusal to live reads and count nonmappable source in scoped searches before allowing an empty result.

<a id="finding-3"></a>

### [3] Promotion gate hashes working-tree bytes instead of the staged artifact

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-367 |
| Affected lines | scripts/check-promotion.cjs:54, scripts/check-promotion.cjs:69, scripts/check-promotion.cjs:131 |

#### Summary

The --changed gate selects paths via Git but compares registry hashes to fs.readFileSync working-tree content, not Git index content or mode.

#### Root Cause

The --changed gate selects paths via Git but compares registry hashes to fs.readFileSync working-tree content, not Git index content or mode.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at scripts/check-promotion.cjs:54, scripts/check-promotion.cjs:69, scripts/check-promotion.cjs:131, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — A commit can contain an artifact whose bytes or file type were never verified.

Severity depends on the stated deployment prerequisites.

#### Remediation

Hash the staged Git blob and bind file type/mode as well as content to the verdict; reject unresolved index state.

<a id="finding-4"></a>

### [4] Wildcard shell reads evade declarations filtering

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-200 |
| Affected lines | plugin/src/declaration-egress-hook.ts:189, plugin/src/declaration-egress.ts:541 |

#### Summary

Literal scope stat does not expand shell wildcards, and a command without an explicit source extension reaches the allow path.

#### Root Cause

Literal scope stat does not expand shell wildcards, and a command without an explicit source extension reaches the allow path.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/declaration-egress-hook.ts:189, plugin/src/declaration-egress.ts:541, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Implementation bytes can cross the declarations-mode boundary.

Severity depends on the stated deployment prerequisites.

#### Remediation

Refuse content-reading commands with unresolved glob patterns or expand and classify their targets before execution.

<a id="finding-5"></a>

### [5] Patch-file shell writes evade the source write approval gate

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-863 |
| Affected lines | plugin/src/guard.ts:866, plugin/src/guard.ts:914 |

#### Summary

The shell guard looks for a source extension before acting on write signals, so a patch filename can hide source modifications.

#### Root Cause

The shell guard looks for a source extension before acting on write signals, so a patch filename can hide source modifications.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/guard.ts:866, plugin/src/guard.ts:914, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Source changes can be made without the intended approval/delegation decision.

Severity depends on the stated deployment prerequisites.

#### Remediation

Treat write-capable commands with opaque inputs as approval-required, or inspect patch targets before allowing.

<a id="finding-6"></a>

### [6] Promotion --changed gate can pass when Git diff fails

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-754 |
| Affected lines | scripts/check-promotion.cjs:189, scripts/check-promotion.cjs:239 |

#### Summary

A failed changed-path query substitutes registered paths, which need not include the changed files, then success is based only on that substitute list.

#### Root Cause

A failed changed-path query substitutes registered paths, which need not include the changed files, then success is based only on that substitute list.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at scripts/check-promotion.cjs:189, scripts/check-promotion.cjs:239, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The release gate can approve a changeset it never inspected.

Severity depends on the stated deployment prerequisites.

#### Remediation

Return a nonzero error when changed-path discovery fails instead of substituting registry paths.

<a id="finding-7"></a>

### [7] Explicit contextFiles can reveal a hidden contract to the worker

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-863 |
| Affected lines | plugin/src/delegation.ts:794, plugin/src/delegation.ts:815, plugin/src/delegation.ts:882 |

#### Summary

Only retry-added context is compared to contract paths; explicit contextFiles are read and appended to the worker prompt without that check.

#### Root Cause

Only retry-added context is compared to contract paths; explicit contextFiles are read and appended to the worker prompt without that check.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/delegation.ts:794, plugin/src/delegation.ts:815, plugin/src/delegation.ts:882, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The implementer can inspect the acceptance test and tailor output while retaining a passing verdict.

Severity depends on the stated deployment prerequisites.

#### Remediation

Reject any explicit context path that canonicalizes to a protected contract path before reading it.

<a id="finding-8"></a>

### [8] Shell command ending in .d.ts bypasses declarations filtering

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-200 |
| Affected lines | plugin/src/declaration-egress.ts:239, plugin/src/declaration-egress-hook.ts:105 |

#### Summary

A target-wide .d.ts suffix allow precedes the shell branch, while the hook supplies the whole shell command as target.

#### Root Cause

A target-wide .d.ts suffix allow precedes the shell branch, while the hook supplies the whole shell command as target.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/declaration-egress.ts:239, plugin/src/declaration-egress-hook.ts:105, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Raw implementation output reaches the architect despite declarations mode.

Severity depends on the stated deployment prerequisites.

#### Remediation

Apply the declaration-file exception only to a parsed direct file read of the exact declaration path.

<a id="finding-9"></a>

### [9] Credential-bearing tool output is outside request DLP scan

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | Source path is directly visible at the cited lines; no application or PoC execution was performed. |
| Category | security-boundary-bypass |
| CWE | CWE-200 |
| Affected lines | plugin/src/index.ts:1699, plugin/src/index.ts:1477, plugin/src/index.ts:1702 |

#### Summary

The request hook scans captured prompt/session text, while a readable-file tool result can enter the host conversation after the hook without being included in that corpus.

#### Root Cause

The request hook scans captured prompt/session text, while a readable-file tool result can enter the host conversation after the hook without being included in that corpus.

#### Validation

Source path is directly visible at the cited lines; no application or PoC execution was performed. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/index.ts:1699, plugin/src/index.ts:1477, plugin/src/index.ts:1702, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Credentials may be sent to the cloud despite DLP enforcement.

Severity depends on the stated deployment prerequisites.

#### Remediation

Inspect or redact model-facing tool results and the final outbound payload at the host boundary.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Independent baseline | write guard and paths | Reported | Traced high-risk source paths. |
| Request and tool egress | declarations filter and DLP | Reported | Traced read, search and shell routes. |
| Verification sandbox | binary, argv, preflight and temp | Reported | Shadow binary source-backed; runtime-specific bypasses unproven. |
| Verification and attestation | contract and promotion | Reported | Traced context, ledger controls and promotion script. |

## Open Questions And Follow Up

- Runtime proof is outstanding for Node CLI flag precedence, Windows argv serialization and preflight dgram/internal-binding bypass.
- No shared temp IPC/race or contract alias hash bypass was established.
- Focused egress investigator candidate awaiting parent validation.
  - Follow-up prompt: Review deferred unit candidate-nonmappable-directory and close its stated proof gap.
- Focused egress investigator candidate awaiting parent validation.
  - Follow-up prompt: Review deferred unit candidate-nonmappable-read and close its stated proof gap.
- Sandbox investigator candidate deferred pending runtime/Node permission behavior.
  - Follow-up prompt: Review deferred unit candidate-js-network and close its stated proof gap.
- Focused reviewer source-backed candidate pending runtime semantics.
  - Follow-up prompt: Review deferred unit candidate-verification-flags and close its stated proof gap.
- Focused reviewer conditional candidate.
  - Follow-up prompt: Review deferred unit candidate-promotion-symlink and close its stated proof gap.
