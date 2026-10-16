# Target Audience & Market Positioning

**Project:** `dsh-plugin-coding-delegate`
**Focus:** Repo-native cryptographic attestation, anti-self-approval enforcement, and execution perimeters for autonomous AI coding agents.

> **What this document is.** This is market positioning: which roles are blocked today, and which
> obligation each one is trying to discharge. The audience statements are positioning rather than
> measurements, and named products are context for the problem — none of them is assessed here. The
> mechanics referenced below are the ones this repository actually tests. The full control mapping,
> the exact commands, and the boundaries that are **not** covered live in
> [the enterprise governance specification](enterprise-governance.md), including a consolidated
> residual table.

---

## Executive Summary

Autonomous coding agents (such as Cline, Cursor, Copilot, and Claude Code) routinely combine
architectural planning, file mutation, and test validation into a single prompt-driven feedback loop.
In environments governed by statutory and industry compliance frameworks, this autonomous
self-approval presents an unacceptable operational and regulatory risk.

`dsh-plugin-coding-delegate` replaces soft prompt guidelines and reactive "click-to-approve" popups
with deterministic technical perimeters, strict Separation of Duties (SoD), and Ed25519-signed Git
provenance records (`refs/notes/delegations`).

The primary interested parties are organizations, security officers, and platform architects where
autonomous developer tooling is currently blocked by legal, security, or compliance mandates.

---

## 1. Regulated Enterprise Engineering Teams (The Core ICP)

Organizations subject to formal audit regimes where unconstrained code generation and self-approving
pipelines trigger compliance failures.

### A. Financial Services & Banking

* **Applicable Standards:** SOC 2 Type II (CC8.1 — Change Management),
  PCI DSS v4.0 (Requirement 6 — Develop and Maintain Secure Systems and Software),
  FFIEC Architecture and Operations.
* **The Problem:** SOC 2 CC8.1 mandates segregation of duties between who specifies, implements, and
  approves production changes. When an AI agent reasons about a feature, authors the code, and passes
  its own tests, the change management audit fails.
* **Value Delivered:** The cloud planning model (architect) is denied write and shell access at the
  permission layer — the tool is never granted, so a prompt-injected architect can still only plan.
  Code is produced inside a bounded local workspace, verified against negative discrimination
  fixtures, and sealed under Schema 1.2 dual attestation, where the reviewer key must differ from the
  worker key or the record is refused with `self-approval refused`.

### B. Defense, Aerospace & Critical Infrastructure

* **Applicable Standards:** CMMC (Level 2/3), NIST SP 800-161 (Supply Chain Risk Management),
  FedRAMP High.
* **The Problem:** Cloud-based models cannot be granted direct terminal access or unchecked
  file-system write authority on development workstations handling sensitive or sovereign
  intellectual property.
