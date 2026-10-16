# Enterprise AI Governance & Attestation Specification

Technical controls for non-repudiation, separation of duties, and model provenance in autonomous code generation.

---

## 0. Scope, audience, and how to read this

This document is written for a reviewer who has to decide whether an autonomous coding agent's output can be trusted as a change to a governed system: a compliance officer, an external auditor, or an engineer performing due diligence.

It is **not** a certification claim and **not** a product brochure. Every control below names the file and the function that implements it, the command that exercises it, and the residual boundary that remains. Line references are as of commit `ee5dddc` (release `v0.5.5`), whose `plugin/dist` is byte-identical to
`v0.5.4`'s and whose only shipped change is metadata, so they hold for both; the code is the authority, and where this document and the code disagree, the code wins.

This document extends `docs/governance.md` ("Governance: the attestation threat model"), which is the mechanism-level description of the key model, the subprocess boundary, fail-closed states, canonicalization and storage. That file already refuses a stronger claim than this one is entitled to make (`docs/governance.md:237`: *"such as Sigstore Rekor. A git ref does not, and this document will not call it one."*). Read them together: this file maps controls to obligations, `docs/governance.md` explains how each control is built.

Terminology used throughout:

| Term | Meaning in this repository |
| --- | --- |
| **Unit** | One generated artifact (a file under `tools/`) plus the contract that judges it. |
| **Contract** | An executable specification (`tests/contracts/<name>.contract.cjs`) that a unit must pass, paired with a **negative fixture** the contract must reject. |
| **Record** | A signed attestation, stored as a Git note under `refs/notes/delegations`. |
| **Anchor** | The commit a record names as the state of the world it attests to (`payload.baseCommit`). |
| **Ledger** | The set of records in `refs/notes/delegations`. |

---

## 1. Executive summary and regulatory scope

### 1.1 The failure mode class this addresses

Autonomous coding agents fail audit in two structural ways, independent of how capable the model is:

1. **Phantom attestation.** The pipeline asserts that work was done, tested, and approved, and nothing binds that assertion to bytes that exist. Typical shapes: a generation record that is overwritten by the next run; a "tests passed" claim with no artifact of the test run; a self-reported status that no second party can reproduce.
2. **Self-approval.** One actor — the same process, session, model, or credential — both produces the change and judges whether it is acceptable. The output can be flawless and the audit is still worthless, because nothing in the pipeline can distinguish "verified" from "asserted."

A third, operational shape follows from the first two: **evidence that expires**. Telemetry in a vendor's SaaS, a CI log past its retention window, or an ephemeral container's transcript may be excellent evidence on the day it is created and unavailable on the day it is needed — and the timestamps that would prove it existed are held by the same party whose work is under review.

This repository's answer is to put the evidence where the change already lives (Git), make it cryptographically bound to the exact bytes it describes, and make approval by a second principal a cryptographic event rather than a workflow convention.

### 1.2 Obligations mapped to mechanisms

