# Empirical findings, and the audit system in plain English

Two things live here, and they are kept for the same reason: this control's credibility comes from what it
discloses rather than from a clean feature list.

- **Retired claims** — four propositions this project was originally justified by, each measured on this
  repository's own work and each retired by the measurement. The measurements are kept, not deleted, because
  every one of them is a trap for the next person building something similar.
- **The audit system in plain English** — what the three layers of verification actually prove, without
  assuming the reader has read the technical sections of the [README](../README.md).

The formal control mapping lives in [enterprise-governance.md](enterprise-governance.md), and every defect
found during development is recorded with what it cost in [findings.md](findings.md).

## Retired claims, and why

Every row was measured on this repository's own work. They are kept because a control's credibility comes
from what it discloses, and because each one is a trap for the next person building something similar.

| claim | what the measurement said |
| --- | --- |
| *"Your plan is for thinking, your GPU does the typing"* | True as a mechanism, and close to worthless as a saving. Across 329 delegations the architect was billed **666,756,560** input tokens; the local worker's entire output was **548,106** — **0.08%** of the bill. Delegation cannot meaningfully reduce a total it contributes 0.08% to. |
| *"Runs on your machine, so it's private"* | **Refuted.** The architect must read the codebase to engineer against it, and everything it reads is re-sent on every later turn — measured at ~8.5 read events per turn. What stays local is the typing, not the knowledge of what is being typed. Measured under the **default** `sourceReadEgress: 'source'`; the opt-in `'declarations'` mode narrows *what those reads carry* for four extensions ([egress privacy](../README.md#the-enforced-invariants)) — it does not make this claim true, because the reads still happen, the served payload is still re-sent every turn, and every other extension is still served raw. |
| *"Local routing saves money"* | **Refuted, and never claimed at the bottom of the file.** The delegated output is worth **$0.1047** of cloud-equivalent; the hardware payback is roughly **19,000×** this workload. |
| *"Capacity, so the plan lasts"* | **Unsupported.** Session length is set by the context window filling, and that is dominated by the architect's reading, which the plugin does not reduce. Measured evidence that it extends sessions: none. |
| A third tier would read the repository locally and keep the architect out of the code | **Built, measured, retired.** The tier's window did not fit; a per-model reasoning setting could not be overridden; offloading typing recovered far less than the reading it gave back; no lead-authored contract was ever dispatched and verified. The split of `src/index.ts` has since retired the first of those four, so the decision rests on the other three. See [`ROADMAP.md`](ROADMAP.md). |

The general lesson, which outlives this plugin: **you cannot cut a session's metered cost by changing who
types. You cut it by changing what the planning model has to hold.** Any architecture premised on the
writing being expensive has the wrong cost model.

## Appendix: the audit system in plain English

In conventional software development, we rely on an honor system: if code is checked into a folder and tests pass on a developer's computer, we trust it. In automated pipelines—especially where AI writes or refactors code—that honor system breaks down. AI agents can easily generate vacuous tests that pass even when code is broken, or a pipeline might test good code locally but record something different into history.

This repository eliminates that honor system by acting as a **tamper-evident, automated notary for delegated code**. It enforces three concrete layers of verification:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THREE LAYERS OF PROOF                           │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Proof the Tests Aren't Fake     → Negative Fixture Discrimination   │
│ 2. Tamper-Evident Wax Seal         → Cryptographic Git Ledger (Ed25519)│
│ 3. Time-Machine Verification       → Pure Git Object Trees (No Disk)   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. Proof the Tests Aren't Fake (Negative Discrimination)
A test that always passes is worse than no test at all. To guarantee contracts actually enforce correctness, every utility maintains an intentionally broken twin (a "negative fixture"):
* Before a test contract is accepted, the gate forces it to run against the broken fixture.
* If the contract doesn't catch the intentional defect and fail, **the contract itself is rejected**.
* You can only certify working code if your test has proven it detects real failures.

### 2. A Tamper-Evident Wax Seal (Cryptographic Provenance)
When an authorized operator verifies and accepts a utility, the pipeline stamps a cryptographic certificate directly into the repository's Git history (`refs/notes/delegations`):
* The record binds the exact SHA-256 fingerprints of the code, its contract, and the generating model.
* It is digitally signed using an Ed25519 operator key, and the auditor cross-checks that key against a pinned fingerprint (`TRUSTED_OPERATOR_PUBKEY_SHA256`), so any rotation of the trust root is forced into a visible diff rather than happening silently.
* **Two signatures, two principals (Spec 1.2).** A record can carry an execution receipt signed at the end of the worker run *and* a separate approval signed by a human reviewer. The two signatures are made by different keys, over different byte ranges, at two different times — the worker signs a record with no reviewer in it, the reviewer signs a record that already contains the worker's, and the outer envelope is sealed last.
* **The reviewer's key is meant to be pinned out-of-band.** Only then is the second signature evidence about a second person rather than a second copy of the same secret. The in-repository key exists for local bootstrapping, and the audit says so out loud when it uses it.

### 3. A Time Machine That Audits History, Not Your Laptop (Tree-Accurate Auditing)
Standard test runners check whatever loose files currently sit on your local hard drive. That allows "time-travel" bugs and race conditions, where a record claims to verify files that weren't even in that commit.
* The auditor ignores your working directory for the bytes it checks: no artifact or contract digest is read from disk.
* Instead, it resolves each one directly from Git's internal object database (`git cat-file`) at the commit the record names.
* It verifies that the code *as it existed in that exact historical commit* hashes to the digest inside the signature, preventing working-tree substitution attacks or retroactive claims.

### What This Guarantees in Practice
* **No Un-tested Code**: Every single module must have a corresponding contract, and every contract must have a module — both directions are enforced by `scripts/check-contracts.cjs`.
* **No Tampered Commits**: Modifying even one byte of a file after it was signed stops matching the digest that the signature covers, and the audit fails.
* **No Deleted Ledgers**: Deleting or emptying the audit log causes the gate to fail closed immediately.
* **No False Greens**: The build passes only when proven tests, frozen Git history, and the operator's digital signature strictly align.