* **Value Delivered:** Sovereign execution containment. Outbound prompts pass through an egress Data
  Loss Prevention (DLP) gate that pins a session once a credential has been seen. The planning model
  receives declaration skeletons (`.d.ts`) rather than source, while code synthesis and verification
  stay in a local worker runtime inside a bounded workspace — write containment, not OS-level
  isolation, as stated in
  [§2 of the governance specification](enterprise-governance.md#2-key-management-host-side-not-os-level-isolation) —
  and the resulting records audit offline.

### C. Healthcare & Life Sciences

* **Applicable Standards:** FDA 21 CFR Part 11 (Electronic Records & Signatures), HIPAA Security
  Rule, ISO 13485 (Medical Device Quality Management).
* **The Problem:** Software changes impacting medical software or clinical data pipelines require
  human-in-the-loop attestation and records that survive an audit.
* **Value Delivered:** Proof of human intervention. Two-phase attestation (`--prepare` and
  `--approve --reviewer-identity`) records an independent operator who signs the executed artifact
  only after the auditor re-resolves every artifact digest against the anchored Git tree. The
  boundaries on that claim — a Git ref is not write-once storage, and a deleted note is not
  detectable locally — are stated in the residual table rather than left implicit.

---

## 2. Enterprise DevSecOps & Platform Engineering

Leaders responsible for enterprise-wide developer productivity who must mitigate the software
supply-chain risks introduced by generative AI.

### A. Internal Developer Platform (IDP) Architects & Heads of DevEx

* **The Problem:** Engineers frequently adopt unvetted IDE plugins and agent runtimes locally,
  creating shadow IT risks, credential leakage, and untracked code commits.
* **Value Delivered:** A zero-sidecar, in-process policy gate. It standardizes how autonomous agents
  interface with a local execution environment through any OpenAI-compatible endpoint — LM Studio,
  Ollama, vLLM, llama.cpp — without deploying a daemon architecture or a third-party orchestration
  proxy.

### B. Software Supply Chain & Open Source Security Groups (OpenSSF / SLSA)

* **The Problem:** Generative AI introduces synthetic commits lacking verifiable provenance,
  bypassing build-provenance chains.
* **Value Delivered:** Repo-native attestation. RFC 8785 canonical JSON records in
  `refs/notes/delegations` bind the verified unit contract, the execution receipt, and the commit
  tree directly into the repository's object database, and verify offline with `git cat-file`.
  **Stated boundary:** this project does not claim SLSA build provenance — there is no hosted
  isolated builder and the published tarball carries no npm provenance attestation. The claim here is
  narrower and checkable: the record is bound to Git objects, and
  [`scripts/verify-release-tarball.ps1`](../scripts/verify-release-tarball.ps1) binds the published
  artifact to its tag in both directions.

---

## 3. Compliance Software Vendors & AI GRC Platforms

Vendors offering automated compliance, risk management, and governance tracking for enterprise
software environments.

* **The Problem:** GRC platforms track compliance via static questionnaires, policy documents, and
  high-level SaaS integrations. They lack runtime enforcement evidence to prove that an autonomous
  agent was mechanically prevented from approving its own work.
* **Value Delivered:** Automated audit evidence collection. A GRC platform can read
  `refs/notes/delegations` from a connected Git repository and parse it without an agent in the loop,
  automating evidence collection for:
  * **EU AI Act Article 12:** automatic and continuous technical record-keeping over the lifecycle.
  * **EU AI Act Article 14:** human oversight, and mechanical prevention of autonomous
    self-approval.
  * **ISO/IEC 42001 Annex A.6 (AI system life cycle)**, including A.6.2.2 (AI system requirements
    specification): the signed record is the evidence that a specified unit was verified against a
    named contract and approved by a named second principal.

---

## 4. Enterprise Agent Harness & IDE Maintainers

Maintainers and commercial vendors building autonomous developer environments.

* **The Problem:** Enterprise procurement and risk teams frequently refuse AI agent tooling that
  requires unconstrained shell access and unrestricted workspace write privileges.
* **Value Delivered:** A reference security architecture. It demonstrates how to decouple reasoning
  from execution, contain tool egress, and implement deterministic verification gates that a vendor
  review can inspect — the compiled plugin, the gate, and the audit all run from a clone.

---

## Value Proposition Matrix

| Audience / Role | Key Decision Maker | Core Value Proposition |
| :--- | :--- | :--- |
| **Enterprise AppSec & CISO** | Chief Information Security Officer (CISO) | *"The planning model has no write tool and no shell. It is an architectural perimeter, not a soft prompt instruction."* |
| **Audit & Governance** | Director of IT GRC / Internal Audit | *"An Ed25519-signed Git note for every delegated change, enforcing anti-self-approval between the implementation worker and the human reviewer for SOC 2 CC8.1."* |
| **Platform Engineering** | VP of Platform / Head of Developer Experience | *"Harness frontier reasoning models while containing code execution and verification locally, with deterministic test contracts that audit offline."* |
| **AI Compliance Vendors** | Head of Product / Technical Alliances | *"A repo-native provenance primitive that turns autonomous developer activity into machine-checkable evidence for EU AI Act Articles 12 and 14."* |

---

## Verify these claims yourself

Every mechanical statement above is reproducible from a clone. Three commands:

```powershell
npm run gate                                              # five stages, ending in the ledger audit
node scripts/verify-delegation-ledger.cjs                 # read the signed records yourself
node scripts/redteam-probe.cjs                            # 10 attacks, each must be refused by name
```

The auditor prints a per-note verdict and fails closed; the red-team harness mutates a throwaway copy
of the ledger ref and restores it. The published artifact can be bound to its tag with
`scripts/verify-release-tarball.ps1 -Version <version> -Tag v<version>`.