| Obligation | Mechanism in this repository | Exercised by |
| --- | --- | --- |
| **SOC 2 Type II — CC8.1** (change management: the criterion covers authorising, designing, testing and approving changes) | Anchor binding: a record names its commit, is refused if not attached to it, and its artifacts/contracts are re-hashed from that commit's tree. Dual attestation refuses self-approval, so approval authority is a distinct key rather than a workflow step. | `node scripts/verify-delegation-ledger.cjs` |
| **ISO/IEC 42001:2023 — 9.1** (monitoring, measurement, analysis and evaluation) | The gate: five stages, run in CI on every push, failing closed. Every finding is logged with the fixing commit in `docs/findings.md`. | `npm run gate` |
| **ISO/IEC 42001:2023 — 9.2** (internal audit) | The auditor is one small script a third party can run offline against a clone; its checks are enumerated in §9 and its refusal messages are asserted by the red-team harness, so an audit result is reproducible by the auditee's reviewer. | `npm run audit` |
| **ISO/IEC 42001:2023 — Annex A.3, A.6, A.9** (roles and responsibilities for oversight; AI system life cycle; responsible use) | `--prepare` / `--approve`: the execution receipt and the human approval are separate signatures over separate byte ranges, made at separate times, by keys that must differ, and approval requires a named human principal. | `npm run test:lifecycle` |
| **EU AI Act (Reg. 2024/1689) Art. 12** (record-keeping, traceability) | Append-only-by-convention ledger in Git notes; each record carries the contract set, model identifier, verification exit code and output digest. | `npm run audit` |
| **EU AI Act (Reg. 2024/1689) Art. 14** (human oversight) | Approval requires an explicit human principal (`--approve --reviewer-identity "<name>"`); no shipped plugin path can author a human claim. | `plugin/tests/oracles/tool-surface.oracle.mjs` |
| **SLSA-style provenance** (see §8 for the level this does *not* reach) | The published tarball is compared blob-for-blob against its tag, in both directions. | `scripts/verify-release-tarball.ps1` |

### 1.3 What is enforced continuously, and where

`.github/workflows/ci.yml` runs on every push: `npm ci`, build, `git diff --exit-code -- dist` (the committed bundle must match a clean build), unit tests, the oracle suite, three targeted oracle files, README consistency, an explicit `git fetch origin 'refs/notes/delegations:refs/notes/delegations'`, and finally `npm run gate`.

Two properties of that pipeline are worth stating precisely, because both were once false:

- **The ledger fetch is load-bearing.** Without it the audit would run against an empty ref in a depth-1 checkout. The workflow pins `fetch-depth: 0` and fetches the notes ref explicitly; before that step existed, every CI gate run audited zero records and reported success. The auditor now refuses an empty ledger unless `--allow-empty` is passed (`scripts/verify-delegation-ledger.cjs:452-469`), because *"a gate that reports success once its evidence is removed is not a gate."*
- **It has actually run.** The most recent run (id `38808098846`, run 202) executed against exactly the release commit `80889cbe` and concluded `success` on 2026-10-15.

The gate chain is `&&`, so a failing ledger audit fails the job. What CI cannot do is *create* a dual attestation: a workflow must not hold a signing key, so the lifecycle test reports a named skip in that environment (see §3.3).

---

## 2. Control 1 — Enforced dual attestation (anti-self-approval)

### 2.1 The problem

A single signature over "this unit passed" records one actor's opinion of its own work. It cannot distinguish a verified unit from an asserted one, and it gives an approving model or process exactly the authority that separation of duties exists to withhold.

### 2.2 The implemented mechanism

A record under attestation spec **1.2** carries two principals and three signatures:

| # | Signature | Covers | Made by |
| --- | --- | --- | --- |
| 1 | `worker.signature` | the canonical payload **minus** the reviewer block and minus this signature | the operator key, at the end of the worker run |
| 2 | `reviewer.signature` | the canonical payload **minus** only `reviewer.signature` — so it covers the frozen worker receipt | a distinct reviewer key, at approval time |
| 3 | envelope seal | the completed payload string, applied **last** | the operator key |

The ordering is not cosmetic. The reviewer block is added after the worker signed, so an envelope sealed before it would be invalidated by its arrival; verification therefore strips exactly the same fields at each step (`scripts/verify-delegation-ledger.cjs:740-841`).

**Two phases, one attachment.** `node scripts/attest-unit.cjs --prepare <artifact> <contract>` runs the contract, records the worker receipt (model identifier, digest of the *redacted* verification output, duration, timestamp, key fingerprint), signs it, and stages an **unattached draft** at `<repo>/.git/dsh-attestation-pending.json` — inside `.git`, so it cannot be committed. It attaches nothing. `node scripts/attest-unit.cjs --approve <artifact> --reviewer-identity "<name>"` re-verifies the staged receipt against the pinned operator key, re-resolves **every** recorded artifact and contract digest against the anchored commit (the draft sat on disk between the phases, so a swap would otherwise be reintroduced through a temporary file), adds the reviewer block, signs, attaches once, reads the note back and requires it byte-identical, and only then unlinks the draft.

