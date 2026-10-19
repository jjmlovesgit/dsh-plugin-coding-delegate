# Architectural Decision Record & Implementation Blueprint: AI-SDLC Compliance Engine

**Document ID:** ADR-SEC-AISDLC-001  
**Status:** Implemented — Phases 1–3 complete (2026-10-18); Phase 4 partially exercised  
**Date:** October 18, 2026  
**Governing Policy:** `docs/compliance/POL-SEC-AISDLC-001.md`  
**Target Standards:** NIST AI RMF 1.0 (GOVERN 1.2, MANAGE 2.4), NIST SP 800-53 (AC-5, CM-3, SA-11), SOC 2 (CC6.8, CC8.1), ISO/IEC 42001:2023 (Annex A.6, A.9)

---

## 1. Executive Summary & Core Philosophy

This architecture advances AI-assisted software engineering from **manual, point-in-time procedural controls** to **continuous compliance by construction** via cryptographic ledgers, formal discrimination gates, and compiler-enforced graph boundaries.

Traditional development governance relies on retrospective sampling, periodic manual attestations, and checklist-based code reviews. While effective for traditional human authoring, these procedural mechanisms introduce significant friction and verification latency when paired with high-volume, automated AI code generation.

By moving to **cryptographically sealed provenance** and **deterministic static boundaries**, compliance obligations (NIST AI RMF, SOC 2, ISO/IEC 42001) are satisfied as an intrinsic byproduct of the build pipeline, reducing human audit overhead while providing mathematical guarantees of software integrity and separation of duties.

### Core Invariants
1. **The Model Is Untrusted:** The AI is the *subject* of control, never the *evaluator* of compliance. It cannot decide which governance tier applies, certify its own code, or alter its execution boundaries.
2. **Deterministic Fail-Closed Verification:** Code enters the production repository only if verified by an out-of-band test harness executing real child processes.
3. **Non-Repudiation & Dual-Trust:** An Ed25519-signed Git note ledger (`refs/notes/delegations`) locks code commit trees to verified model inputs and independent human reviewer identities, enforcing anti-self-approval at the byte level.
4. **Scope-Partitioned Governance:** Formal mutant contracts are confined to pure algorithmic primitives to prevent developer paralysis, while application glue and UI are bounded via static compiler constraints.

---

## 2. The Three-Tier Architectural Taxonomy

To avoid testing the universe with brittle mocks or stalling feature velocity, code is partitioned into three governance tiers:

