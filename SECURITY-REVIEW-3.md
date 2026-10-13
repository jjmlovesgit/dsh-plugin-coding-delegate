# Security Review: dsh-plugin-coding-delegate

## Scope

Full repository static review plus requested baseline scripts.

- Scan mode: repository
- Target kind: git_revision
- Target ID: target_sha256_b1b0d9c0079f21c612fade6af1e384ea5211efdabf14ec41ee85e98e9d09b3a6
- Revision: aee527897581a9a338dae1b9fcfde6e8342cc57b
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none

Limitations and exclusions:
- Ledger audit aborted at startup due key line-ending mismatch.
- Red-team expected checks were not reached.
- Dist build unavailable.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 8 |
| Severity mix | high: 3, medium: 5 |
| Confidence mix | high: 8 |
| Coverage | partial |
| Validation mode | static-plus-user-baseline |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Signed Git-notes delegation ledger, contract gates, worker delegation, workspace containment, emission, and declaration egress.

### Assets

- signed notes
- operator keys
- anchored Git trees
- workspace files
- attestation decisions

### Trust Boundaries

- plugin to worker/filesystem
- worker to attestation
- working tree to Git object database
- checked-out key to verifier
- fixture discovery to gate

### Attacker Capabilities

- repository writer can alter commits, notes, and checked-out key
- worker or workspace can supply symlinks and paths
- local process can mutate refs

### Security Objectives

- immutable key and commit binding
- fail closed on missing ledger evidence
- workspace containment
- complete fixture coverage
- self-verifiable attestations

### Assumptions

- operator private key is trusted and external
- main is intended ancestry root
- Git notes are externally protected
- build dependencies are unavailable

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Deleting the delegation notes ref produces a clean audit](#finding-1) | high | high | inline below |
| [Dangling symlinks can escape workspace containment](#finding-2) | high | high | inline below |
| [The checked-out operator key is mutable with the forged ledger](#finding-3) | high | high | inline below |
| [Contracts outside the fixture directory bypass the pre-flight gate](#finding-4) | medium | high | inline below |
| [Directory-scoped declaration searches can return implementation code](#finding-5) | medium | high | inline below |
| [An empty normal-stop worker response can settle as SUCCESS](#finding-6) | medium | high | inline below |
| [Unreadable artifacts can receive signed but unverifiable attestations](#finding-7) | medium | high | inline below |
| [Verification can move HEAD before the signed anchor is captured](#finding-8) | medium | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Deleting the delegation notes ref produces a clean audit

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | integrity |
| CWE | CWE-693 |
| Affected lines | scripts/verify-delegation-ledger.cjs:192-197 |

#### Summary

The verifier exits 0 when the notes ref has no entries, so deletion or loss of the ledger can produce a false-green audit.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at scripts/verify-delegation-ledger.cjs:192-197, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — The scan assigned high severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Fail closed on an empty or missing ledger unless explicit initialization is requested.

<a id="finding-2"></a>

### [2] Dangling symlinks can escape workspace containment

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | path-traversal |
| CWE | CWE-22 |
| Affected lines | plugin/src/paths.ts:9-24 |

#### Summary

Path canonicalization can accept a dangling symlink and a later write follows it outside the workspace.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/paths.ts:9-24, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — The scan assigned high severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Reject symlink components or use handle-based parent checks before writes.

<a id="finding-3"></a>

### [3] The checked-out operator key is mutable with the forged ledger

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | authentication |
| CWE | CWE-347 |
| Affected lines | scripts/verify-delegation-ledger.cjs:103-173 |

#### Summary

The verifier trusts the public key currently in the repository without an immutable fingerprint or trusted historical anchor, allowing a writer to repin trust with forged notes.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at scripts/verify-delegation-ledger.cjs:103-173, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — The scan assigned high severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Pin an out-of-band operator-key fingerprint or trusted commit and require rotation ceremony.

<a id="finding-4"></a>

### [4] Contracts outside the fixture directory bypass the pre-flight gate

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | validation-bypass |
| CWE | CWE-693 |
| Affected lines | scripts/check-contract-fixtures.cjs:73-82 |

#### Summary

The fixture checker scans only tests/contracts while ledger records accept arbitrary contract paths.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at scripts/check-contract-fixtures.cjs:73-82, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Enforce one contract path allowlist for signing, auditing, and fixture discovery.

<a id="finding-5"></a>

### [5] Directory-scoped declaration searches can return implementation code

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | information-disclosure |
| CWE | CWE-200 |
| Affected lines | plugin/src/declaration-egress.ts:122-125 |

#### Summary

The egress filter allows nonempty scopes without a source extension, so directory scopes can expose implementation lines.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/declaration-egress.ts:122-125, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Resolve scopes to regular files and enforce declaration-only filtering for directories.

<a id="finding-6"></a>

### [6] An empty normal-stop worker response can settle as SUCCESS

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | integrity |
| CWE | CWE-393 |
| Affected lines | plugin/src/delegation.ts:540-545 |

#### Summary

The classifier allows empty normal-stop output and downstream logic can complete with no files written.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/delegation.ts:540-545, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Treat empty implementation content or zero verified outputs as failure unless explicitly no-op.

<a id="finding-7"></a>

### [7] Unreadable artifacts can receive signed but unverifiable attestations

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | integrity |
| CWE | CWE-345 |
| Affected lines | plugin/src/crypto-attestation.ts:306-310 |

#### Summary

A missing artifact hash becomes an empty string and signing continues, while the verifier requires the anchored tree digest.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/crypto-attestation.ts:306-310, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Refuse to sign when any retained artifact hash is unavailable.

<a id="finding-8"></a>

### [8] Verification can move HEAD before the signed anchor is captured

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Direct source trace and repository evidence support the behavior. |
| Category | integrity |
| CWE | CWE-345 |
| Affected lines | plugin/src/delegation.ts:1135-1144 |

#### Summary

Attestation reads the base commit after verification, so a command that changes HEAD can make the signed payload attest the wrong state.

#### Validation

Direct source trace and repository evidence support the behavior. Validation details were not recorded separately.

#### Dataflow

The canonical finding records the affected path at plugin/src/delegation.ts:1135-1144, but no expanded source-to-sink narrative was recorded.

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Capture and freeze HEAD before worker execution.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| ledger verifier and signer | not recorded | Reported | No additional canonical notes were recorded. |
| red-team probe harness | not recorded | Needs follow-up | No additional canonical notes were recorded. |
| contract and fixture gates | not recorded | Reported | No additional canonical notes were recorded. |
| worker delegation and attestation | not recorded | Reported | No additional canonical notes were recorded. |
| workspace containment and emission | not recorded | Reported | No additional canonical notes were recorded. |
| canonical JSON and crypto envelopes | not recorded | No issue found | No additional canonical notes were recorded. |
| compiled dist parity | not recorded | Needs follow-up | No additional canonical notes were recorded. |

## Open Questions And Follow Up

- Auditor key comparison blocked by CRLF/LF mismatch.
- TypeScript build and dist parity need dependencies.