`--prepare` cannot attach, and `--approve` cannot re-run the unit it is approving (`scripts/attest-unit.cjs:43`): the record must carry what phase one observed, not a fresh observation taken after the approval decision.

**Independence is checked, not assumed.** The auditor refuses a record whose worker and reviewer fingerprints are equal — the `self-approval refused` branch at `scripts/verify-delegation-ledger.cjs:764` — and requires the fingerprint the record *names* to be the fingerprint of the key that actually verifies it (a record naming a key it was not signed by is refused). Four of the ten red-team probes target precisely these paths (§7).

**The plugin cannot author a human claim.** `delegate_worker` once exposed `attestOperator`, `attestEvidence` and `attestTargets` to callers, and the plugin wrote `OPERATOR_ATTESTED` into its registry without human action. Those parameters are gone: the schema now has exactly eight properties (`taskName`, `instruction`, `targetFiles`, `runVerification`, `verificationRepeats`, `contractFiles`, `contextFiles`, `workspaceDir`), none of them an identity, and the removal is enforced at compile time by `DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER` (`plugin/src/delegation.ts:252-259`, with the rationale recorded where the parameters used to be at `plugin/src/delegation.ts:152-164`) — a set-equality assertion between the tool schema's keys and the canonical parameter union in `plugin/src/contracts.ts`, so a parameter re-added to one side alone fails the build instead of silently returning to the tool surface. `delegate_worker` settles execution status (`UNIT_PASSED` / `UNIT_FAILED`); `OPERATOR_ATTESTED` is written by no shipped path.

### 2.3 Residual boundary

- **The pinned public keys live inside the repository being verified.** `keys/delegation-operator.pub` (fingerprint `afea373a…`) and `keys/delegation-reviewer.pub` (fingerprint `92e726e0…`) are committed so a third party can audit without being handed a secret in advance. A committer who can edit both keys *and* the pin constant in `scripts/operator-key.cjs` can substitute both roots. This is disclosed rather than hidden: the pin makes re-pinning *visible in a diff*, not impossible. Rotation is therefore a reviewable change to a governed file, which is a weaker property than an external PKI or an HSM-held key.
- **The reviewer trust root can be anchored out of band, and by default is not.** Set `DSH_REVIEWER_PUBKEY` (inline PEM or a path) or `DSH_REVIEWER_FINGERPRINT` (the required digest) and the auditor verifies against that root, printing `ok reviewer trust root supplied out of band`. With neither set it falls back to `keys/delegation-reviewer.pub` and says so loudly: `[AUDIT_NOTICE: in-repo reviewer key used; out-of-band pin recommended for CI]`, then `the reviewer trust decision came from this repository, so it is reviewable rather than independent`. A mismatch fails closed. The residual is that the **default** is the in-repo key.
- **The signing keys are plaintext files on the operator's host** (`~/.dsh/keys/delegation_ed25519.pem`, `~/.dsh/keys/delegation-reviewer.pem`), read by the signing process. There is no OS-level isolation, no passphrase prompt on every use, and no HSM or KMS integration. `docs/governance.md` §2 states the model plainly: key custody is host-side.
- **The approval is one CLI invocation by one named human.** The record proves *which* key signed and *when*; it does not prove the human read anything. Two-person review, if required, is an organisational control layered on top — it would mean requiring two reviewer signatures, which this schema does not currently express.

---

## 3. Control 2 — Repo-native cryptographic provenance

### 3.1 The problem

Provenance that lives somewhere other than the change expires, diverges, or cannot be produced offline during an incident. A forensic auditor asking "what did this commit claim about itself, and can I check it in ten years on a laptop with no network?" should not need a vendor's API key.

