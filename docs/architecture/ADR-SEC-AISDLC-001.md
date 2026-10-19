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

### Final state

- Tier 1 primitives: **9**, every one covered by a signed Schema 1.2 note whose recorded SHA-256
  equals the bytes at HEAD.
- Ledger: **16 notes**, all verified against the pinned operator key (`afea373a`).
- Gate: **seven stages, eight tools** — hygiene; architecture + lint; contract fixtures; contract
  parity; ledger audit; tree coverage; Schema 1.2 lifecycle. `npm run gate` exits 0.
- Coverage baseline: **none**. Seven primitives had drifted by one newline byte in `9595ccf`; they
  were re-anchored to empty commits on 2026-10-18, and the baseline file and its `--write-baseline`
  flag were deleted rather than retained.

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

### Open

- **Release compiler gate (Phase 3, item 3)** is partial: `verify-tree-attestations.cjs` proves
  coverage for Tier 1 primitives, not for every production dependency of a release bundle.
- **Tier 2/3 rule paths** (`src/engine/**`, `src/routes/**`, `src/ui/**`) are declared in
  `policy-config.cjs` and match no file in this repository. They are dormant, not proven.
- **Re-attested units** record a single contract execution (`--prepare`), not the 3-run flake loop
  `delegate-unit.cjs` performs. The distinction is deliberate and recorded in the ledger.