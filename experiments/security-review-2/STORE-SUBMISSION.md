# DSH-Store submission copy

Paste-ready text for the listing issue at
[`AI-Scarlett/DSH-Store/issues/new?template=plugin-submission.yml`](https://github.com/AI-Scarlett/DSH-Store/issues/new?template=plugin-submission.yml).

Every claim below is traceable to a measurement, a test, or a documented limit in this repository. Where
the plugin does **not** do something, the copy says so — the registry's own precheck reads the repository,
so a claim that contradicts the README is worse than no claim.

## Metadata

| Field | Value |
| --- | --- |
| Repository URL | `https://github.com/jjmlovesgit/dsh-plugin-coding-delegate` |
| Branch / Commit | `main` @ `38d42e8b390f2b8e72bb26640ff96333c10ac728` |
| Package name | `dsh-plugin-coding-delegate` |
| Version | `0.2.1` |
| Plugin name (EN) | Coding Delegate Sandbox & Policy Guard |
| Category | `security` |
| DSH compatibility | `0.2.0-rc.2: compatible` |
| Search terms | security, sandbox, local-execution, code-delegation, egress-governance, policy-enforcement |
| Lifecycle scripts | none — no `preinstall`, `install`, `postinstall` or `prepare` |

Verify the commit before submitting; the hash must be the 40-character value above, since the precheck
pins the tree at it:

    git rev-parse HEAD

## Description

Deterministic capability gating and execution containment for DSH delegate workflows.

The plugin mediates tool interaction between a planning model and a local execution worker through
fail-closed policy, rather than through prompting convention.

**Capability denial, not convention.** The metered architect is denied write, modify and shell execution
by policy at `tools/pre-execute` (rules 2 and 5). The denial is enforced by the plugin, not requested from
the model.

**Workspace containment.** Worker output is confined to a declared root. A caller-supplied `workspaceDir`
is trusted only when it is the session root or an allowlisted root; anything else prompts, and is refused
when no approval service is reachable. Declared `targetFiles` bound each unit, and a write outside them is
refused.

**Egress governance, opt-in.** With `sourceReadEgress: 'declarations'`, reads of TypeScript sources are
redirected to the compiled `.d.ts` skeleton, a source file with no skeleton is refused rather than served,
a stale declaration is refused, and search and shell routes that would return raw implementation bodies are
refused. **The default setting serves source** — this is a control an operator turns on deliberately, and
the README states the default plainly.

**Verification with a verdict.** A unit declares the command that judges it, plus the test files that
constitute its contract. Those are hashed before the worker runs, the worker cannot write them, and they
are re-hashed afterwards; a tampered contract voids the run. Repeated verification distinguishes a
consensus pass from `UNIT_FLAKY`.

**Empirical discipline.** 432 oracle test cases, including control cases that exist specifically so a fix
cannot pass by refusing everything. Two published adversarial security reviews — `SECURITY-REVIEW.md` and
`SECURITY-REVIEW-2.md` — the second of which lists its **open, unfixed** findings with the reason each is
not fixed. Measurements that refuted the project's own original claims are retained in the README rather
than deleted.

## Limits, stated rather than implied

These are documented in the repository and are restated here because a listing that omits them would be
making a claim the code does not support.

- **This is not an air gap, and source egress is not absolute.** The outbound request is assembled by DSH
  *after* the plugin's hooks run, so assistant output and tool results are not scanned by the DLP gate,
  which sees the session's accumulated user messages. Closing that requires a host seam that exposes the
  outbound payload.
- **The architect can read source.** Reading is governed, not forbidden. What stays local is the typing,
  measured at 0.08% of the billed token total across 329 delegations.
- **It does not make coding cheaper, more private, or longer.** Those three claims were tested and each
  failed; the measurements are in the README's retired-claims table.
- **The guard is not precise.** It over-refuses in a few shell shapes, failing closed. Documented rather
  than glossed.
- **Scope-free shell searches are not gated.** Reported as finding 6/9 in `SECURITY-REVIEW-2.md` and
  deferred, because `tools/pre-execute` is not told the session workspace.

## What a reviewer should check first

1. `plugin/tests/oracles/` — 432 cases; the red-first oracles are named in `SECURITY-REVIEW-2.md`.
2. `SECURITY-REVIEW-2.md` — the 19 findings of the second review, including the seven still open.
3. `README.md` → *Retired claims* — the project's own disconfirming evidence, kept in public.
4. `plugin/cordis.patch.yml` — the single bundle entry, `local-router`; no official component is replaced.