### 3.2 The implemented mechanism

Records are Git notes under `refs/notes/delegations` — objects in the same object database as the code, travel with a clone, and are verifiable offline. A record is bound to its anchor in four independent ways, each checked by the auditor:

| Check | What it establishes | Location |
| --- | --- | --- |
| Signature vs the pinned key | the record was made by the pinned operator key | `scripts/verify-delegation-ledger.cjs:499` |
| Attachment parity | the note is attached to the very commit its payload names (`attachment mismatch` at `:525`) | `:516` |
| Ancestry | that commit is an ancestor of `main`, so the tree is checkoutable | `:533` |
| Tree-resolved artifacts | every artifact digest is recomputed from `git cat-file -p <anchor>:<path>` — the **anchored tree**, never the working tree | `:547` |
| Spec conformance at the anchor | a post-cutoff record must declare the current schema (`spec regression`) | `:582` |
| Contract set | `contractHash` is recomputed from the recorded contract blobs; a divergence is a failure and an unreconstructable set is reported, not silently passed | `:614` |
| Contract coverage | every recorded contract is one the discrimination gate actually exercises | `:709` |

Two of those checks exist because the repository was forged once and the forgery succeeded. A note attached to commit A while claiming commit B passed the whole audit, which made the anchor "a comment rather than a binding"; and a note anchored to a commit that did not contain the artifact it described still reported its hashes as matching, because the hashes were recomputed from a working tree that did contain it. Both gaps are now failure branches with their own red-team probes.

**Canonicalization.** Records are hashed and signed over an RFC 8785 canonical JSON serialization (`plugin/src/canonical-json.ts`), a zero-dependency implementation: no insignificant whitespace, object properties sorted by UTF-16 code unit, strings and numbers delegated to the ECMAScript algorithms that RFC 8785 defines them as. It is deliberately stricter than `JSON.stringify` in two places (NaN/Infinity terminate rather than becoming `null`; lone surrogates are an error) and documents one limit (undefined/functions/symbols are omitted from object properties but throw in arrays). Both sides — signer and auditor — transform bytes with this one function, so a record cannot be valid to its author and invalid to its verifier.

**Empty ledger fails closed.** Deleting the entire ref would otherwise switch the gate off; it is a FATAL unless `--allow-empty` is passed explicitly, and passing it in CI "would disable this check for everyone" (`scripts/verify-delegation-ledger.cjs:452-469`).

### 3.3 Residual boundary

- **Git notes are not write-once storage.** `git notes` is not append-only: a note can be edited, re-attached to a different commit, or removed, and the ref can be rewritten with force-push. What protects the ledger is the audit *plus* upstream ref protection, which this repository cannot assert from inside itself. Confirmed by construction: the red-team harness rewrites the ledger ten different ways and restores it afterwards.
- **A deleted note cannot be detected from the repository alone.** The auditor says so in its own closing line: *"this proves the records present are sound. It cannot detect a record that was deleted."* Detecting removal requires a WORM sink or a transparency log — an external commitment of each ledger tip — which this design does not include. The empty-ledger FATAL catches the maximal case (all records removed), not a selective one.
- **The verifier lives in the repository it verifies.** A committer with write access to `scripts/verify-delegation-ledger.cjs` can weaken a check. The mitigation is that the auditor is small, single-purpose, pinned by its own tests and red-team probes, and that its checks are enumerated here so a reviewer can diff them against a release. It is not a substitute for an independent verifier.
- **The ledger ref is pushed to a public repository** by default. Attestation records are therefore public: model identifiers, timestamps, reviewer identities, contract paths and digests. That is a desirable transparency property and a confidentiality consideration an enterprise must resolve (private mirror, or an out-of-band reviewer identity) before adopting the pattern.
- **Timestamps are evidence, not attestation.** The auditor checks that the reviewer's timestamp does not precede the worker's, and reports both. Nothing anchors them to an external time authority, so a signer with a wrong clock can produce a self-consistent record. Ordering is enforced; wall-clock truth is not.