```
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Core Primitives (`tools/**`, `src/core/primitives/**`)         │
│ • Characteristics: Pure mathematical logic, zero-dependency leaf units │
│ • Verification: Formal discrimination contract + negative mutant       │
│ • Flake Gate: Mandatory 3-run deterministic sub-process loop           │
│ • Ledger: Sealed Schema 1.2 Git note with worker + reviewer Ed25519    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Imported by
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 2: Protocol Engines (`src/core/protocol/**`, `src/engine/**`)     │
│ • Characteristics: Sans-I/O state machines, byte decoders, serializers │
│ • Verification: Pure in-memory loopbacks, golden-trace wire replays    │
│ • Flake Gate: Single-pass deterministic regression runner              │
│ • Ledger: Branch-protected signed merge commits                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Driven by
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ TIER 3: Imperative Shell & UI (`src/routes/**`, `ui/**`, `scripts/**`) │
│ • Characteristics: Volatile I/O, DOM manipulation, framework glue      │
│ • Verification: TypeScript strict type-checking, headless smoke tests  │
│ • Anti-Evasion: Complexity ceilings, line limits, AST import fences    │
│ • Ledger: Standard Git commits + human PR code review                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Defense-in-Depth: Anti-Evasion & Anti-Hallucination Matrix

To stop models from bypassing Tier 1 gates (e.g., inlining a token bucket in a route or dropping it in `ui/utils.ts`), four boundaries operate outside model control:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI CODE GENERATION                            │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
          ┌──────────────────────────┴──────────────────────────┐
          ▼                                                     ▼
   Hides in Glue Path?                                  Inlines in Function?
   (`ui/rate-limiter.ts`)                               (80-line state loop)
          │                                                     │
          ▼                                                     ▼
┌──────────────────────────────────┐                  ┌───────────────────┐
│ AST Import Fence                 │                  │ Complexity Fence  │
│ `dependency-cruiser` blocks core │                  │ ESLint flags:     │
│ modules from importing utilities │                  │ • Complexity > 10 │
│ outside `tools/`                 │                  │ • Lines > 40      │
└─────────────────┬────────────────┘                  └─────────┬─────────┘
                  │                                             │
                  └──────────────────────┬──────────────────────┘
                                         ▼
                     ┌──────────────────────────────────────┐
                     │ Production Bundler Graph Audit       │
                     │ Release build resolves all imported  │
                     │ primitives against `refs/notes/*`.   │
                     │ Missing signature = compiler abort.  │
                     └──────────────────────────────────────┘
```

| Threat Vector | Attack / Evasion Mode | Mechanical Defense |
| :--- | :--- | :--- |
| **Mutual Hallucination** | Model writes code and test asserting the same wrong assumption. | **Negative Mutant (`*.negative.ts`):** Contract must mathematically fail on defective fixture before running candidate code. |
| **Heuristic Timing Drift** | Code passes once by race condition or lucky timing. | **3-Run Flake Loop:** Sub-process executes 3 clean iterations (`UNIT_PASSED` vs `UNIT_FLAKY`). |
| **Self-Approval** | Model signs or claims authorization on its own commit. | **Schema 1.2 Anti-Self-Approval:** Engine rejects attestation if Worker Key Fingerprint matches Reviewer Key Fingerprint. |
| **Path Evasion** | Model places core utility in `ui/` to avoid Tier 1 contracts. | **AST Import Fence:** Core engine imports from un-attested folders throw compilation errors. |
| **Inlined Logic** | Model embeds state machine into route handler. | **Static Complexity Ceilings:** Functions with complexity $> 10$ or lines $> 40$ fail pre-commit linter. |
| **Type Hallucination** | Model invents parameters or methods on APIs. | **TypeScript Strict Mode:** `tsc --noEmit` fails closed on unknown or unverified fields. |

---

## 4. Auditor Translation & GRC Mapping Guide

Presenting cryptographic Git notes or AST linters directly to CPA/IT auditors causes comprehension friction. All technical artifacts map to standard regulatory controls:

| What the Engine Executes | What the Auditor Evaluates | Standard Control Reference |
| :--- | :--- | :--- |
| `refs/notes/delegations` with Ed25519 dual signatures | Non-repudiable peer review logging and change authorization | **SOC 2 CC6.8, CC8.1** / **NIST AC-5** |
| Discrimination contracts & `*.negative.ts` | Automated defect-detection test suites required prior to merge | **NIST CM-3** / **ISO 42001 Annex A.6** |
| Local quantized model (`qwen/qwen3.8-27b`) | Air-gapped, approved local developer productivity tooling | **ISO 42001 Annex A.9** |
| AST boundary linters & complexity ceilings | Static application security testing (SAST) & architectural control | **NIST SA-11** / **SOC 2 CC7.1** |
| `node scripts/verify-delegation-ledger.cjs` | Automated continuous change-management compliance report | **SOC 2 CC2.1** / **NIST AU-6** |

---

## 5. Technical Failure Modes & Proactive Mitigations

Five critical operational traps were identified during design. Each must be accounted for in code:

### 1. The Pre-Commit Catch-22 (The Staging Lock)
* **Risk:** The pre-commit hook checks `refs/notes/delegations` for staged `tools/` files. But Git notes can only be attached *after* the commit SHA exists. The hook blocks the commit, creating a deadlock.
* **Mitigation:** The atomic harness sets `AI_SDLC_ATOMIC_RUN=1` in its child process environment. The pre-commit hook checks for this flag and defers note validation to the harness's post-commit verification step.

### 2. Transitive Type-Only AST Leaks
* **Risk:** `tools/` modules import shared type definitions (e.g., `import type { Config } from '../src/types'`). AST linters fail the build for cross-tier imports even though types emit zero runtime code.
* **Mitigation:** Enforce total leaf isolation: Tier 1 primitives declare their own interfaces inline. Zero imports means zero runtime and zero type dependencies.

### 3. Negative Fixture Crash False Positives
* **Risk:** A negative fixture has a syntax or import error. The test runner crashes (exit code `1`). The harness mistakes a fatal crash for a successful mutant rejection.
* **Mitigation:** The contract runner parses exit codes and output streams: assertion failures indicate valid discrimination; unhandled exceptions or syntax errors abort the run.

### 4. Git Notes Rebase & Amend Obliteration
* **Risk:** `git rebase` or `git commit --amend` changes commit SHAs, leaving notes stranded on orphaned SHAs.
* **Mitigation:** Configure Git note rewriting in `.gitconfig`:
  ```ini
  [notes]
      rewriteRef = refs/notes/delegations
      rewriteMode = concatenate
  ```
  In CI pipelines, verify notes against tree digests rather than commit SHAs where possible.

### 5. Local Worker Memory Leaks & Latency Spikes
* **Risk:** Stateful multi-turn chat sessions with local LLM runners cause VRAM fragmentation and context exhaustion, causing timeouts during the 3-run loop.
* **Mitigation:** The harness executes each iteration as an isolated, stateless completion call (`stream: false`, fixed `max_tokens: 2048`, temperature `0.0`).

---

## 6. Phased Implementation Roadmap

### Phase 1: Configuration Engine & Tooling Baselines
- [ ] Implement `lib/policy-config.cjs` containing `SENSIBLE_DEFAULTS` and optional repo overrides (`ai-sdlc.config.cjs`).
- [ ] Install dev dependencies: `dependency-cruiser`, `eslint`, `eslint-plugin-import`, `@typescript-eslint/parser`.
- [ ] Add `.dependency-cruiser.cjs` to enforce one-way tier isolation.
- [ ] Add `eslint.config.mjs` with complexity ceilings on Tier 3 paths.
- [ ] Add policy document `docs/compliance/POL-SEC-AISDLC-001.md`.

### Phase 2: The Atomic Harness (`scripts/delegate-unit.cjs`)
- [ ] Implement atomic CLI wrapper:
  1. Target file unlinking.
  2. Local worker dispatch via clean completion API.
  3. Negative mutant verification (`*.negative.ts`).
  4. 3-run deterministic verification loop (`UNIT_PASSED`).
  5. Git commit creation (`AI_SDLC_ATOMIC_RUN=1`).
  6. Schema 1.2 note preparation and human Ed25519 signing prompt.
  7. Ledger verification (`verify-delegation-ledger.cjs`).
- [ ] Register script as `npm run delegate:unit`.

### Phase 3: Git Hooks & CI Pipeline Integration
- [ ] Wire `.git/hooks/pre-commit` to run `npm run gate:arch` and verify path boundaries.
- [ ] Configure Git notes fetch/push in `.git/config` and CI scripts (`refs/notes/delegations`).
- [ ] Add release compiler gate: verify all production dependencies have valid ledger entries prior to bundling.

### Phase 4: End-to-End Validation Run
- [ ] Execute `delegate:unit` on a representative Tier 1 primitive (e.g., an in-memory priority queue or sliding window counter).
- [ ] Deliberately inject an AST import violation in Tier 3 to confirm CI fails closed.
- [ ] Deliberately inline a complex loop in Tier 3 to confirm complexity linter blocks commit.
- [ ] Verify that `node scripts/verify-delegation-ledger.cjs` reports a complete, clean audit chain.

---

## 7. Implementation Status (2026-10-18)

**Phases 1–3 are complete and verified; Phase 4 is partly exercised.** This section records what
actually landed, where it deviates from the plan above, and what remains open. The plan is left as
written rather than ticked, so the deviations stay visible.

### Landed

| Artefact | Commit | Purpose |
| :--- | :--- | :--- |
| `scripts/policy-config.cjs` | `9b947da` | one source of truth for tiers, ceilings, flake count, ledger ref |
| `.dependency-cruiser.cjs` | `9b947da` | Tier 1 leaf rule, Tier 3 fence, package self-containment |
| `eslint.config.mjs` | `9b947da` | complexity 10 / 40 lines on Tier 3, with a file baseline |
| `scripts/delegate-unit.cjs` | `a2e5109` | atomic harness: mutant mirror, dispatch, 3-run gate, commit, prepare |
| `scripts/git-hooks/pre-commit` | `eecf494` | hygiene, architecture, Tier 1 seam (fail closed) |
| `scripts/verify-tree-attestations.cjs` | `1efabc6` | exhaustive coverage of `tools/*.ts` at HEAD |
| `scripts/flake-gate-sweep.cjs` | `74619e8` | 3-run flake evidence across every Tier 1 contract |
| `.github/workflows/release.yml` | tag-triggered | gate + flake sweep at the tag, evidence attached to the release |

### Final state

- Tier 1 primitives: **11**, every one covered by a signed Schema 1.2 note whose recorded SHA-256
  equals the bytes at HEAD. Nine shipped in v0.5.8; `tools/exponential-backoff.ts` was delegated
  through the harness afterwards (`9311c05`), and `src/core/primitives/result.ts` is the eleventh —
  the first primitive outside `tools/`, which required the contract, fixture and coverage gates to
  learn a second directory before it could be governed at all.
- Ledger: **20 notes**, all verified against the pinned operator key (`afea373a`).
- Tier 2: **1** protocol engine, `src/engine/task-state-machine.ts`, with a 9-test loopback suite
  (`npm run test:engine`). Tier 3: **1** route adapter, `src/routes/task-routes.ts`, with 8 tests
  (`npm run test:routes`).
- Gate: **seven stages, eight tools** — hygiene; architecture + lint; contract fixtures; contract
  parity; ledger audit; tree coverage; Schema 1.2 lifecycle. `npm run gate` exits 0.
- Coverage baseline: **none**. Seven primitives had drifted by one newline byte in `9595ccf`; they
  were re-anchored to empty commits on 2026-10-18, and the baseline file and its `--write-baseline`
  flag were deleted rather than retained.
- Flake evidence: **10 contracts x 3 runs = 30**, zero disagreements, in
  `docs/compliance/evidence/flake-gate-sweep.txt` (`npm run gate:flake`).

### Deviations from the plan, and why

1. `lib/policy-config.cjs` → `scripts/policy-config.cjs`. A new top-level `lib/` would sit outside
   every existing guard (hygiene scans `tools/`, `plugin/src/`, `scripts/`; contract parity scans
   `tools/*.ts`).
2. `scripts/delegate-note.cjs` → `scripts/attest-unit.cjs --prepare` / `--approve`. The former never
   existed.
3. `scripts/worker-build.mjs` → `tools/worker-build.mjs`, positional arguments, no model flag.
4. Mutant validation by `TARGET_FILE_OVERRIDE` → a byte-identical contract mirror. The env hook
   required a test-only branch inside the contract, which changes the bytes `contractHash` is
   computed over. `scripts/check-contract-fixtures.cjs` records the measurement.
5. `config.tiers.tier1.flakeIterations` → `config.delegation.flakeIterations`.
6. Contract-derived `@requirements` headers replace per-target `REQUIREMENTS` entries in the
   dispatcher; the table remains as the fallback for pre-convention targets.

### Corrections and closures (recorded after first publication)

- **The coverage gate was not wired into `npm run gate`.** `1efabc6` carried the script and the
  baseline but not the manifest change that invoked them: the editor reported a write it had not
  performed (`ReplaceFileW EIO`), and the retry reported success on an unchanged file. Every
  "9/9 covered" result before `74619e8` came from invoking the script by hand; the push-time CI of
  that period never ran coverage at all. The wiring is now confirmed by the gate's own output and by
  Run 219 on `74619e8`. The lesson is recorded because it is the failure this document exists to
  prevent: a missing expected line in a gate's output is a signal, not noise.
- **The dormant tier paths were not armed.** `futurePaths` was declared per tier and read by no
  rule, so `src/routes/**` would have matched nothing on the day it appeared. `tierPath()` now merges
  `pattern` with `futurePaths` for every dependency rule; the ESLint config merges `futureGlobs` and
  parses TypeScript with `@typescript-eslint/parser`; both lint scopes cruise `.` rather than a fixed
  directory list. Verified with probes, then removed: `src/engine/probe.ts → src/routes/complex.ts`
  reported `no-tier3-behind-the-fence`, and a complexity-11 function in `src/routes/` was rejected.
- **Flake evidence for the seven re-anchored primitives is closed.** `npm run gate:flake` runs all
  nine contracts three times in fresh subprocesses: 27 runs, zero disagreements. The 3-run
  distinction between generated and re-anchored units no longer exists.

### Packaging architecture, and the check it retires

`prepublishOnly` is **retired as a proposal**. The root manifest is `private: true` and is never
published; the published artefact is `plugin/`, which ships `dist/` and no Tier 1 primitive. A
pre-publish check asserting that every bundled primitive has a ledger entry would be true by
construction -- a check that cannot fail. `.github/workflows/release.yml` replaces it: on a
`v*.*.*` tag it runs the structural gate and the 27-run flake sweep at the tagged tree, regenerates
the ledger evidence, checksums both files, and attaches them to the GitHub Release, so a released
tarball can be checked against evidence that names its commit.

### Release smoke test (v0.5.8-rc.1, then torn down)

The release path was exercised on a throwaway annotated tag and removed afterwards, so nothing was
shipped and no release candidate remains.

- **Run 1 — `39184720880`, failed.** The gate died 26 s in, at the ledger audit, with
  `fatal: Not a valid object name main`. A tag checkout is detached and carries
  `refs/remotes/origin/main`, but the audit names `main` literally in
  `git merge-base --is-ancestor <baseCommit> main`. Reproduced in a tag-only clone: the audit fails
  without a local `main` and passes once the ref exists.
- **Fix — `761c789`.** The release job now runs
  `git update-ref refs/heads/main refs/remotes/origin/main` after fetching the ledger. It creates the
  ref the audit names; it changes neither what is checked out nor what is tested.
- **Run 2 — `39184943934`, success**, on `761c789`, 84 s end to end: structural gate, 27-run flake
  sweep, evidence regeneration at the tag, checksums, release created with three assets.
- **Asset integrity.** `ledger-audit-population.txt` (13,204 B) and `flake-gate-sweep.txt` (1,124 B)
  agreed across the published `SHA256SUMS.txt`, the locally recomputed digests, and GitHub's
  server-side asset digests — `2685ffd0…` and `622558bd…` respectively.
- **Teardown.** Release and tag both deleted; `gh release view` reports "release not found" and the
  remote tag list is empty.

### Release v0.5.8 (2026-10-19)

The first real release, published by the workflow the smoke test verified, at `28220d3`.

- **Version parity guard** — a new first step, before any install: the tag must equal both the root
  and the plugin manifest version, or the run stops. It exists because the workflow as first written
  would have published a `v0.5.8` release from a tree whose manifests said `0.5.7`, with
  impeccable-looking evidence naming a version the artefact did not carry.
- **Run `39185487685`, success**, 84 s, 13 steps: guard (1 s), gate, 27-run flake sweep, evidence
  regenerated at the tag, checksums, release published.
- **Assets** agree across three independent sources — the published `SHA256SUMS.txt`, the digests
  recomputed after download, and GitHub's server-side upload digests:
  `ledger-audit-population.txt` `5dfc4da3…` (13,199 B) and `flake-gate-sweep.txt` `bc2fa1d7…`
  (1,124 B).
- **Gate accounting, stated precisely**: seven CLI command stages executing eight tools — hygiene;
  `gate:arch` (dependency-cruiser + ESLint); contract fixtures; contract parity; ledger audit; tree
  coverage; Schema 1.2 lifecycle. A reader counting steps in the log will see seven.

### Release v0.5.9 (2026-10-19)

The first release to ship the attested-tools bundle, its dual-signature verifier and the reproducible
archive.

- **Candidate first.** `v0.5.9-rc.1` at `0c5b07f`, run `39257302701`, success. Its bundle was
  downloaded, extracted and verified offline — 10/10 against both keys — and the three checksum
  sources agreed. The candidate release and tag were then deleted.
- **A defect the candidate exposed.** GitHub published it with `isPrerelease: false`, so a release
  candidate was presented as the latest release. `fda1f70` derives `--prerelease` from a suffixed tag.
- **Production.** `v0.5.9` at `fda1f70`; branch CI `39258408359` green before the tag was cut; release
  run `39258706694` success; four assets, `prerelease: false`, listed as Latest.
- **Verified after publication, not assumed.** The production bundle was downloaded, extracted and
  verified offline — 10/10 from `fda1f70` — with its digest matching both the published
  `SHA256SUMS.txt` and GitHub's server-side digest.

| asset | bytes | sha256 |
| :--- | ---: | :--- |
| `attested-tools-bundle.tar.gz` | 44,742 | `7b540d22e2d132acf06a7b4dd423e7cc3c6a1e3a4e7169d44325d3314ab2ce43` |
| `ledger-audit-population.txt` | 14,160 | `7af227b922c9d24ee495cfbabd437ae35220f3a0dbaf5a0ddf8fea0d426405ec` |
| `flake-gate-sweep.txt` | 1,255 | `9069807dd2d62ae807684da866a986d358fa986e0cd40fbdb2f6b2b2dd367a85` |
| `SHA256SUMS.txt` | 276 | `af153a9b83549de1f401c2e13d6b1d0e7c0680e758446fb39345326216930904` |

The candidate and production archives have different digests, and that is correct: the manifest
records the commit it was generated from, so reproducibility is same-commit, not same-content. Two
exports of one commit are byte-identical; two exports of different commits are not.

### Attested tools bundle (Option C.3, verified on v0.5.8-rc.2)

Consumers that cannot reach the package graph receive the primitives as bytes plus receipts. DSH loads
the plugin as an MCP stdio package that contains no `tools/`; Laya runs air-gapped, where a relative
import into someone else's checkout is a copy, not a dependency. `scripts/export-attested-tools.cjs`
emits the ten sources, their contracts, mutants and signed notes, the pinned operator key, a manifest
of digests, and a zero-dependency `verify-bundle.cjs`.

- **Built from HEAD blobs**, not the working tree, so the artefact cannot carry uncommitted bytes and
  generating it does not dirty the tree it was built from.
- **Coverage by digest**: a primitive with no note recording its exact SHA-256 fails the export.
- **Reproducible**: the manifest timestamps the commit instead of the wall clock, and the archive is
  written with sorted entries, the commit's mtime and no host identity. Two exports of the same commit
  produced the same `.tar.gz` digest, `d8438d45…`.
- **Verified on a real release**: candidate `v0.5.8-rc.2` (run `39188942910`, success) published four
  assets; the downloaded archive verified itself offline, 10/10, against
  `keys/delegation-operator.pub` (fingerprint `afea373a`). The release and tag were then deleted.

**A guard had to change to make that test possible.** The version check compared full strings, so
`v0.5.8-rc.2` against manifests at `0.5.8` failed before any verification ran — no release candidate
could be tagged at all. It now accepts a pre-release suffix of the same base version, proven directly:
accepts `0.5.8` and `0.5.8-rc.2`; rejects `0.5.9`, `0.5`, `0.5.80`.

**Dual-signature verification is now offline.** The verifier carries a port of
`plugin/src/canonical-json.ts` (RFC 8785) and checks the reviewer's own signature over the canonical
payload with `reviewer.signature` removed, plus `reviewer.keyFingerprint` against the bundled
`keys/delegation-reviewer.pub`. All ten bundled notes verify. The fixtures that prove the check is
load-bearing simulate a **compromised operator key**: a reviewer identity altered and the envelope
re-signed with the real operator private key. That fixture passes the envelope check and fails only at
the reviewer signature, which is exactly the separation the second signature exists to provide; a
mutated `keyFingerprint` fails both the fingerprint and the signature check, and the nine untouched
notes still verify.

**Packaging and canonicalisation are now mechanically guarded, not merely documented.** The exporter
refuses to build an archive when `tar --version` is not GNU tar — bsdtar has no `--sort=name` or
`--owner` and would silently produce a different digest for the same tree — and the refusal branch is
unit-tested with a synthetic banner, because the host that builds the bundle always has GNU tar and
the branch this machine never takes is the one that needs a test.
`tests/canonical-json-parity.test.cjs` compares the embedded canonicaliser against
`plugin/src/canonical-json.ts` over a corpus that reaches every branch of the algorithm; the two are
forbidden to drift in OUTPUT, which is the property that matters, since the authority is TypeScript
and the copy is plain JavaScript inside a template literal. Verified by mutating the comparator: the
oracle reports `{"b":1,"a":2}` against the reference's `{"a":2,"b":1}`.

### Tier 3 activated

The first production route file, `src/routes/task-routes.ts`, is the adapter between the Tier 2 task
engine and a caller: 200 on a legal transition, 409 when the lifecycle refuses a well-formed request,
400 for unusable arguments, and no path that turns a caller's mistake into a 500. Eight loopback
tests. The architecture stage cruises 194 modules with zero violations and ESLint passes the live tree
**with no baseline exemption** — the ceilings were not waived for the first real file.

**What the ceiling taught, and the rule it produced.** The first draft of `applyAction` passed every
limit by collapsing five branches into nested ternaries: 13 lines, complexity under 10, and worse than
the switch it replaced. A line-count ceiling rewards compression, which is Goodhart's law in static
analysis. Tier 3 now carries `no-nested-ternary`; the switch that replaced the ladder is the same 13
lines, and the complexity ceiling always allowed it. Two legacy scripts contain the pattern and are
covered by the file baseline — code that predates a rule is grandfathered by name, never by weakening
the rule.

**`gate:flake` no longer writes by default.** Running the sweep in the inner loop used to produce a
two-line diff (a fresh timestamp and commit) in a committed evidence file. It now prints by default
and writes only with `--out`, which the release workflow passes; an ordinary run leaves the tree
clean.

### Transport retry and the vendored leaf (post-v0.5.9)

The plugin's worker call used to be a single `fetch`. A refused connection or a gateway error returned
an error verdict immediately, so a delegation that raced a restarting LM Studio failed for a reason
that would have cleared in half a second. `delegation.ts` now wraps that call in a bounded retry.

**The packaging boundary, and why the leaf is vendored.** `plugin/` installs standalone; a relative
import into `../../tools/` resolves in this checkout and nowhere else, which is exactly what
`tier2-owns-its-package` forbids. The attested leaf is therefore copied to
`plugin/src/vendor/exponential-backoff.ts` — byte-identical, not adapted. The cost of a copy is drift,
and the cost of drift is a retry schedule that no longer matches the implementation whose contract
and attestation cover it.

**The parity oracle is two checks, because they fail for different reasons.**
`tests/exponential-backoff-parity.test.cjs` (`npm run test:parity`) asserts (1) SHA-256 byte identity
between the two files, so the vendor remains a copy rather than an adaptation, and (2) behavioural
equality across six configurations × attempts 0–40 × five seed states, because the two files execute
through different paths — one is loaded by Node's type stripping in the test, the other compiled by
`tsc` into `plugin/dist`. The first catches a deliberate tweak; the second catches a copy that no
longer computes the same numbers.

**The schedule** is three attempts with delays of 500 ms and 1000 ms — base 500, factor 2, ceiling
4000, jitter none — driven by the vendored leaf and bounded inside the caller's existing `timeoutMs`.
A single `AbortController` spans every attempt, so a retry can never outlive the deadline the caller
set. Zero jitter is deliberate: a local endpoint does not need thundering-herd avoidance, and a
deterministic schedule is replayable.

**What is retried, and what is not.**

| class | examples | behaviour |
| :--- | :--- | :--- |
| transport codes | `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT` | retried |
| gateway statuses | 502, 503, 504 | retried |
| **500** | context exhaustion, template parse failure, engine assertion | **fail fast** |
| 4xx | 400, 401, 404, 422 | fail fast |
| `AbortError` | the caller's deadline expired | fail fast |
| unclassified | no transport `code` on the error | fail fast |

**500 is excluded on purpose.** A local inference server emits it for deterministic faults — a prompt
that overflows the context, a template the engine cannot parse, an assertion inside the runtime — and
all three reproduce identically on the next attempt, so a retry adds 1.5 s to a failure that was
already decided. 502/503/504 are gateway-shaped: model swapping, KV-cache reallocation, queue
saturation, a proxy whose socket is not up. Those are the conditions another attempt can actually
change.

**The tool boundary guarantees the contract.** Every `delegateWorker` result returned through
`index.ts` passes through `withTransportTelemetry`, so `transportRetries: number` is present on EVERY
return path — the two workspace refusals, the starved-worker return, the transport-failure return and
the completed verdict alike — defaulting to 0 for a path that never reached the transport.
`lastTransportError` is projected if and only if a terminal socket or network fault occurred, which
makes the key's PRESENCE the unambiguous failure indicator rather than its value.

**No cumulative rollups.** A session-level retry counter was considered and rejected. It would be state
with no anchor: no defined lifetime across turns, restarts or concurrent sessions, and this plugin
already refuses to hold state whose lifecycle it cannot state. The per-call field is the contract;
a host that wants a rollup can accumulate it where it already owns the session lifetime.

The established unreachable-worker message is unchanged for a first-attempt failure and gains an
`(after N attempts)` suffix only when a retry happened, so existing consumers see no new text in the
common case.

### Open

- **Reserved paths not yet realised**: `src/ui/**` and `src/core/protocol/**` match no file. The
  fences and ceilings are armed for them and have been exercised on `src/engine/**`,
  `src/routes/**` and `src/core/primitives/**`, but arming is not evidence for directories nothing
  has been written into.

### Tier 1 unification, and the gap it closed

`src/core/primitives/` was in the policy as Tier 1 but outside three gates: `check-contracts.cjs`
walked `tools/` only, `check-contract-fixtures.cjs` mirrored a fixture into `tools/` only, and
`verify-tree-attestations.cjs` selected its population from the `contractGoverned` pattern, which named
`tools/*.ts`. A primitive written there would have been leaf-fenced and lint-ceilinged and **not
contract-governed, not mutant-tested, and not attested** — the policy would have said Tier 1 while the
gates said otherwise.

All three now read the same pattern, which names both directories:
`^(tools/[^/]+|src/core/primitives/[^/]+)\.ts$`. The fixture runner mirrors the negative mutant into
both layouts, so it never has to parse a contract to learn where its module lives. `result.ts` carries
a contract whose mutant is caught by exactly one case — `unwrapOr` returning the fallback on a success —
which is the discrimination evidence that distinguishes a contract from a smoke test.

The count is **11** and the ledger **20**. The two remaining reserved paths are `src/ui/**` and
`src/core/protocol/**`.