---

## 4. Control 3 — Change-management binding (the anchor)

### 4.1 The problem

A record is only meaningful if it describes a state of the repository that existed and can be reproduced. If verification runs before the change is frozen — or if a command run in the course of verification commits, stashes or checks out — the record points at a state that never shipped, or at a different one than the reviewer saw.

### 4.2 The implemented mechanism

- **The anchor is frozen before commands run.** HEAD is captured before and after the command phase, and a change refuses the record (`HEAD_DRIFT_DETECTED`) rather than recording a moved base.
- **The signer refuses a unit that is not what the anchor contains.** Before staging, `scripts/attest-unit.cjs` re-resolves each artifact and contract digest against the anchored commit; a modified or untracked input is refused with *"these inputs are not what the anchored commit contains."*
- **The auditor re-derives everything from the anchor**, so a record remains valid — and remains checkable — after the files move on. This was measured, not assumed: a published record verified unchanged after its contract was relocated into `tests/contracts/` and its bytes edited, because verification reads the commit's tree.
- **Contracts must be able to fail.** `scripts/check-contract-fixtures.cjs` runs each contract against the real module (must pass) and against a deliberately wrong negative fixture (must fail). A contract that cannot reject a wrong implementation is not evidence, and the gate fails. Seven contracts are currently exercised this way, and the signer refuses to attest a contract that is not covered by that gate.
- **The released artifact is bound to the tag.** `scripts/verify-release-tarball.ps1 -Version <v> -Tag <tag>` compares the published package against the tag's tree in both directions, by Git blob hash: every published file must match its blob at the tag, and the tag must not ship a file the tarball lacks. It cross-checks the registry's `gitHead` against the tag commit and its file count against the unpacked count. Blob hashes are the binding, not `shasum`/`integrity`, because npm embeds timestamps and a shasum is therefore not reproducible across re-packs. The script is deliberately not part of `npm run gate` because it needs the network.

### 4.3 Residual boundary

- **`--allow-dirty` exists** in the signer and permits attesting an artifact that is not in the anchor. It is an explicit operator opt-out and is not used by the gate; an enterprise deployment should treat its use as an exception requiring justification.
- **The integrity gate verifies the *published* package against the tag; it does not verify who built it.** See §8.
- **The chain is only as strong as the tag.** A tag can be moved; this repository's practice is that a published tag is never repointed (a later fix becomes the next patch release), and the published `gitHead` in the registry makes a repoint detectable after the fact.

---

## 5. Supporting defence — egress boundaries and context confinement

These controls are secondary to the attestation story: they constrain what leaves the machine while the work is being done, rather than what can be proven afterwards.

- **Declarations-mode egress filter.** With `sourceEgress: 'declarations'`, a request for source is answered with the type skeleton (`.d.ts`-style declarations derived from `plugin/dist`) instead of the implementation, so an off-machine model can be given the shape of an interface without the body. Implemented in `plugin/src/declaration-egress.ts`; policy decisions are made in one evaluator so there is one place to review.
- **Fail-closed shell inspection on an unverified base.** If the session workspace could not be established, the process working directory is a guess; a scope resolved against a guess has a reach nobody can demonstrate, so it is refused rather than answered. `refuseUnverifiedBase` (`plugin/src/declaration-egress.ts:302`) is asked in the search branch (`:342`), on the fallthrough shapes (`:454`) and, after the three token-level refusals, for shell commands (`:538`) — that last one closing a gap where a *read* was refused while the same scope *searched* by `grep`/`rg` was allowed.
- **Quote-aware shell tokenization.** A directory whose name contains a space is still a directory: the tokenizer parses quoted arguments, and a command whose quoting cannot be parsed deterministically is refused rather than guessed at (`commandScopeUnparseable`, `plugin/src/declaration-egress.ts:510`).
- **Session-sticky credential detection.** A disclosed credential pins the session to the local worker so that a later prompt — after the credential has scrolled out of the scanned window — cannot be routed to a cloud provider. The pin is per session and fires only on a **pattern** match (`highConfidence`), not on the entropy backstop, so one random-looking token cannot hard-block the rest of a session; an entropy-only hit keeps its per-turn soft landing to the local provider.
- **Context byte ceiling.** A context file larger than the remaining byte budget is refused **before it is read**, ranges included. Reading 5 MiB to inject 1 line and then discarding it is a resource-exhaustion path, not a budget.

Each of these has an oracle that fails before the fix and passes after, and each is recorded in `docs/findings.md` with its fixing commit.

---

## 6. Consolidated residual boundaries

Summarised from the sections above; an adopting organisation should treat every line here as an item to resolve or accept explicitly.

| # | Residual | Consequence | Mitigation available |
| --- | --- | --- | --- |
| R1 | Trust roots are pinned inside the verified repository | A writer with commit access can re-pin their own key | Reviewable diff; pin the reviewer root out of band (`DSH_REVIEWER_PUBKEY` / `DSH_REVIEWER_FINGERPRINT`); protect `keys/` and `scripts/operator-key.cjs` with branch protection and code owners |
| R2 | Signing keys are plaintext files on the operator host | Host compromise forges records | Host hardening; move to an HSM/KMS-backed signer (not implemented) |
| R3 | A deleted note is undetectable from the repository | Selective removal of inconvenient history | Publish each ledger tip to an external WORM sink / transparency log (not implemented) |
| R4 | Notes refs are force-pushable | Ledger rewrite | Upstream ref protection; monitor the ref tip |
| R5 | The verifier lives in the repository it verifies | A committer can weaken a check | Independent reimplementation; diff the auditor against this specification |
| R6 | Timestamps are self-asserted | A wrong clock produces a self-consistent record | External timestamping authority (RFC 3161) — not implemented; ordering is enforced |
| R7 | Records are public by default | Model identifiers, reviewer names and paths are public | Private mirror, or pseudonymous reviewer identities |
| R8 | `--allow-dirty` bypasses anchor binding | A record may describe bytes absent from its anchor | Ban its use by policy; audit for it |
| R9 | No second reviewer enforced by the schema | "Approval" is one principal | Organisational two-person rule; a schema extension |
| R10 | The plugin's planner emits spec 1.1, not 1.2 | Dual attestation comes only from `scripts/attest-unit.cjs` | Expected: the planner has no reviewer to name. Stated so nothing is assumed |

---

## 7. Adversarial verification

Governance claims are tested by attack, not by assertion. `scripts/redteam-probe.cjs` mutates the ledger in ten ways, runs the auditor, and requires **both** a non-zero exit **and** the specific refusal message for that check — a non-zero exit alone is never accepted as evidence. The harness restores the ledger ref after every probe and verifies the restore by re-running the audit.

| # | Attack | Expected refusal |
| --- | --- | --- |
| 1 | Foreign key substitution (attacker's own key, own pubkey embedded) | `signature check failed` |
| 2 | Blind artifact-hash tampering on a signed note | `signature check failed` |
| 3 | Post-cutoff note claiming spec 1.0 with no contract set | `spec regression` |
| 4 | Note anchored to an orphan commit outside `main` | `is not an ancestor of main` |
| 5 | Sound record re-attached to a different commit, payload untouched | `attachment mismatch` |
| 6 | Artifact present on disk today but absent from the anchored tree | `artifact is not in the anchored tree` |
| 7 | Spec 1.2 payload claiming dual attestation with no reviewer block | `must carry both a worker and a reviewer block` |
| 8 | Genuine reviewer signature over different bytes | `reviewer signature invalid` |
| 9 | Genuine signature from a third key the record names but the trust root does not | `does not name the key that would verify it` |
| 10 | Self-approval: reviewer block signed with the worker's own key | `self-approval refused` |

All ten are blocked as of `80889cbe`. The harness is deliberately not part of `npm run gate` because it mutates the ledger ref.

The repository's own history is part of the evidence: five external review reports are committed at the root (`SECURITY-REVIEW.md` … `SECURITY-REVIEW-5.md`) and `docs/findings.md` records each finding's disposition with the commit that fixed it — including the findings that were first *wrong* about this codebase, and the two audit gaps that were found by forging the audit itself.

---

## 8. Claims this document does not make

- **Not SLSA Build Level 3.** SLSA L3 requires a hosted, isolated build platform that produces non-forgeable provenance signed by the builder itself. Here the build is `tsc` on an operator's Windows host, the publish is an interactive, 2FA-gated `npm publish` from that host, and the registry entry carries **no** npm/Sigstore provenance attestation (`dist.attestations` is absent). What the repository provides is *provenance verification after the fact*: the published tarball is compared blob-for-blob against a signed-off tag, and the registry's `gitHead` is checked against the tag's commit.
- **Not a certification.** A mapping to SOC 2 CC8.1, ISO/IEC 42001 or the EU AI Act is a mapping of *mechanisms*, not an audit opinion. Only an accredited auditor can issue one, and only after reviewing an organisation's whole control environment.
- **Not a full Annex A mapping.** The clause titles above were checked against the published structure of ISO/IEC 42001:2023 rather than taken on trust: Clause 9 is *Performance Evaluation* (9.1 monitoring, measurement, analysis and evaluation; 9.2 internal audit; 9.3 management review), and **Annex A.7 is *Data for AI systems*, not human oversight** — the oversight obligations in the life cycle sit in A.3 (internal organisation), A.6 (AI system life cycle) and A.9 (use of AI systems), which is where this document maps them. Clause numbers appearing in any outline of this document that cite "9.2 oversight and monitoring" or "A.7 human verification" are wrong in the same way. This repository can evidence the clauses named in §1.2 and makes no claim about the rest of Annex A.
- **Not non-repudiation in the legal sense.** `docs/governance.md` §8 records what would have to change: external key custody, an append-only external sink, and timestamps from a third party. What exists is cryptographic evidence, correctly bound and independently checkable.
- **Not a sandbox.** These controls govern what an agent's output *is allowed to claim* and what may leave the machine. They do not constrain what an approved model does inside its own runtime.
- **Not protection against a compromised signing host.** If the operator's machine is taken over at signing time, the attacker signs valid records.

---

## 9. Audit and compliance verification playbook

Run in the order given. Every command below is offline except the release-tarball check, and every one fails closed with a non-zero exit.

**1. Verify the ledger.**

```
node scripts/verify-delegation-ledger.cjs
```

Expected: `=== DELEGATION LEDGER AUDIT (7 notes) ===`, one `ok` line per check per record, then `AUDIT PASSED: every note is attributed to the pinned operator key, attached to the commit it names, its artifacts and contracts match that commit's tree, and every recorded contract is covered by the discrimination gate.` followed by `NOTE: this proves the records present are sound. It cannot detect a record that was deleted.` Exit 0 on success, 1 with `AUDIT FAILED: N critical check(s) failed.` otherwise. An empty ledger is FATAL: the evidence being absent is not evidence of absence.

To audit against an out-of-band reviewer root rather than the in-repo fallback:

```
set DSH_REVIEWER_FINGERPRINT=92e726e01a961c602d04d5fd26a64dde819ffe7953fb0b189bdb77d51ddb3d8d
node scripts/verify-delegation-ledger.cjs
```

Expected: `ok reviewer trust root supplied out of band` and no `AUDIT_NOTICE`. A wrong value exits 1 with `does not match DSH_REVIEWER_FINGERPRINT`. `node scripts/verify-delegation-ledger.cjs --print-key-fingerprint` prints the sources in use and a paste-ready pin.

**2. Test that the contracts can fail.**

```
node scripts/check-contract-fixtures.cjs
```

Expected: for each of the 7 contracts, a pass against the real module and a rejection of the negative fixture. A contract that accepts a wrong implementation exits non-zero.

**3. Run the full gate (all five stages).**

```
npm run gate
```

Expected: hygiene (trailing LF, no CRLF, no BOM), contract-fixture discrimination, contract well-formedness and module parity, ledger audit, and the two-phase lifecycle test — `ok 1 - Schema 1.2 two-phase lifecycle across both reviewer trust roots`. Exit 0. On a host without the signing keys, the lifecycle test reports `# SKIP` with a named reason rather than failing, and that is the expected result in CI.

**4. Reproduce the adversarial tests.**

```
node scripts/redteam-probe.cjs
```

Expected: `ALL 10 ATTACK VECTORS BLOCKED, LEDGER RESTORED`, `ledger restored to backup ref : true`, `audit after restore : exit 0 (clean)`. Mutates and restores the ledger ref; never run against a repository whose notes ref must not move.

**5. Verify the published release against its tag.**

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release-tarball.ps1 -Version 0.5.5 -Tag v0.5.5
```

Expected (the tag you pass is echoed back; this example is the `v0.5.5` release): `[VERIFIED] every published file matches v0.5.5 blob-for-blob, and v0.5.5 ships nothing the tarball lacks.` Exit 0; on any mismatch, exit 1 with `HASH_MISMATCH`, `MISSING_FROM_PACKAGE` or `EXTRA_IN_PACKAGE` lines. Combine with `-Offline` to skip the registry cross-check.

**6. Inspect the live registry binding.**

```
npm view dsh-plugin-coding-delegate version gitHead dist.integrity time.modified
```

Expected for `0.5.5`: `version = '0.5.5'`, `gitHead = 'ee5dddc11ed09b5d44a52eb4f5e5be7a671cf573'` (the tag's commit), `dist.fileCount = 55`, and a `time.modified` consistent with the release. Note that `dist.attestations` is absent — see §8.

---

## Appendix — artifact map

| Path | Role |
| --- | --- |
| `scripts/attest-unit.cjs` | The signer. `--prepare` / `--approve` / `--reviewer-identity`; also the legacy one-shot path. Runs the contract, records the receipt, stages the draft, attaches once. |
| `scripts/verify-delegation-ledger.cjs` | The auditor. Eight checks per record; fails closed; `--allow-empty`, `--print-key-fingerprint`. |
| `scripts/operator-key.cjs` | The single source of the trust-root pin and the PEM normalisation used by both signer and auditor. |
| `scripts/generate-reviewer-key.cjs` | Provisions the reviewer keypair; refuses to overwrite or to reuse the operator key. |
| `scripts/redteam-probe.cjs` | The ten attack vectors. |
| `scripts/check-contract-fixtures.cjs` | Discrimination gate: every contract must pass the real module and reject a wrong one. |
| `scripts/check-file-hygiene.cjs` | Trailing-LF, CRLF and BOM checks over `tools/` and `plugin/src`. |
| `scripts/verify-release-tarball.ps1` | Two-directional published-tarball-vs-tag verification by blob hash. |
| `tests/attest-unit-lifecycle.test.cjs` | End-to-end clone lifecycle: prepare, approve, both reviewer trust roots, refusal on mismatch. |
| `docs/governance.md` | Threat model: key custody, subprocess boundary, fail-closed states, storage. |
| `docs/findings.md` | Every finding, its disposition, and the commit that fixed it. |
| `keys/delegation-operator.pub`, `keys/delegation-reviewer.pub` | The committed trust roots (see R1). |
| `refs/notes/delegations` | The ledger. Currently 7 records at tip `fd4b2d22`. |
